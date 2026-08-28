import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { CategoryFilterService } from '../../../core/services/category-filter.service';
import { ApiErrorBody, ApiProduct } from '../../../core/api/api-client';
import { ProductUnit, pluralizeVariantLabel, unitPresentation } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { CategoryFilterComponent } from '../../../shared/components/category-filter/category-filter';

type StockLevel = 'agotado' | 'critico' | 'ok';

/** Clases del semáforo de stock. Una sola fuente para chip y fila. */
export const STOCK_STYLES: Readonly<Record<StockLevel, { chip: string; label: string }>> = {
  agotado: { chip: 'bg-berry/12 text-berry', label: 'Agotado' },
  critico: { chip: 'bg-honey/20 text-clay-deep', label: 'Bajo mínimo' },
  ok: { chip: 'bg-sage-light text-moss-deep', label: 'Disponible' },
};

function levelOf(product: ApiProduct): StockLevel {
  if (product.stock <= 0) {
    return 'agotado';
  }
  return product.stock <= (product.stockSeguridad ?? 0) ? 'critico' : 'ok';
}

@Component({
  selector: 'app-inventory-dashboard',
  imports: [ReactiveFormsModule, RouterLink, CopPipe, CategoryFilterComponent],
  templateUrl: './inventory-dashboard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InventoryDashboard {
  protected readonly adminApi = inject(AdminApiService);
  protected readonly categoryFilter = inject(CategoryFilterService);
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);

  /** Sale de `admin_groups` (migración 0025), no de una constante fija. */
  protected readonly groups = this.adminApi.groupOptions;
  protected readonly stockStyles = STOCK_STYLES;

  protected readonly activeGroup = signal<string>('todos');
  protected readonly query = signal('');

  /**
   * Desplegable de categoría fina — lácteos, mieles… — que solo tiene sentido
   * bajo un grupo que mezcla categorías muy distintas (hoy, "Agroindustriales";
   * mañana, el que sea).
   *
   * Antes esto comparaba el grupo activo contra el literal 'agroindustriales'.
   * Desde que los grupos son filas editables (0025), ese nombre se puede
   * cambiar o borrar, así que la condición mira la casilla
   * `mostrarFiltroFino` del grupo activo — la ficha, no el texto.
   *
   * Reutiliza `categoryFilter.adminFilterValue`: es la misma selección que
   * lee Reportes, para no llevar dos filtros de categoría independientes en
   * pantallas que hablan del mismo inventario.
   */
  protected readonly showFineFilter = computed(
    () => this.adminApi.adminGroupById(this.activeGroup())?.mostrarFiltroFino === 1,
  );

  /**
   * Categorías finas bajo el grupo activo — lácteos, mieles, fermentos…
   *
   * Salen de la tabla `categories` y no de una constante: el grupo lo trae
   * cada fila, así que una categoría creada hoy desde el panel aparece aquí
   * sin que nadie recompile. Se filtra por el grupo ACTIVO, no por un nombre
   * fijo, por la misma razón que `showFineFilter`.
   */
  protected readonly fineOptions = computed(() => {
    const grupoActivo = this.activeGroup();
    return [
      { value: 'todos', label: 'Todas', count: this.categoryFilter.adminCounts()[grupoActivo] ?? 0 },
      ...this.adminApi
        .categories()
        .filter((c) => c.grupoAdmin === grupoActivo)
        .map((c) => ({
          value: c.id,
          label: c.nombre,
          count: this.categoryFilter.adminCounts()[c.id] ?? 0,
        })),
    ];
  });
  /** Cuando está activo, la tabla solo muestra lo que hay que reponer. */
  protected readonly onlyAlerts = signal(false);

  /**
   * Filtro por disponibilidad de la semana. Existe porque el flujo real es una
   * llamada al agricultor: se recorre la lista completa marcando qué hay y qué
   * no, y después conviene repasar solo lo retirado para volver a activarlo.
   */
  protected readonly availability = signal<'todos' | 'ofertados' | 'sin-oferta'>('todos');
  protected readonly availabilityFilters = [
    { value: 'todos', label: 'Todos' },
    { value: 'ofertados', label: 'Se ofrecen' },
    { value: 'sin-oferta', label: 'Sin oferta' },
  ] as const;

  protected readonly togglingId = signal<string | null>(null);
  protected readonly toggleError = signal<string | null>(null);

  /** Producto abierto en el formulario de edición. `null` = ninguno. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly savedId = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    price: [0, [Validators.required, Validators.min(1)]],
    costPrice: [0, [Validators.required, Validators.min(0)]],
    stock: [0, [Validators.required, Validators.min(0)]],
    safetyStock: [0, [Validators.required, Validators.min(0)]],
  });

  constructor() {
    this.adminApi.loadProducts();
    this.adminApi.loadCategories();
    this.adminApi.loadAdminGroups();
  }

  protected readonly rows = computed<readonly ApiProduct[]>(() => {
    const group = this.activeGroup();
    const term = this.query().trim().toLowerCase();
    const onlyAlerts = this.onlyAlerts();
    const availability = this.availability();
    // Solo aplica de verdad cuando el grupo activo es 'agroindustriales':
    // fuera de ese grupo el desplegable ni se muestra, así que un valor
    // residual ('lacteos' de una visita anterior) no debe filtrar "Frutas".
    const fineCategory = this.showFineFilter() ? this.categoryFilter.adminFilterValue() : 'todos';

    return this.adminApi
      .products()
      .filter((product) => {
        const offered = product.activo !== 0;

        if (group !== 'todos' && product.grupoAdmin !== group) {
          return false;
        }
        if (fineCategory !== 'todos' && product.categoriaId !== fineCategory) {
          return false;
        }
        if (availability === 'ofertados' && !offered) {
          return false;
        }
        if (availability === 'sin-oferta' && offered) {
          return false;
        }
        // Lo retirado no "hay que reponerlo": no se está vendiendo. Se excluye
        // aquí igual que en `alertCount`, para que el número del indicador y
        // las filas de la tabla no se contradigan.
        if (onlyAlerts && (!offered || levelOf(product) === 'ok')) {
          return false;
        }
        if (!term) {
          return true;
        }
        return (
          product.nombre.toLowerCase().includes(term) ||
          product.origen.toLowerCase().includes(term)
        );
      })
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });

  protected readonly countsByGroup = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.adminApi.products().length };
    for (const product of this.adminApi.products()) {
      totals[product.grupoAdmin] = (totals[product.grupoAdmin] ?? 0) + 1;
    }
    return totals;
  });

  /**
   * Los indicadores de valor cuentan solo lo que se está ofreciendo.
   *
   * Antes el endpoint no devolvía los productos retirados, así que estos
   * totales siempre midieron "lo vendible". Ahora que sí llegan, excluirlos
   * explícitamente evita que el número cambie de significado sin avisar.
   */
  private readonly offered = computed(() =>
    this.adminApi.products().filter((p) => p.activo !== 0),
  );

  protected readonly offeredCount = computed(() => this.offered().length);

  protected readonly offeredUnits = computed(() =>
    this.offered().reduce((total, p) => total + p.stock, 0),
  );

  protected readonly inventoryValue = computed(() =>
    this.offered().reduce((total, p) => total + p.stock * p.precio, 0),
  );

  protected readonly inventoryCost = computed(() =>
    this.offered().reduce((total, p) => total + p.stock * (p.precioCosto ?? 0), 0),
  );

  protected readonly potentialProfit = computed(() => this.inventoryValue() - this.inventoryCost());

  protected levelOf(product: ApiProduct): StockLevel {
    return levelOf(product);
  }

  // ─────────────────────────────── Variantes ───────────────────────────────

  protected variantsOf(product: ApiProduct): readonly ApiProduct[] {
    return this.adminApi.variantsOf(product.id);
  }

  protected isParent(product: ApiProduct): boolean {
    return this.adminApi.isParent(product.id);
  }

  /** La ficha que agrupa a esta variante, para nombrarla en su fila. */
  protected parentOf(product: ApiProduct): ApiProduct | undefined {
    return product.parentId ? this.adminApi.productById(product.parentId) : undefined;
  }

  /**
   * Lo que de verdad hay de una ficha madre: la suma de sus variantes.
   *
   * Su `stock_actual` es 0 porque no se vende directamente, y enseñar ese cero
   * en la tabla haría pensar que se agotó algo que está lleno en bodega.
   */
  protected variantStock(product: ApiProduct): number {
    return this.variantsOf(product).reduce((total, variante) => total + variante.stock, 0);
  }

  /** «3 presentaciones», «3 sabores», «3 variantes» si nadie puso la palabra. */
  protected variantSummary(product: ApiProduct): string {
    const count = this.variantsOf(product).length;
    const word = product.varianteEtiqueta || 'variante';
    return `${count} ${pluralizeVariantLabel(word, count)}`;
  }

  protected marginOf(product: ApiProduct): number {
    return product.precio - (product.precioCosto ?? 0);
  }

  protected marginPercent(product: ApiProduct): number {
    return product.precio > 0 ? Math.round((this.marginOf(product) / product.precio) * 100) : 0;
  }

  /**
   * "500 gr", "5 unidades", o solo "kg" cuando la cantidad es 1.
   *
   * `unidad` llega como texto libre desde la API, así que `unitPresentation`
   * cae al valor tal cual si no reconoce la unidad.
   */
  protected unitLabel(product: ApiProduct): string {
    return unitPresentation(product.cantidadUnidad ?? 1, product.unidad as ProductUnit);
  }

  /** Porcentaje de la barra de stock respecto al doble del umbral. */
  protected fillPercent(product: ApiProduct): number {
    const ceiling = Math.max((product.stockSeguridad ?? 0) * 2, 1);
    return Math.min(100, Math.round((product.stock / ceiling) * 100));
  }

  protected startEdit(product: ApiProduct): void {
    this.editingId.set(product.id);
    this.savedId.set(null);
    this.saveError.set(null);
    this.form.setValue({
      price: product.precio,
      costPrice: product.precioCosto ?? 0,
      stock: product.stock,
      safetyStock: product.stockSeguridad ?? 0,
    });
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
  }

  protected save(productId: string): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.saveError.set(null);
    this.saving.set(true);
    const { price, costPrice, stock, safetyStock } = this.form.getRawValue();

    this.adminApi
      .updateProduct(productId, { precio: price, precioCosto: costPrice, stock, stockSeguridad: safetyStock })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editingId.set(null);
          this.savedId.set(productId);

          // El aviso de "guardado" se retira solo; no merece un botón de cerrar.
          setTimeout(() => {
            if (this.savedId() === productId) {
              this.savedId.set(null);
            }
          }, 2600);
        },
        error: (error: ApiErrorBody) => {
          this.saving.set(false);
          this.saveError.set(error.message);
        },
      });
  }

  protected showError(field: 'price' | 'costPrice' | 'stock' | 'safetyStock'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  protected setGroup(group: string): void {
    this.activeGroup.set(group);
    this.categoryFilter.setAdminFilterValue('todos');
    this.editingId.set(null);
  }

  protected setFineCategory(value: string): void {
    this.categoryFilter.setAdminFilterValue(value);
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  // ─────────────────────────── Más vendidos ───────────────────────────

  protected readonly featuringId = signal<string | null>(null);

  protected isFeatured(product: ApiProduct): boolean {
    return product.destacado === 1;
  }

  /** Cuántos salen ahora mismo en la portada. */
  protected readonly featuredCount = computed(
    () => this.adminApi.products().filter((p) => p.destacado === 1 && p.activo !== 0).length,
  );

  /**
   * Destaca o retira de la portada.
   *
   * No mira el stock: un producto agotado puede seguir destacado, y la tarjeta
   * ya avisa de que lo está. Destacar es decidir qué se quiere empujar esta
   * semana, no describir la bodega.
   */
  protected toggleFeatured(product: ApiProduct): void {
    this.toggleError.set(null);
    this.featuringId.set(product.id);

    this.adminApi.setFeatured(product.id, !this.isFeatured(product)).subscribe({
      next: () => this.featuringId.set(null),
      error: (error: ApiErrorBody) => {
        this.featuringId.set(null);
        this.toggleError.set(error.message);
      },
    });
  }

  // ────────────────────────── Duplicar un producto ──────────────────────────

  protected readonly duplicatingId = signal<string | null>(null);

  /**
   * Crea una variante y lleva directo a terminarla.
   *
   * La copia nace inactiva y sin stock, así que no sirve de nada hasta que se
   * edite: por eso se navega en vez de dejar al usuario buscarla en la lista.
   * El aviso de que se creó lo da la propia pantalla de edición, que es donde
   * aterriza — un mensaje aquí no llegaría a leerse.
   */
  protected duplicate(product: ApiProduct): void {
    this.toggleError.set(null);
    this.duplicatingId.set(product.id);

    this.adminApi.duplicateProduct(product.id).subscribe({
      next: (copia) => {
        this.duplicatingId.set(null);
        void this.router.navigate(['/admin/inventario/editar', copia.id], {
          queryParams: { copia: 1 },
        });
      },
      error: (error: ApiErrorBody) => {
        this.duplicatingId.set(null);
        this.toggleError.set(error.message);
      },
    });
  }

  protected setAvailabilityFilter(value: 'todos' | 'ofertados' | 'sin-oferta'): void {
    this.availability.set(value);
    this.editingId.set(null);
  }

  protected isOffered(product: ApiProduct): boolean {
    return product.activo !== 0;
  }

  /**
   * Traduce la llamada semanal al agricultor: "esta semana no hay brócoli".
   *
   * En cuanto queda en 0 el producto sale del catálogo público y
   * `POST /api/orders` lo rechaza, así que nadie puede pedir algo que no se
   * podrá despachar el domingo.
   */
  protected toggleAvailability(product: ApiProduct): void {
    this.toggleError.set(null);
    this.togglingId.set(product.id);

    this.adminApi.setAvailability(product.id, !this.isOffered(product)).subscribe({
      next: () => this.togglingId.set(null),
      error: (error: ApiErrorBody) => {
        this.togglingId.set(null);
        this.toggleError.set(error.message);
      },
    });
  }
}
