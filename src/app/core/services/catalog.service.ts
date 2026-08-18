import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CATEGORIES } from '../data/mock-catalog';
import { Category, CategoryId, Product, SortOption, isInStock } from '../models/product.model';
import { ApiClient, ApiErrorBody, toProduct } from '../api/api-client';
import { TokenStore } from '../api/token-store';
import { topWholesaleRole } from '../models/user.model';

/** Peso de cada etiqueta en el orden "Destacados". */
const BADGE_WEIGHT: Record<string, number> = {
  bestseller: 0,
  nuevo: 1,
  temporada: 2,
  'ultimas-unidades': 3,
};

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private readonly api = inject(ApiClient);
  private readonly tokens = inject(TokenStore);

  readonly categories: readonly Category[] = CATEGORIES;

  /**
   * Catálogo real, leído de `GET /api/products` al arrancar el servicio.
   * Antes esta señal venía de `AdminStoreService` (localStorage); ahora es la
   * misma base de datos que edita el panel — aprobar un pedido o cambiar un
   * precio en Inventario se refleja aquí en la siguiente carga, no por magia
   * de signals compartidas entre pestañas distintas.
   */
  private readonly products = signal<readonly Product[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);

  /**
   * Catálogo completo, sin filtrar. Sirve para búsquedas puntuales —como
   * añadir un producto a un pedido desde el panel de administración— que no
   * deben compartir el `query`/`activeCategory` de la vitrina pública.
   *
   * Es el catálogo público (`GET /api/products`, sin costo ni margen), así
   * que `GESTOR_PEDIDOS` puede usarlo aunque no tenga acceso a
   * `/api/admin/products`: es la misma información que ya ve en el detalle
   * de un pedido a través de `stockDisponible`.
   */
  readonly all = this.products.asReadonly();

  readonly activeCategory = signal<CategoryId | 'todos'>('todos');
  readonly sort = signal<SortOption>('destacados');
  readonly query = signal('');

  /**
   * Nivel de mayorista de la sesión, o `null` para el cliente normal.
   *
   * Lo decide `topWholesaleRole` por pertenencia literal, no `tokens.can()`:
   * `can()` deja pasar a `SUPER_ADMIN` por cualquier rol, que es lo correcto
   * para permisos y sería un error caro aplicado a precios.
   */
  readonly wholesaleTier = computed(() => topWholesaleRole(this.tokens.roles()));

  /** `true` cuando algún producto del catálogo llega con tarifa aplicada. */
  readonly hasWholesalePricing = computed(() =>
    this.products().some((product) => product.listPrice !== undefined),
  );

  constructor() {
    this.load();

    /**
     * Los precios dependen de quién mira, así que un cambio de sesión invalida
     * el catálogo entero. Sin esto, entrar como mayorista dejaría la vitrina
     * con los precios de lista hasta recargar la página a mano —y el checkout
     * cobraría con descuento, mostrando un total distinto al que se vio—.
     *
     * Se compara el id, no el objeto: `TokenStore` rehidrata desde
     * `localStorage` y devolvería una instancia nueva con el mismo usuario.
     */
    let lastUserId = untracked(() => this.tokens.user()?.id ?? null);
    effect(() => {
      const userId = this.tokens.user()?.id ?? null;
      if (userId === lastUserId) {
        return;
      }
      lastUserId = userId;
      untracked(() => this.load());
    });
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);

    this.api.products().subscribe({
      next: (list) => {
        this.products.set(list.map(toProduct));
        this.loading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.loadError.set(error.message);
        this.loading.set(false);
      },
    });
  }

  /**
   * Rejilla visible. Todo el filtrado ocurre en el cliente sobre un `computed`:
   * cambiar de categoría no navega ni recarga, solo recalcula la señal.
   */
  readonly visible = computed<readonly Product[]>(() => {
    const category = this.activeCategory();
    const term = this.query().trim().toLowerCase();

    const filtered = this.products().filter((product) => {
      if (category !== 'todos' && product.categoryId !== category) {
        return false;
      }
      if (!term) {
        return true;
      }
      return (
        product.name.toLowerCase().includes(term) ||
        product.tagline.toLowerCase().includes(term) ||
        product.origin.toLowerCase().includes(term)
      );
    });

    return this.applySort(filtered, this.sort());
  });

  /** Nº de productos por categoría, para el contador de cada chip. */
  readonly counts = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.products().length };
    for (const product of this.products()) {
      totals[product.categoryId] = (totals[product.categoryId] ?? 0) + 1;
    }
    return totals;
  });

  /** Descripción de la categoría activa, usada como subtítulo de la rejilla. */
  readonly activeCategoryMeta = computed<Category>(
    () =>
      this.categories.find((category) => category.id === this.activeCategory()) ??
      this.categories[0],
  );

  readonly hasResults = computed(() => this.visible().length > 0);

  /**
   * Los que se destacan en la portada.
   *
   * No mira el stock a propósito: destacar es una decisión comercial que se
   * toma en el panel, y un producto agotado sigue siendo el que se quiere
   * enseñar primero — la tarjeta ya avisa de que está agotado. Derivar esta
   * lista de las ventas convertiría la sección en un reflejo del pasado en vez
   * de en una decisión.
   */
  readonly featured = computed(() => this.products().filter((product) => product.featured));

  /** Usado por `CartService` para rehidratar el carrito guardado por id. */
  productById(id: string): Product | undefined {
    return this.products().find((product) => product.id === id);
  }

  selectCategory(id: CategoryId | 'todos'): void {
    this.activeCategory.set(id);
  }

  setSort(option: SortOption): void {
    this.sort.set(option);
  }

  setQuery(term: string): void {
    this.query.set(term);
  }

  clearFilters(): void {
    this.activeCategory.set('todos');
    this.query.set('');
    this.sort.set('destacados');
  }

  private applySort(products: Product[], option: SortOption): Product[] {
    // `filter` ya devolvió un array nuevo, así que ordenar en sitio es seguro.
    switch (option) {
      case 'precio-asc':
        return products.sort((a, b) => a.price - b.price);
      case 'precio-desc':
        return products.sort((a, b) => b.price - a.price);
      case 'mejor-valorados':
        return products.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
      case 'destacados':
      default:
        return products.sort((a, b) => {
          const weightA = a.badge ? BADGE_WEIGHT[a.badge] : 90;
          const weightB = b.badge ? BADGE_WEIGHT[b.badge] : 90;
          // Lo agotado siempre cae al final, tenga la etiqueta que tenga.
          const stockA = isInStock(a) ? 0 : 1;
          const stockB = isInStock(b) ? 0 : 1;
          return stockA - stockB || weightA - weightB || b.reviewCount - a.reviewCount;
        });
    }
  }
}
