import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiAdminGroup, ApiErrorBody } from '../../../core/api/api-client';
import { CATEGORY_ICONS, CategoryIcon } from '../../../shared/category-icon/category-icon';
import { FieldError, FieldErrorState } from '../../../shared/field-error/field-error';

/**
 * Grupos del panel de compras — "Frutas", "Verduras", "Agroindustriales"...
 *
 * Vivían como tres literales fijos: un CHECK en `products`, otro en
 * `categories` y un tipo de TypeScript en el frontend. Añadir un cuarto grupo,
 * o corregir el nombre de uno, exigía tocar los tres y desplegar. Ahora son
 * filas de `admin_groups`, y esta pantalla las edita — el mismo tratamiento
 * que ya recibieron las categorías en la migración 0013.
 *
 * Tres reglas que la pantalla hace visibles antes de que nadie choque con
 * ellas, y que el Worker vuelve a comprobar por su cuenta:
 *
 * - El **identificador no se cambia**: es la clave por la que apuntan
 *   categorías y productos, y renombrarlo los dejaría huérfanos. Se cambia el
 *   nombre, que es lo que de verdad se lee en el panel.
 * - **No se borra un grupo con categorías o productos dentro**, por lo mismo.
 * - **Desactivar no es borrar**: el grupo deja de ofrecerse en los
 *   desplegables nuevos, pero lo que ya lo tenía asignado sigue intacto.
 */
@Component({
  selector: 'app-admin-groups-manager',
  imports: [ReactiveFormsModule, RouterLink, CategoryIcon, FieldErrorState, FieldError],
  templateUrl: './admin-groups-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminGroupsManager {
  protected readonly adminApi = inject(AdminApiService);
  private readonly fb = inject(FormBuilder);

  /** Fila abierta en el formulario. `null` = ninguna; `'nueva'` = creando. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** Id cuya confirmación de borrado está abierta. */
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly rowError = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);

  /** Las siluetas entre las que se elige. Mismo repertorio que Categorías. */
  protected readonly iconos = CATEGORY_ICONS;

  protected readonly form = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(2)]],
    // "Este grupo mezcla categorías muy distintas, mostrar filtro adicional"
    // en Inventario. Reemplaza la comparación contra el nombre
    // 'agroindustriales' que había antes de esta pantalla.
    mostrarFiltroFino: [false],
    orden: [100, [Validators.required, Validators.min(0)]],
    // Sin validador: la lista del desplegable ya acota lo que se puede
    // elegir, y vacío es un valor legítimo — significa «la de por defecto».
    icono: [''],
  });

  constructor() {
    this.adminApi.loadAdminGroups();
  }

  protected readonly creando = computed(() => this.editingId() === 'nueva');

  /** Cuántas categorías y productos hay en total, para el encabezado. */
  protected readonly totalEnUso = computed(() =>
    this.adminApi
      .adminGroups()
      .reduce((total, g) => total + (g.categorias ?? 0) + (g.productos ?? 0), 0),
  );

  protected readonly sinUsar = computed(
    () =>
      this.adminApi
        .adminGroups()
        .filter((g) => (g.categorias ?? 0) === 0 && (g.productos ?? 0) === 0).length,
  );

  protected startCreate(): void {
    this.editingId.set('nueva');
    this.formError.set(null);
    this.form.reset({
      nombre: '',
      mostrarFiltroFino: false,
      // Al final de la lista: un grupo nuevo no debería colarse delante de
      // los que ya tienen categorías sin que nadie lo pida.
      orden: (this.adminApi.adminGroups().at(-1)?.orden ?? 100) + 10,
      icono: '',
    });
  }

  protected startEdit(grupo: ApiAdminGroup): void {
    this.editingId.set(grupo.id);
    this.formError.set(null);
    this.form.setValue({
      nombre: grupo.nombre,
      icono: grupo.icono ?? '',
      mostrarFiltroFino: grupo.mostrarFiltroFino === 1,
      orden: grupo.orden,
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

    const { nombre, mostrarFiltroFino, orden, icono } = this.form.getRawValue();
    const payload = { nombre: nombre.trim(), mostrarFiltroFino, orden, icono };

    const peticion =
      id === 'nueva'
        ? this.adminApi.createAdminGroup(payload)
        : this.adminApi.updateAdminGroup(id, payload);

    peticion.subscribe({
      next: () => {
        this.saving.set(false);
        this.editingId.set(null);
        // El recuento de categorías/productos lo calcula el listado, no la
        // respuesta: tras crear uno se vuelve a pedir para que la fila nazca
        // sabiendo que está vacía y su botón de borrar funcione a la primera.
        if (id === 'nueva') {
          this.adminApi.loadAdminGroups();
        }
      },
      error: (error: ApiErrorBody) => {
        this.saving.set(false);
        this.formError.set(error.message);
      },
    });
  }

  protected toggleActive(grupo: ApiAdminGroup): void {
    this.rowError.set(null);
    this.busyId.set(grupo.id);

    this.adminApi.updateAdminGroup(grupo.id, { activo: grupo.activo === 1 ? 0 : 1 }).subscribe({
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

    this.adminApi.deleteAdminGroup(id).subscribe({
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

}
