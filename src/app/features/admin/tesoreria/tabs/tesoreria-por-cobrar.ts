import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ApiErrorBody, ApiInvoice } from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';
import { PagoConfirmado, RegistrarPagoModal } from './registrar-pago-modal';

/**
 * Lo que deben los clientes, factura por factura.
 *
 * Es la antigua «Cartera», ahora como pestaña. La lista sale de las facturas
 * con saldo vivo, que es la única fuente de deuda del sistema: un cobro
 * registrado en Cobros baja este saldo solo, sin que nadie tenga que
 * sincronizar dos sitios.
 */
@Component({
  selector: 'app-tesoreria-por-cobrar',
  standalone: true,
  imports: [CopPipe, RegistrarPagoModal],
  templateUrl: './tesoreria-por-cobrar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaPorCobrar {
  protected readonly admin = inject(AdminApiService);

  protected readonly busqueda = signal('');
  protected readonly cobrando = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly hecho = signal<string | null>(null);

  constructor() {
    this.admin.loadInvoices();
  }

  /** Solo lo que de verdad se debe: facturas vivas con saldo. */
  private readonly conSaldo = computed(() =>
    this.admin
      .invoices()
      .filter((f) => f.saldo > 0 && f.estado !== 'anulada' && f.tipo !== 'nota_credito'),
  );

  protected readonly visibles = computed(() => {
    const termino = this.busqueda().trim().toLowerCase();
    if (termino === '') return this.conSaldo();
    return this.conSaldo().filter(
      (f) =>
        f.clienteNombre.toLowerCase().includes(termino) ||
        f.numero.toLowerCase().includes(termino) ||
        (f.clienteTelefono ?? '').includes(termino),
    );
  });

  protected readonly total = computed(() => this.visibles().reduce((s, f) => s + f.saldo, 0));

  protected readonly vencido = computed(() =>
    this.visibles()
      .filter((f) => this.estaVencida(f))
      .reduce((s, f) => s + f.saldo, 0),
  );

  protected readonly clientes = computed(
    () => new Set(this.visibles().map((f) => f.contactId ?? f.clienteNombre)).size,
  );

  /** Vencida es la que tenía plazo y ya pasó. Sin plazo no hay incumplimiento. */
  protected estaVencida(f: ApiInvoice): boolean {
    if (!f.venceEn) return false;
    return new Date(f.venceEn) < new Date();
  }

  /** Cuánto se ha abonado ya: total menos lo que falta. */
  protected abonado(f: ApiInvoice): number {
    return Math.max(0, f.total - f.saldo);
  }

  /**
   * Qué parte de la factura ya está pagada, para la barra.
   *
   * Da la vuelta a la cifra de la derecha a propósito: allí se lee lo que
   * FALTA, y aquí lo que ya entró. Ver la barra llenarse es lo que dice de un
   * vistazo si el cliente viene abonando o no ha pagado nada.
   */
  protected avance(f: ApiInvoice): string {
    if (f.total <= 0) return '0%';
    return `${Math.min(100, Math.round((this.abonado(f) / f.total) * 100))}%`;
  }

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

  // ── El cobro ──────────────────────────────────────────────────────────

  /** La factura sobre la que está abierta la ventana, o `null` si está cerrada. */
  protected readonly cobrandoFactura = signal<ApiInvoice | null>(null);
  protected readonly errorModal = signal<string | null>(null);

  /** Para escribir cifras en los avisos: «$ 4.900», no «4900». */
  private readonly cop = new CopPipe();

  protected abrirCobro(f: ApiInvoice): void {
    if (!f.contactId) {
      this.error.set(
        `La factura ${f.numero} está a nombre de un cliente que no está en la agenda, así que el cobro no sabría a quién abonárselo. Créale la ficha en Contactos y vuelve.`,
      );
      return;
    }

    this.error.set(null);
    this.hecho.set(null);
    this.errorModal.set(null);
    this.cobrandoFactura.set(f);
  }

  protected cerrarCobro(): void {
    this.cobrandoFactura.set(null);
    this.errorModal.set(null);
  }

  /**
   * Registra el cobro sobre ESA factura, por el monto que se haya escrito.
   *
   * El `allocations` explícito es lo importante: sin él, el Worker reparte por
   * antigüedad y el abono podría irse a una factura más vieja del mismo
   * cliente. Aquí se está mirando una factura concreta, así que el abono tiene
   * que caer donde el usuario está mirando.
   */
  protected confirmarCobro(pago: PagoConfirmado): void {
    const f = this.cobrandoFactura();
    if (!f?.contactId) return;

    this.cobrando.set(f.id);
    this.errorModal.set(null);

    this.admin
      .createPayment({
        contactId: f.contactId,
        monto: pago.monto,
        metodo: pago.metodo,
        nota: `Cobro de ${f.numero}`,
        allocations: [{ invoiceId: f.id, monto: pago.monto }],
      })
      .subscribe({
        next: () => {
          this.cobrando.set(null);
          this.cobrandoFactura.set(null);
          this.hecho.set(
            pago.monto >= f.saldo
              ? `${f.numero} queda al día.`
              : `Abonados ${this.cop.transform(pago.monto)} a ${f.numero}. Quedan debiendo ${this.cop.transform(f.saldo - pago.monto)}.`,
          );
          this.admin.loadInvoices();
          this.admin.loadTesoreria();
        },
        error: (err: ApiErrorBody) => {
          this.cobrando.set(null);
          this.errorModal.set(err.message);
        },
      });
  }
}
