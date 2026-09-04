import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import {
  ApiAntiguedad,
  ApiMovimientoTesoreria,
  ApiProyeccionCaja,
  ApiTurnoCaja,
  TramoAntiguedad,
} from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';

/**
 * La pestaña de arranque: cómo va la plata hoy.
 *
 * Cuatro bloques, en el orden en que se leen: los indicadores del día, la
 * antigüedad de lo que se debe en los dos sentidos, la proyección del mes, y
 * el estado del cajón con los cobros de la jornada.
 */
@Component({
  selector: 'app-tesoreria-resumen',
  standalone: true,
  imports: [CopPipe],
  templateUrl: './tesoreria-resumen.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaResumen {
  private readonly admin = inject(AdminApiService);

  protected readonly resumen = this.admin.tesoreria;

  protected readonly antiguedad = signal<ApiAntiguedad | null>(null);
  protected readonly proyeccion = signal<ApiProyeccionCaja | null>(null);
  protected readonly turno = signal<ApiTurnoCaja | null>(null);
  protected readonly cobrosDeHoy = signal<readonly ApiMovimientoTesoreria[]>([]);

  /** Los cuatro tramos con su etiqueta, en el orden en que se envejece. */
  protected readonly TRAMOS: readonly { id: TramoAntiguedad; etiqueta: string }[] = [
    { id: 'al_dia', etiqueta: 'Al día' },
    { id: 'd1_7', etiqueta: '1–7 días' },
    { id: 'd8_30', etiqueta: '8–30 días' },
    { id: 'd30_mas', etiqueta: '+30 días' },
  ];

  constructor() {
    this.admin.tesoreriaAntiguedad().subscribe({ next: (d) => this.antiguedad.set(d) });
    this.admin.tesoreriaProyeccion().subscribe({ next: (d) => this.proyeccion.set(d) });
    this.admin.tesoreriaTurno().subscribe({ next: (d) => this.turno.set(d.turno) });

    // Los cobros del día salen del mismo libro que todo lo demás, filtrados en
    // el navegador: son pocos, y pedirle al Worker un endpoint más para una
    // lista que ya viene en Movimientos sería otra consulta que mantener.
    this.admin.tesoreriaMovimientos().subscribe({
      next: (d) => {
        const hoy = this.fechaDeHoy();
        this.cobrosDeHoy.set(
          d.movimientos
            .filter(
              (m) =>
                m.entra > 0 &&
                // Un traslado NO es un cobro: mover plata del cajón al banco no
                // es plata que entró al negocio, es la misma cambiada de
                // bolsillo. Contarla aquí inflaría lo que se cobró en el día.
                m.tipo !== 'traslado_entrada' &&
                (m.fecha ?? '').startsWith(hoy),
            )
            .slice(0, 8),
        );
      },
    });
  }

  /** «Hoy» en hora de Colombia, igual que lo calcula el Worker. */
  private fechaDeHoy(): string {
    const ahora = new Date();
    const bogota = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
    return bogota.toISOString().slice(0, 10);
  }

  protected montoDelTramo(lado: 'porCobrar' | 'porPagar', tramo: TramoAntiguedad): number {
    return this.antiguedad()?.[lado].find((t) => t.tramo === tramo)?.total ?? 0;
  }

  /**
   * El ancho de la barra, en porcentaje del tramo más grande de ese lado.
   *
   * Contra el mayor y no contra el total: si se midiera contra el total, un
   * tramo que se lleva el 90 % dejaría a los otros tres en una raya invisible
   * y no se vería cuál está creciendo, que es justo lo que hay que mirar.
   */
  protected anchoBarra(lado: 'porCobrar' | 'porPagar', tramo: TramoAntiguedad): string {
    const filas = this.antiguedad()?.[lado] ?? [];
    const mayor = Math.max(...filas.map((f) => f.total), 0);
    if (mayor <= 0) return '0%';
    return `${Math.round((this.montoDelTramo(lado, tramo) / mayor) * 100)}%`;
  }

  protected readonly totalPorCobrar = computed(() => this.resumen()?.porCobrar.total ?? 0);
  protected readonly totalPorPagar = computed(() => this.resumen()?.porPagar.total ?? 0);

  /** Solo la hora, que es lo que importa en una lista del mismo día. */
  protected hora(fecha: string): string {
    return (fecha ?? '').slice(11, 16);
  }
}
