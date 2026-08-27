import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiPayout } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Un cierre con lo que se le debe a sus fincas, ya agrupado para pintar. */
interface GrupoPorCierre {
  readonly closingId: string;
  readonly referencia: string;
  readonly cerradoEn: string;
  readonly pagos: readonly ApiPayout[];
  readonly totalPendiente: number;
  readonly totalPagado: number;
}

/**
 * Cuentas por pagar a las fincas.
 *
 * Lo que se ve aquí no lo teclea nadie: lo escribe el cierre de caja
 * repartiendo el costo ya congelado de cada línea entre los orígenes de sus
 * productos (ver `calcularPagosAFincas()` en el Worker). Esta pantalla solo
 * responde dos preguntas —a quién le debo y cuánto— y deja marcar el giro.
 *
 * Se agrupa por jornada y no en una lista plana porque a una finca se le gira
 * por cierre: dos semanas distintas son dos pagos distintos aunque sea la
 * misma finca, y sumarlos en una fila escondería de cuál viene cada peso.
 */
@Component({
  selector: 'app-provider-payouts',
  imports: [CopPipe],
  templateUrl: './provider-payouts.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderPayouts {
  protected readonly adminApi = inject(AdminApiService);

  /** `true` = solo lo que falta girar. Es la vista por defecto: la accionable. */
  protected readonly soloPendientes = signal(true);
  protected readonly pagandoId = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.recargar();
  }

  protected recargar(): void {
    this.adminApi.loadPayouts({ soloPendientes: this.soloPendientes() });
  }

  protected alternarFiltro(soloPendientes: boolean): void {
    if (this.soloPendientes() === soloPendientes) {
      return;
    }
    this.soloPendientes.set(soloPendientes);
    this.feedback.set(null);
    this.recargar();
  }

  /**
   * Los pagos agrupados por jornada, conservando el orden del servidor (más
   * reciente primero). Se recorre una vez y se agrupa sobre la marcha en vez
   * de ordenar después: la lista ya viene ordenada por `cerrado_en DESC`, y
   * volver a ordenarla aquí sería confiar dos veces en el mismo criterio.
   */
  protected readonly porCierre = computed<readonly GrupoPorCierre[]>(() => {
    const grupos = new Map<string, ApiPayout[]>();

    for (const pago of this.adminApi.payouts()) {
      const grupo = grupos.get(pago.closingId) ?? [];
      grupo.push(pago);
      grupos.set(pago.closingId, grupo);
    }

    return [...grupos.entries()].map(([closingId, pagos]) => ({
      closingId,
      referencia: pagos[0].closingReferencia,
      cerradoEn: pagos[0].closingCerradoEn,
      pagos,
      totalPendiente: pagos
        .filter((p) => p.estado === 'pendiente')
        .reduce((suma, p) => suma + p.montoPago, 0),
      totalPagado: pagos
        .filter((p) => p.estado === 'pagado')
        .reduce((suma, p) => suma + p.montoPago, 0),
    }));
  });

  /** Cuántas fincas distintas esperan giro, para la cabecera. */
  protected readonly fincasPendientes = computed(
    () => this.adminApi.payouts().filter((p) => p.estado === 'pendiente').length,
  );

  /**
   * Marca el giro. Sin confirmación porque no destruye nada ni mueve dinero
   * de verdad: es una anotación de que ya se transfirió. Lo que sí es
   * irreversible —no hay camino de vuelta a 'pendiente'— se dice en pantalla.
   */
  protected pagar(pago: ApiPayout): void {
    this.pagandoId.set(pago.id);
    this.error.set(null);
    this.feedback.set(null);

    this.adminApi.markPayoutPaid(pago.id).subscribe({
      next: () => {
        this.pagandoId.set(null);
        this.feedback.set(`${pago.origen}: giro registrado.`);
        // En la vista de pendientes, el pago recién girado ya no pertenece
        // a la lista. Se recarga para que desaparezca en vez de quedarse
        // como una fila que ya no se puede tocar.
        if (this.soloPendientes()) {
          this.recargar();
        }
      },
      error: (err: ApiErrorBody) => {
        this.pagandoId.set(null);
        this.error.set(err.message);
        // Alguien más pudo haberlo girado primero: refrescar deja la lista
        // diciendo la verdad en vez de un botón que solo va a fallar.
        this.recargar();
      },
    });
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
}
