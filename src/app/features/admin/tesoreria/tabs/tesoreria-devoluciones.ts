import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ApiDevolucionPendiente, ApiErrorBody } from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';
import { PagoConfirmado, RegistrarPagoModal } from './registrar-pago-modal';

/**
 * Plata que el negocio le quedó debiendo a un cliente, nota crédito por nota
 * crédito (migración 0037).
 *
 * ── De dónde nace esto ──
 *
 * Una nota crédito puede emitirse contra una factura YA PAGADA — es lo que
 * pasa cuando se descubre un error o se acuerda un descuento después de que
 * el cliente pagó entero. Esa nota baja la deuda de la factura, pero la
 * factura ya no debía nada: el saldo se queda en 0 (nunca es negativo) y la
 * plata de más queda sin ningún lugar donde aparecer. Esta pestaña es ese
 * lugar.
 *
 * ── Por qué es una pestaña aparte y no una fila más en «Por cobrar» ──
 *
 * «Por cobrar» es plata que el cliente ME debe. Esto es lo contrario: plata
 * que YO le debo al cliente. Son la misma cartera vista desde los dos lados,
 * y mezclarlas en una lista obligaría a leer con cuidado cada fila para saber
 * de qué lado está la deuda.
 *
 * ── Por qué se lista por NOTA y no por factura ──
 *
 * Una factura puede tener varias notas —como el caso que hizo falta esta
 * pantalla: dos notas sobre la misma factura— y cada una se devuelve por
 * separado. Atar la devolución a la nota (y no a la factura en general) es lo
 * que le da trazabilidad real: «este egreso de $400 es por ESTA nota»,
 * no «esta factura tuvo, alguna vez, alguna devolución».
 */
@Component({
  selector: 'app-tesoreria-devoluciones',
  standalone: true,
  imports: [CopPipe, RegistrarPagoModal],
  templateUrl: './tesoreria-devoluciones.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaDevoluciones {
  protected readonly admin = inject(AdminApiService);

  protected readonly busqueda = signal('');
  protected readonly devolviendo = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly hecho = signal<string | null>(null);
  protected readonly cargando = signal(false);

  private readonly pendientes = signal<readonly ApiDevolucionPendiente[]>([]);

  constructor() {
    this.cargar();
  }

  protected cargar(): void {
    this.cargando.set(true);
    this.admin.tesoreriaDevoluciones().subscribe({
      next: (d) => {
        this.pendientes.set(d.devoluciones);
        this.cargando.set(false);
      },
      error: () => this.cargando.set(false),
    });
  }

  protected readonly visibles = computed(() => {
    const termino = this.busqueda().trim().toLowerCase();
    if (termino === '') return this.pendientes();
    return this.pendientes().filter(
      (n) =>
        n.clienteNombre.toLowerCase().includes(termino) ||
        n.numero.toLowerCase().includes(termino) ||
        n.facturaNumero.toLowerCase().includes(termino),
    );
  });

  /** Lo que falta por devolver: total de la nota menos lo ya devuelto. */
  protected readonly total = computed(() => this.visibles().reduce((s, n) => s + n.saldo, 0));

  protected readonly clientes = computed(
    () => new Set(this.visibles().map((n) => n.contactId ?? n.clienteNombre)).size,
  );

  protected fechaCorta(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso.replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected iniciales(nombre: string): string {
    return (nombre ?? '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('');
  }

  // ── La devolución ────────────────────────────────────────────────────

  /** La nota sobre la que está abierta la ventana, o `null` si está cerrada. */
  protected readonly devolviendoNota = signal<ApiDevolucionPendiente | null>(null);
  protected readonly errorModal = signal<string | null>(null);

  private readonly cop = new CopPipe();

  protected abrirDevolucion(nota: ApiDevolucionPendiente): void {
    this.error.set(null);
    this.hecho.set(null);
    this.errorModal.set(null);
    this.devolviendoNota.set(nota);
  }

  protected cerrarDevolucion(): void {
    this.devolviendoNota.set(null);
    this.errorModal.set(null);
  }

  /**
   * Devuelve lo que se haya escrito, no necesariamente todo — igual que un
   * abono a una finca: hoy lo que hay en caja, el resto después.
   */
  protected confirmarDevolucion(pago: PagoConfirmado): void {
    const nota = this.devolviendoNota();
    if (!nota) return;

    this.devolviendo.set(nota.id);
    this.errorModal.set(null);

    this.admin.registrarDevolucion(nota.id, { monto: pago.monto, metodo: pago.metodo }).subscribe({
      next: (actualizada) => {
        this.devolviendo.set(null);
        this.devolviendoNota.set(null);
        this.hecho.set(
          actualizada.saldo <= 0
            ? `${nota.numero} queda devuelta por completo.`
            : `Devueltos ${this.cop.transform(pago.monto)} de ${nota.numero}. Faltan ${this.cop.transform(actualizada.saldo)}.`,
        );
        this.cargar();
        // La devolución sale de una cuenta: los saldos de arriba cambian.
        this.admin.loadTesoreria();
      },
      error: (err: ApiErrorBody) => {
        this.devolviendo.set(null);
        this.errorModal.set(err.message);
      },
    });
  }
}
