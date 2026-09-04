import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ApiErrorBody, ExpenseCategory } from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';

/**
 * Los gastos de la jornada, ahora dentro de Tesorería.
 *
 * Dos cosas que conviene tener presentes al mirarlos aquí:
 *
 * · Un gasto baja el saldo de la cuenta de donde sale Y se resta de la
 *   ganancia del cierre. Son dos efectos distintos del mismo hecho.
 * · Se registra aunque deje la cuenta en rojo. No es un descuido: el gasto ya
 *   ocurrió, y negarse a anotarlo no devuelve la plata — solo haría que los
 *   libros mientan. El rojo en la cabecera es la alarma.
 *
 * Solo se listan los de la jornada abierta: los que ya adoptó un cierre están
 * congelados y viven en el informe de esa jornada.
 */
@Component({
  selector: 'app-tesoreria-gastos',
  standalone: true,
  imports: [CopPipe],
  templateUrl: './tesoreria-gastos.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaGastos {
  protected readonly admin = inject(AdminApiService);

  /**
   * Las cuatro categorías que admite la base hoy.
   *
   * La lista está cerrada en el CHECK de `expenses` a propósito: es la columna
   * por la que agrupa el informe, y con texto libre («transporte», «taxi»,
   * «acarreo») no se podría sumar nada.
   */
  protected readonly CATEGORIAS: readonly { id: ExpenseCategory; texto: string }[] = [
    { id: 'transporte', texto: 'Transporte' },
    { id: 'empaque', texto: 'Empaque' },
    { id: 'servicios', texto: 'Servicios' },
    { id: 'otros', texto: 'Otros' },
  ];

  protected readonly filtro = signal<ExpenseCategory | 'todos'>('todos');
  protected readonly abierto = signal(false);
  protected readonly guardando = signal(false);
  protected readonly borrando = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  // El formulario de un gasto nuevo.
  protected readonly descripcion = signal('');
  protected readonly monto = signal(0);
  protected readonly categoria = signal<ExpenseCategory>('transporte');
  protected readonly cuentaId = signal('caja-efectivo');

  constructor() {
    this.admin.loadExpenses();
  }

  protected readonly visibles = computed(() => {
    const f = this.filtro();
    const todos = this.admin.expenses();
    return f === 'todos' ? todos : todos.filter((g) => g.categoria === f);
  });

  protected readonly totalFiltrado = computed(() =>
    this.visibles().reduce((s, g) => s + g.monto, 0),
  );

  /** La categoría que más pesa dentro de lo que se está viendo. */
  protected readonly mayorCategoria = computed(() => {
    const suma = new Map<string, number>();
    for (const g of this.visibles()) {
      suma.set(g.categoria, (suma.get(g.categoria) ?? 0) + g.monto);
    }
    let mayor: { id: string; total: number } | null = null;
    for (const [id, total] of suma) {
      if (!mayor || total > mayor.total) mayor = { id, total };
    }
    return mayor;
  });

  protected etiqueta(id: string): string {
    return this.CATEGORIAS.find((c) => c.id === id)?.texto ?? id;
  }

  protected readonly puedeGuardar = computed(
    () => this.descripcion().trim() !== '' && this.monto() > 0 && !this.guardando(),
  );

  protected abrir(): void {
    this.abierto.set(true);
    this.error.set(null);
  }

  protected cancelar(): void {
    this.abierto.set(false);
    this.descripcion.set('');
    this.monto.set(0);
  }

  protected guardar(): void {
    if (!this.puedeGuardar()) return;

    this.guardando.set(true);
    this.error.set(null);

    this.admin
      .createExpense({
        descripcion: this.descripcion().trim(),
        monto: this.monto(),
        categoria: this.categoria(),
        cuentaId: this.cuentaId(),
      })
      .subscribe({
        next: () => {
          this.guardando.set(false);
          this.cancelar();
          // El gasto salió de una cuenta: los saldos de arriba cambian.
          this.admin.loadTesoreria();
        },
        error: (err: ApiErrorBody) => {
          this.guardando.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected borrar(id: string): void {
    this.borrando.set(id);
    this.error.set(null);

    this.admin.deleteExpense(id).subscribe({
      next: () => {
        this.borrando.set(null);
        this.admin.loadTesoreria();
      },
      error: (err: ApiErrorBody) => {
        this.borrando.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected fechaCorta(iso: string): string {
    const d = new Date((iso ?? '').replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso ?? '';
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected nombreCuenta(id: string | null | undefined): string {
    return this.admin.cuentasTesoreria().find((c) => c.id === id)?.nombre ?? '—';
  }
}
