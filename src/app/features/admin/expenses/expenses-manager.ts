import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiExpense, ExpenseCategory } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Las cuatro del CHECK de la tabla, con su etiqueta y su color. */
const CATEGORIAS: ReadonlyArray<{
  value: ExpenseCategory;
  label: string;
  /** Clases del chip. Tonos de la paleta, no semáforo: ninguna es "mala". */
  chip: string;
}> = [
  { value: 'transporte', label: 'Transporte', chip: 'bg-clay/15 text-clay-deep' },
  { value: 'empaque', label: 'Empaque', chip: 'bg-sage-light text-moss-deep' },
  { value: 'servicios', label: 'Servicios', chip: 'bg-honey/20 text-clay-deep' },
  { value: 'otros', label: 'Otros', chip: 'bg-linen text-ink-soft' },
];

/**
 * Gastos operativos de la jornada abierta.
 *
 * Lo que se registra aquí sale directo de la ganancia del próximo cierre, y
 * por eso la pantalla insiste en dos cosas: cuánto llevamos gastado (arriba,
 * grande) y que después de cerrar ya no se puede tocar. Un gasto olvidado no
 * se puede añadir "con fecha de ayer" — el cierre ya congeló esa cuenta.
 */
@Component({
  selector: 'app-expenses-manager',
  imports: [CopPipe],
  templateUrl: './expenses-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExpensesManager {
  protected readonly adminApi = inject(AdminApiService);
  protected readonly categorias = CATEGORIAS;

  // ── Formulario ──
  //
  // Signals sueltas y no un FormGroup: son tres campos sin validación cruzada
  // ni estados intermedios, y el resto del panel resuelve así los formularios
  // cortos (ver categories-manager). Meter ReactiveForms aquí sería traer
  // maquinaria que nadie más usa.
  protected readonly descripcion = signal('');
  protected readonly monto = signal<number | null>(null);
  protected readonly categoria = signal<ExpenseCategory>('transporte');

  protected readonly guardando = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly borrandoId = signal<string | null>(null);

  constructor() {
    this.adminApi.loadExpenses();
  }

  /** Solo con los dos campos que el servidor exige, y el monto por encima de 0. */
  protected readonly puedeGuardar = computed(
    () => this.descripcion().trim().length > 0 && (this.monto() ?? 0) > 0,
  );

  /** Cuánto se lleva cada categoría, para el desglose de la cabecera. */
  protected readonly porCategoria = computed(() => {
    const totales = new Map<ExpenseCategory, number>();
    for (const gasto of this.adminApi.expenses()) {
      totales.set(gasto.categoria, (totales.get(gasto.categoria) ?? 0) + gasto.monto);
    }
    return CATEGORIAS.map((c) => ({ ...c, total: totales.get(c.value) ?? 0 })).filter(
      (c) => c.total > 0,
    );
  });

  protected chipFor(categoria: ExpenseCategory): string {
    return CATEGORIAS.find((c) => c.value === categoria)?.chip ?? 'bg-linen text-ink-soft';
  }

  protected labelFor(categoria: ExpenseCategory): string {
    return CATEGORIAS.find((c) => c.value === categoria)?.label ?? categoria;
  }

  protected onDescripcion(event: Event): void {
    this.descripcion.set((event.target as HTMLInputElement).value);
  }

  /**
   * El monto entra en pesos enteros. `valueAsNumber` da `NaN` con el campo
   * vacío, que no es 0 — con 0 el botón se habilitaría y el servidor
   * devolvería un 400 que aquí ya se puede evitar.
   */
  protected onMonto(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    this.monto.set(Number.isFinite(value) ? Math.trunc(value) : null);
  }

  protected onCategoria(event: Event): void {
    this.categoria.set((event.target as HTMLSelectElement).value as ExpenseCategory);
  }

  protected guardar(): void {
    if (!this.puedeGuardar() || this.guardando()) {
      return;
    }

    this.guardando.set(true);
    this.formError.set(null);
    this.feedback.set(null);

    this.adminApi
      .createExpense({
        descripcion: this.descripcion().trim(),
        monto: this.monto() ?? 0,
        categoria: this.categoria(),
      })
      .subscribe({
        next: (gasto) => {
          this.guardando.set(false);
          this.feedback.set(`${gasto.descripcion} registrado.`);
          // La categoría se conserva: quien registra tres fletes seguidos no
          // tiene por qué volver a elegir "transporte" cada vez.
          this.descripcion.set('');
          this.monto.set(null);
        },
        error: (error: ApiErrorBody) => {
          this.guardando.set(false);
          this.formError.set(error.message);
        },
      });
  }

  /**
   * Sin confirmación: el gasto todavía no ha entrado en ninguna cuenta y
   * volver a escribirlo cuesta dos campos. Es la misma razón por la que
   * cancelar un pedido sí la pide y esto no.
   */
  protected borrar(gasto: ApiExpense): void {
    this.borrandoId.set(gasto.id);
    this.formError.set(null);

    this.adminApi.deleteExpense(gasto.id).subscribe({
      next: () => {
        this.borrandoId.set(null);
        this.feedback.set(`${gasto.descripcion} eliminado.`);
      },
      error: (error: ApiErrorBody) => {
        this.borrandoId.set(null);
        this.formError.set(error.message);
      },
    });
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
