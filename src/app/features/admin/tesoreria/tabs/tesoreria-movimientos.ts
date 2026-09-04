import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ApiMovimientoTesoreria, TipoMovimiento } from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';

/**
 * El libro: todo lo que movió plata, venga de donde venga.
 *
 * No sale de una tabla propia. El Worker une cobros, gastos, giros a fincas y
 * los movimientos sueltos, y esta pantalla los pinta juntos. Por eso un
 * traslado aparece dos veces —una salida y una entrada—: cada cuenta ve su
 * lado, y sumadas no cambian el total del negocio.
 */
@Component({
  selector: 'app-tesoreria-movimientos',
  standalone: true,
  imports: [CopPipe],
  templateUrl: './tesoreria-movimientos.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaMovimientos {
  protected readonly admin = inject(AdminApiService);

  protected readonly movimientos = signal<readonly ApiMovimientoTesoreria[]>([]);
  protected readonly totales = signal({ entra: 0, sale: 0 });
  protected readonly cargando = signal(false);

  protected readonly busqueda = signal('');
  protected readonly cuenta = signal('');
  protected readonly tipo = signal('');

  /**
   * Cómo se llama y de qué color va cada tipo.
   *
   * El color codifica DIRECCIÓN, no categoría: verde lo que entra, arcilla lo
   * que sale, arena lo que solo cambia de bolsillo. Así la columna de tipos se
   * puede leer de un vistazo sin ir a mirar las cifras de la derecha.
   */
  protected readonly ETIQUETAS: Readonly<Record<TipoMovimiento, { texto: string; clase: string }>> =
    {
      cobro: { texto: 'Cobro', clase: 'bg-sage-light text-moss' },
      ingreso: { texto: 'Ingreso', clase: 'bg-sage-light text-moss' },
      traslado_entrada: { texto: 'Traslado entra', clase: 'bg-cream text-ink/60' },
      traslado_salida: { texto: 'Traslado sale', clase: 'bg-cream text-ink/60' },
      gasto: { texto: 'Gasto', clase: 'bg-clay/12 text-clay' },
      egreso: { texto: 'Egreso', clase: 'bg-clay/12 text-clay' },
      pago_proveedor: { texto: 'Pago a finca', clase: 'bg-honey/20 text-ink' },
      devolucion: { texto: 'Devolución', clase: 'bg-clay/12 text-clay' },
    };

  /** Los tipos que se ofrecen en el filtro, con su nombre legible. */
  protected readonly TIPOS: readonly { id: TipoMovimiento; texto: string }[] = [
    { id: 'cobro', texto: 'Cobros' },
    { id: 'gasto', texto: 'Gastos' },
    { id: 'pago_proveedor', texto: 'Pagos a fincas' },
    { id: 'devolucion', texto: 'Devoluciones' },
    { id: 'ingreso', texto: 'Ingresos' },
    { id: 'egreso', texto: 'Egresos' },
    { id: 'traslado_salida', texto: 'Traslados (salida)' },
    { id: 'traslado_entrada', texto: 'Traslados (entrada)' },
  ];

  constructor() {
    this.cargar();
  }

  /**
   * El filtrado lo hace el Worker, no el navegador.
   *
   * Podría filtrarse aquí sobre lo ya cargado, pero el listado viene topado a
   * 300 filas: filtrar en el navegador buscaría solo dentro de esas 300 y
   * diría «no hay nada» sobre un movimiento que sí existe más atrás.
   */
  protected cargar(): void {
    this.cargando.set(true);
    this.admin
      .tesoreriaMovimientos({
        cuenta: this.cuenta() || undefined,
        tipo: this.tipo() || undefined,
        q: this.busqueda().trim() || undefined,
      })
      .subscribe({
        next: (d) => {
          this.movimientos.set(d.movimientos);
          this.totales.set(d.totales);
          this.cargando.set(false);
        },
        error: () => this.cargando.set(false),
      });
  }

  protected onBusqueda(valor: string): void {
    this.busqueda.set(valor);
  }

  protected onCuenta(valor: string): void {
    this.cuenta.set(valor);
    this.cargar();
  }

  protected onTipo(valor: string): void {
    this.tipo.set(valor);
    this.cargar();
  }

  protected etiqueta(tipo: TipoMovimiento) {
    return this.ETIQUETAS[tipo] ?? { texto: tipo, clase: 'bg-cream text-ink/60' };
  }

  protected readonly cuantos = computed(() => this.movimientos().length);

  /** «2026-09-04 14:03:58» → «4 sep 2026». */
  protected fecha(iso: string): string {
    const d = new Date((iso ?? '').replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso ?? '';
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected hora(iso: string): string {
    return (iso ?? '').slice(11, 16);
  }
}
