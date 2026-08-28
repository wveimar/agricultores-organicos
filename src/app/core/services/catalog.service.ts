import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  AdminGroup,
  Category,
  CategoryId,
  Group,
  Product,
  SortOption,
  isInStock,
} from '../models/product.model';
import { ApiCategory, ApiClient, ApiErrorBody, ApiPublicGroup, toProduct } from '../api/api-client';
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

  /**
   * «Todo el huerto» no es una fila: es el filtro que significa "no filtres".
   * Va delante de lo que traiga la base.
   */
  private static readonly TODOS: Category = {
    id: 'todos',
    name: 'Todo el huerto',
    description: 'Cosechado esta semana por familias campesinas.',
    // El único ícono que sí puede estar en código: este chip tampoco es una
    // fila, así que no hay panel donde elegírselo.
    icon: 'brote',
  };

  /**
   * «Todo» — la solapa que significa "no acotes a ningún grupo".
   *
   * Es la que abre por defecto: la tienda sigue arrancando con el catálogo
   * entero, como siempre, y las solapas acotan desde ahí. Sin ella, entrar a
   * la tienda te dejaría dentro de un grupo elegido por el `orden` de una
   * tabla, sin haber visto nunca todo junto.
   */
  private static readonly TODOS_GRUPO: Group = {
    id: 'todos',
    name: 'Todo',
    icon: 'brote',
  };

  private readonly loadedCategories = signal<readonly Category[]>([]);
  private readonly loadedGroups = signal<readonly Group[]>([]);

  /**
   * Las categorías del catálogo, leídas de `GET /api/categories`.
   *
   * Vivían en una constante de TypeScript; ahora son filas que el panel edita.
   * Mientras llegan solo está «Todo el huerto», que es lo correcto: no se
   * inventa una lista que podría no coincidir con la de la base.
   */
  readonly categories = computed<readonly Category[]>(() => [
    CatalogService.TODOS,
    ...this.loadedCategories(),
  ]);

  /** Las solapas, leídas de `GET /api/groups`. «Todo» siempre va delante. */
  readonly groups = computed<readonly Group[]>(() => [
    CatalogService.TODOS_GRUPO,
    ...this.loadedGroups(),
  ]);

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
  readonly activeGroup = signal<AdminGroup | 'todos'>('todos');
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

  /** Traduce una fila de la tabla a lo que consume la vitrina. */
  private static toCategory(row: ApiCategory): Category {
    return {
      id: row.id,
      name: row.nombre,
      description: row.descripcion,
      // `?? ''` y no `row.icono` a secas: un Worker sin desplegar todavía la
      // 0016 devolvería filas sin el campo, y la vitrina tiene que seguir
      // pintando chips —sin ícono— en vez de quedarse en blanco.
      icon: row.icono ?? '',
      adminGroup: row.grupoAdmin,
    };
  }

  private static toGroup(row: ApiPublicGroup): Group {
    return { id: row.id, name: row.nombre, icon: row.icono ?? '' };
  }

  /**
   * Carga las categorías. Va aparte del catálogo a propósito: si la tabla
   * fallara, la tienda sigue vendiendo con «Todo el huerto» y el buscador — sin
   * chips es peor, pero sin productos no hay tienda.
   */
  private loadCategories(): void {
    this.api.categories().subscribe({
      next: (rows) => this.loadedCategories.set(rows.map(CatalogService.toCategory)),
      error: () => this.loadedCategories.set([]),
    });
  }

  /**
   * Carga las solapas. Aparte por lo mismo que las categorías, y con una razón
   * más: un Worker sin desplegar todavía `/api/groups` responde 404, y ahí lo
   * correcto es quedarse sin solapas y seguir vendiendo — no romper la vitrina.
   * Con la lista vacía solo queda «Todo», que es exactamente la tienda de antes.
   */
  private loadGroups(): void {
    this.api.groups().subscribe({
      next: (rows) => this.loadedGroups.set(rows.map(CatalogService.toGroup)),
      error: () => this.loadedGroups.set([]),
    });
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.loadCategories();
    this.loadGroups();

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
   * Variantes agrupadas por el id de su madre.
   *
   * Se arma una vez por carga del catálogo en vez de recorrer la lista entera
   * cada vez que una tarjeta pregunta por las suyas: con 40 productos en
   * pantalla eso serían 40 recorridos por repintado.
   *
   * Se ordenan por precio y, a igualdad, por nombre. Así la miel sale 300 →
   * 500 → 1000 (el orden en que se piensa un tamaño) y los sabores de la
   * kambucha, que valen lo mismo, salen alfabéticos y estables.
   */
  private readonly variantsByParent = computed<ReadonlyMap<string, readonly Product[]>>(() => {
    const groups = new Map<string, Product[]>();

    for (const product of this.products()) {
      if (!product.parentId) {
        continue;
      }
      const siblings = groups.get(product.parentId);
      if (siblings) {
        siblings.push(product);
      } else {
        groups.set(product.parentId, [product]);
      }
    }

    for (const siblings of groups.values()) {
      siblings.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name, 'es'));
    }

    return groups;
  });

  /**
   * Las variantes de un producto, o `[]` si no tiene ninguna.
   *
   * Salen del catálogo que ya está en memoria: no hay una petición por tarjeta
   * abierta. `GET /api/products` devuelve madres e hijas de una vez, y con los
   * precios de mayorista de cada hija ya aplicados por el servidor.
   */
  getProductVariants(parentId: string): readonly Product[] {
    return this.variantsByParent().get(parentId) ?? [];
  }

  hasVariants(parentId: string): boolean {
    return this.variantsByParent().has(parentId);
  }

  /**
   * Lo que merece tarjeta propia: todo menos las variantes.
   *
   * Una hija huérfana —su madre está desactivada, o se borró y la FK dejó el
   * vínculo en NULL— sí aparece. Es preferible que se vea suelta a que
   * desaparezca del catálogo sin que nadie note que dejó de venderse.
   */
  private readonly topLevel = computed<readonly Product[]>(() => {
    const madres = new Set(
      this.products().filter((product) => !product.parentId).map((product) => product.id),
    );
    return this.products().filter(
      (product) => !product.parentId || !madres.has(product.parentId),
    );
  });

  /**
   * A qué grupo pertenece cada categoría.
   *
   * Es **la** tabla de la que cuelga toda la navegación de la vitrina. Se
   * arma una vez por carga en lugar de recorrer las categorías en cada
   * producto filtrado: con 40 tarjetas eso serían 40 búsquedas lineales por
   * repintado.
   */
  private readonly groupByCategory = computed<ReadonlyMap<CategoryId, AdminGroup>>(() => {
    const map = new Map<CategoryId, AdminGroup>();
    for (const category of this.loadedCategories()) {
      if (category.adminGroup) {
        map.set(category.id, category.adminGroup);
      }
    }
    return map;
  });

  /**
   * Rejilla visible. Todo el filtrado ocurre en el cliente sobre un `computed`:
   * cambiar de solapa o de chip no navega ni recarga, solo recalcula la señal.
   */
  readonly visible = computed<readonly Product[]>(() => {
    const category = this.activeCategory();
    const group = this.activeGroup();
    const grupoDe = this.groupByCategory();
    const term = this.query().trim().toLowerCase();

    const filtered = this.topLevel().filter((product) => {
      // La solapa acota por el grupo de la CATEGORÍA del producto, nunca por
      // `product.adminGroup`: ver la nota de `Group` en product.model.ts.
      if (group !== 'todos' && grupoDe.get(product.categoryId) !== group) {
        return false;
      }
      if (category !== 'todos' && product.categoryId !== category) {
        return false;
      }
      if (!term) {
        return true;
      }
      // Una madre también responde por sus variantes: buscar "mango" tiene que
      // encontrar la Kambucha, aunque esa palabra solo esté en una de sus
      // botellas y la botella no tenga tarjeta propia.
      return (
        this.matches(product, term) ||
        this.getProductVariants(product.id).some((variant) => this.matches(variant, term))
      );
    });

    return this.applySort(filtered, this.sort());
  });

  private matches(product: Product, term: string): boolean {
    return (
      product.name.toLowerCase().includes(term) ||
      product.tagline.toLowerCase().includes(term) ||
      product.origin.toLowerCase().includes(term)
    );
  }

  /**
   * Nº de productos por categoría, para el contador de cada chip.
   *
   * Cuenta tarjetas, no filas: las tres presentaciones de la miel son un solo
   * producto en la vitrina, y un chip que dijera "4" para luego enseñar una
   * tarjeta estaría mintiendo.
   */
  readonly counts = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.topLevel().length };
    for (const product of this.topLevel()) {
      totals[product.categoryId] = (totals[product.categoryId] ?? 0) + 1;
    }
    return totals;
  });

  /**
   * Los chips que se pintan: «Todo el huerto» y las categorías que tienen algo.
   *
   * Una categoría vacía es un pasillo sin nada — se anuncia, se pulsa y no hay
   * qué ver. Filtrarlas aquí también permite declarar una sección antes de
   * tener el producto: «Panadería» ya existe en el código y aparece sola el día
   * que se cree el primer pan en el panel, sin tocar nada.
   *
   * La activa se conserva aunque se quede en cero: que el chip donde estás
   * parado desaparezca bajo el dedo es peor que un contador en 0.
   */
  readonly visibleCategories = computed<readonly Category[]>(() => {
    // Mientras llega el catálogo no hay contadores, y filtrar por ellos dejaría
    // la barra con un solo chip para estallar a nueve medio segundo después.
    // Se pintan todas y se recorta una vez, cuando ya se sabe qué hay.
    if (this.loading()) {
      return this.categories();
    }

    const counts = this.counts();
    const active = this.activeCategory();
    const group = this.activeGroup();

    return this.categories().filter((category) => {
      if (category.id === 'todos') {
        return true;
      }
      // Los chips son el segundo nivel: dentro de una solapa solo se ven las
      // categorías de ese grupo.
      if (group !== 'todos' && category.adminGroup !== group) {
        return false;
      }
      return category.id === active || (counts[category.id] ?? 0) > 0;
    });
  });

  /**
   * Nº de productos por grupo, contando por la categoría de cada uno.
   *
   * Es lo que decide qué solapas se pintan, así que tiene que contar lo mismo
   * que luego enseña la rejilla: tarjetas de `topLevel`, no filas.
   */
  readonly groupCounts = computed<Record<string, number>>(() => {
    const grupoDe = this.groupByCategory();
    const totals: Record<string, number> = { todos: this.topLevel().length };

    for (const product of this.topLevel()) {
      const grupo = grupoDe.get(product.categoryId);
      if (grupo) {
        totals[grupo] = (totals[grupo] ?? 0) + 1;
      }
    }

    return totals;
  });

  /**
   * Las solapas que se pintan: «Todo» y los grupos que tienen algo dentro.
   *
   * Un grupo vacío es una solapa que se abre para no enseñar nada. Hoy tres de
   * los cinco están así —«Frutas», «Verduras» y «Lácteos y Fermentados» no
   * tienen ninguna categoría colgando—, y esconderlos es lo que evita que el
   * cliente los encuentre. Aparecen solas el día que alguien les cuelgue una
   * categoría con producto, sin tocar código.
   *
   * La activa se conserva aunque se quede en cero, por lo mismo que en los
   * chips: que la solapa donde estás parado desaparezca bajo el dedo es peor
   * que una rejilla vacía.
   */
  readonly visibleGroups = computed<readonly Group[]>(() => {
    if (this.loading()) {
      return this.groups();
    }

    const counts = this.groupCounts();
    const active = this.activeGroup();

    return this.groups().filter(
      (group) =>
        group.id === 'todos' || group.id === active || (counts[group.id] ?? 0) > 0,
    );
  });

  /**
   * Encabezado de la rejilla: qué se está mirando ahora mismo.
   *
   * Manda el chip cuando hay uno puesto, porque es el filtro más fino. Si solo
   * hay una solapa abierta, titula el grupo — sin esto, abrir «Legumbrería»
   * dejaba la rejilla encabezada por «Todo el huerto» mientras enseñaba 21 de
   * 42 productos, que es decirle al cliente que está viendo todo cuando no.
   *
   * El grupo no tiene descripción propia (`admin_groups` no guarda ninguna:
   * nació como agrupación interna del panel), así que se conserva la de «Todo
   * el huerto», que habla de la tienda entera y encaja bajo cualquier grupo.
   */
  readonly activeCategoryMeta = computed<Category>(() => {
    const category = this.activeCategory();

    if (category !== 'todos') {
      return (
        this.categories().find((item) => item.id === category) ?? CatalogService.TODOS
      );
    }

    const group = this.activeGroup();
    if (group === 'todos') {
      return CatalogService.TODOS;
    }

    const abierto = this.groups().find((item) => item.id === group);
    return abierto
      ? { ...CatalogService.TODOS, id: 'todos', name: abierto.name, icon: abierto.icon }
      : CatalogService.TODOS;
  });

  readonly hasResults = computed(() => this.visible().length > 0);

  /** `true` cuando una solapa, un chip o una búsqueda están acotando la vitrina. */
  readonly isFiltering = computed(
    () =>
      this.activeCategory() !== 'todos' ||
      this.activeGroup() !== 'todos' ||
      this.query().trim().length > 0,
  );

  /**
   * Los que se destacan en la portada.
   *
   * No mira el stock a propósito: destacar es una decisión comercial que se
   * toma en el panel, y un producto agotado sigue siendo el que se quiere
   * enseñar primero — la tarjeta ya avisa de que está agotado. Derivar esta
   * lista de las ventas convertiría la sección en un reflejo del pasado en vez
   * de en una decisión.
   *
   * Sale de `topLevel`, así que destacar una variante suelta no la saca a la
   * portada: se destaca la ficha de la miel, no el tarro de 500 gr.
   */
  readonly featured = computed(() => this.topLevel().filter((product) => product.featured));

  /** Usado por `CartService` para rehidratar el carrito guardado por id. */
  productById(id: string): Product | undefined {
    return this.products().find((product) => product.id === id);
  }

  selectCategory(id: CategoryId | 'todos'): void {
    this.activeCategory.set(id);
  }

  /**
   * Abre una solapa.
   *
   * Suelta el chip a propósito: la categoría activa pertenece al grupo que se
   * acaba de abandonar, así que dejarla puesta daría una rejilla vacía y —peor—
   * un chip marcado que ya ni siquiera está en la fila.
   */
  selectGroup(id: AdminGroup | 'todos'): void {
    this.activeGroup.set(id);
    this.activeCategory.set('todos');
  }

  setSort(option: SortOption): void {
    this.sort.set(option);
  }

  setQuery(term: string): void {
    this.query.set(term);
  }

  clearFilters(): void {
    this.activeCategory.set('todos');
    this.activeGroup.set('todos');
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
