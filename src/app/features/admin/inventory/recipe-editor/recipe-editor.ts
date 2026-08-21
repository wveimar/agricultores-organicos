import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ApiClient, ApiComponent, ApiErrorBody, ApiProduct, ApiRecipe } from '../../../../core/api/api-client';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ProductUnit, unitPresentation } from '../../../../core/models/product.model';

/**
 * Convierte un producto en canasta: le dice qué lleva dentro y cuánto.
 *
 * ── Lo que hay que entender antes de tocarlo ──
 *
 * Una canasta **no tiene inventario propio**. Su `stock` deja de ser un número
 * que se escribe y pasa a calcularse: cuántas se pueden armar con lo que hay
 * de sus componentes, mandando siempre el que primero se agote. Por eso el
 * editor enseña ese cálculo en grande y señala cuál es el que frena — es el
 * único dato accionable: reponer cualquier otro no añade ni una canasta.
 *
 * Vender una descuenta sus componentes, no a ella. Cancelar los devuelve.
 */
@Component({
  selector: 'app-recipe-editor',
  templateUrl: './recipe-editor.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecipeEditor {
  private readonly api = inject(ApiClient);
  private readonly adminApi = inject(AdminApiService);

  /** Producto que se está editando. */
  readonly productId = input.required<string>();

  protected readonly recipe = signal<ApiRecipe | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busyChild = signal<string | null>(null);

  /** Formulario de alta: qué producto se añade y cuántos entran. */
  protected readonly nuevoChildId = signal('');
  protected readonly nuevaCantidad = signal(1);
  protected readonly adding = signal(false);

  constructor() {
    if (this.adminApi.products().length === 0) {
      this.adminApi.loadProducts();
    }
    queueMicrotask(() => this.load());
  }

  private load(): void {
    this.loading.set(true);
    this.api.productComponents(this.productId()).subscribe({
      next: (recipe) => {
        this.recipe.set(recipe);
        this.loading.set(false);
      },
      error: (err: ApiErrorBody) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected readonly componentes = computed(() => this.recipe()?.componentes ?? []);
  protected readonly esCanasta = computed(() => this.componentes().length > 0);
  protected readonly armables = computed(() => this.recipe()?.armables ?? null);

  /**
   * Cuántas canastas deja armar cada componente por separado. El menor de
   * todos es el stock de la canasta; los demás sobran.
   */
  private rinde(componente: ApiComponent): number {
    return componente.activo === 1
      ? Math.floor(componente.stock / componente.cantidadRequerida)
      : 0;
  }

  /**
   * El componente que frena. Es el único que hay que reponer: subirle el stock
   * a cualquier otro no añade ni una canasta más.
   */
  protected readonly cuelloDeBotella = computed(() => {
    const lista = this.componentes();
    if (lista.length === 0) {
      return null;
    }
    return lista.reduce((peor, actual) => (this.rinde(actual) < this.rinde(peor) ? actual : peor));
  });

  protected esCuelloDeBotella(componente: ApiComponent): boolean {
    return this.cuelloDeBotella()?.childId === componente.childId;
  }

  protected rindeTexto(componente: ApiComponent): string {
    return componente.activo === 1 ? `da para ${this.rinde(componente)}` : 'desactivado';
  }

  /** Presentación del componente suelto: «500 gr», «unidad». */
  protected presentacion(componente: ApiComponent): string {
    return unitPresentation(componente.cantidadUnidad, componente.unidad as ProductUnit);
  }

  /**
   * Qué se puede meter dentro: productos simples y activos.
   *
   * Fuera quedan la propia canasta, lo que ya está en la receta, las madres de
   * variantes —su stock es 0 por definición, la canasta nunca se armaría— y
   * otras canastas, que el servidor rechaza de todas formas.
   */
  protected readonly candidatos = computed(() => {
    const yaEstan = new Set(this.componentes().map((c) => c.childId));
    const propio = this.productId();
    const todos = this.adminApi.products();
    const madres = new Set(todos.filter((p) => p.parentId).map((p) => p.parentId!));

    return todos
      .filter(
        (p) =>
          p.id !== propio &&
          !yaEstan.has(p.id) &&
          !madres.has(p.id) &&
          (p as ApiProduct & { activo?: number }).activo !== 0,
      )
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });

  protected onChildChange(event: Event): void {
    this.nuevoChildId.set((event.target as HTMLSelectElement).value);
  }

  protected onCantidadChange(event: Event): void {
    this.nuevaCantidad.set(Number((event.target as HTMLInputElement).value) || 1);
  }

  protected add(): void {
    const childId = this.nuevoChildId();
    if (!childId) {
      return;
    }

    this.adding.set(true);
    this.error.set(null);

    this.api.setProductComponent(this.productId(), childId, this.nuevaCantidad()).subscribe({
      next: (recipe) => {
        this.recipe.set(recipe);
        this.adding.set(false);
        this.nuevoChildId.set('');
        this.nuevaCantidad.set(1);
        // El stock de la canasta acaba de cambiar de significado: se recarga el
        // inventario para que la tabla de atrás no siga mostrando el viejo.
        this.adminApi.loadProducts();
      },
      error: (err: ApiErrorBody) => {
        this.adding.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected updateCantidad(componente: ApiComponent, raw: string): void {
    const cantidad = Number(raw);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad === componente.cantidadRequerida) {
      return;
    }

    this.busyChild.set(componente.childId);
    this.error.set(null);

    this.api.setProductComponent(this.productId(), componente.childId, cantidad).subscribe({
      next: (recipe) => {
        this.recipe.set(recipe);
        this.busyChild.set(null);
        this.adminApi.loadProducts();
      },
      error: (err: ApiErrorBody) => {
        this.busyChild.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected remove(componente: ApiComponent): void {
    this.busyChild.set(componente.childId);
    this.error.set(null);

    this.api.removeProductComponent(this.productId(), componente.childId).subscribe({
      next: (recipe) => {
        this.recipe.set(recipe);
        this.busyChild.set(null);
        this.adminApi.loadProducts();
      },
      error: (err: ApiErrorBody) => {
        this.busyChild.set(null);
        this.error.set(err.message);
      },
    });
  }
}
