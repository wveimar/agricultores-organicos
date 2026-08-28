import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiCategory, ApiErrorBody } from '../../../core/api/api-client';
import { CATEGORY_ICONS, CategoryIcon } from '../../../shared/category-icon/category-icon';

/**
 * Categorías del catálogo: los chips de la vitrina y el desplegable con el que
 * se archiva cada producto.
 *
 * Vivían en tres constantes de TypeScript y añadir una obligaba a tocar las
 * tres y volver a desplegar. Ahora son filas de la tabla `categories`, y esta
 * pantalla es la que las edita.
 *
 * Tres reglas que la pantalla hace visibles antes de que nadie choque con
 * ellas, y que el Worker vuelve a comprobar por su cuenta:
 *
 * - El **identificador no se cambia**: es la clave por la que apuntan los
 *   productos, y renombrarlo los dejaría huérfanos. Se cambia el nombre, que
 *   es lo que de verdad se lee en la tienda.
 * - **No se borra una categoría con productos dentro**, por lo mismo.
 * - **Desactivar no es borrar**: la categoría deja de ofrecerse y su chip
 *   desaparece, pero sus productos siguen ahí y se recupera con un clic.
 */
@Component({
  selector: 'app-categories-manager',
  imports: [ReactiveFormsModule, RouterLink, NgTemplateOutlet, CategoryIcon],
  templateUrl: './categories-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoriesManager {
  protected readonly adminApi = inject(AdminApiService);
  private readonly fb = inject(FormBuilder);

  /**
   * Los grupos que se pueden elegir en el formulario. Sale de la tabla
   * `admin_groups` (migración 0025), sin el pseudo-valor 'todos' que sí lleva
   * `groupOptions()` para los filtros de otras pantallas — aquí hay que
   * elegir uno de verdad, no "todos a la vez".
   */
  protected readonly grupos = computed(() =>
    this.adminApi.groupOptions().filter((g) => g.value !== 'todos'),
  );

  /** Las siluetas entre las que se elige. El repertorio vive en `CategoryIcon`. */
  protected readonly iconos = CATEGORY_ICONS;

  /** Fila abierta en el formulario. `null` = ninguna; `'nueva'` = creando. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** Id cuya confirmación de borrado está abierta. */
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly rowError = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(2)]],
    descripcion: [''],
    // Sin validador: la lista del desplegable ya acota lo que se puede elegir,
    // y vacío es un valor legítimo — significa «la de por defecto».
    icono: [''],
    grupoAdmin: ['agroindustriales'],
    orden: [100, [Validators.required, Validators.min(0)]],
  });

  constructor() {
    this.adminApi.loadCategories();
    this.adminApi.loadAdminGroups();
  }

  protected readonly creando = computed(() => this.editingId() === 'nueva');

  /** Cuántos productos hay en total, para el encabezado. */
  protected readonly totalProductos = computed(() =>
    this.adminApi.categories().reduce((total, c) => total + (c.productos ?? 0), 0),
  );

  protected readonly sinUsar = computed(() =>
    this.adminApi.categories().filter((c) => (c.productos ?? 0) === 0).length,
  );

  protected startCreate(): void {
    this.editingId.set('nueva');
    this.formError.set(null);
    this.form.reset({
      nombre: '',
      descripcion: '',
      icono: '',
      grupoAdmin: 'agroindustriales',
      // Al final de la lista: una categoría nueva no debería colarse delante
      // de las que ya tienen producto sin que nadie lo pida.
      orden: (this.adminApi.categories().at(-1)?.orden ?? 100) + 10,
    });
  }

  protected startEdit(category: ApiCategory): void {
    this.editingId.set(category.id);
    this.formError.set(null);
    this.form.setValue({
      nombre: category.nombre,
      descripcion: category.descripcion,
      // `?? ''` por si la fila viene de un Worker sin la 0016 desplegada.
      icono: category.icono ?? '',
      grupoAdmin: category.grupoAdmin,
      orden: category.orden,
    });
  }

  protected cancel(): void {
    this.editingId.set(null);
    this.formError.set(null);
  }

  protected save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const id = this.editingId();
    if (!id) {
      return;
    }

    this.saving.set(true);
    this.formError.set(null);

    const { nombre, descripcion, icono, grupoAdmin, orden } = this.form.getRawValue();
    const payload = {
      nombre: nombre.trim(),
      descripcion: descripcion.trim(),
      icono,
      grupoAdmin,
      orden,
    };

    const peticion =
      id === 'nueva'
        ? this.adminApi.createCategory(payload)
        : this.adminApi.updateCategory(id, payload);

    peticion.subscribe({
      next: () => {
        this.saving.set(false);
        this.editingId.set(null);
        // El recuento de productos lo calcula el listado, no la respuesta:
        // tras crear una se vuelve a pedir para que la fila nazca sabiendo
        // que está vacía y su botón de borrar funcione a la primera.
        if (id === 'nueva') {
          this.adminApi.loadCategories();
        }
      },
      error: (error: ApiErrorBody) => {
        this.saving.set(false);
        this.formError.set(error.message);
      },
    });
  }

  protected toggleActive(category: ApiCategory): void {
    this.rowError.set(null);
    this.busyId.set(category.id);

    this.adminApi.updateCategory(category.id, { activo: category.activo === 1 ? 0 : 1 }).subscribe({
      next: () => this.busyId.set(null),
      error: (error: ApiErrorBody) => {
        this.busyId.set(null);
        this.rowError.set(error.message);
      },
    });
  }

  protected askDelete(id: string): void {
    this.rowError.set(null);
    this.confirmingId.set(id);
  }

  protected cancelDelete(): void {
    this.confirmingId.set(null);
  }

  protected confirmDelete(id: string): void {
    this.rowError.set(null);
    this.busyId.set(id);

    this.adminApi.deleteCategory(id).subscribe({
      next: () => {
        this.busyId.set(null);
        this.confirmingId.set(null);
      },
      error: (error: ApiErrorBody) => {
        this.busyId.set(null);
        this.confirmingId.set(null);
        this.rowError.set(error.message);
      },
    });
  }

  protected showError(field: 'nombre' | 'orden'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  protected grupoLabel(value: string): string {
    return this.grupos().find((g) => g.value === value)?.label ?? value;
  }
}
