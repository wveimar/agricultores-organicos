import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../../core/services/admin-api.service';
import { ApiErrorBody, ApiPurchase } from '../../../../core/api/api-client';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';
import { PagoConfirmado, RegistrarPagoModal } from './registrar-pago-modal';

/**
 * Lo que se le debe a las fincas.
 *
 * Sale de las compras en estado 'pendiente': la mercancía ya entró a la bodega
 * pero al agricultor no se le ha girado. Marcar el pago aquí es lo mismo que
 * hacerlo desde Compras —el Worker es el mismo— pero con el saldo de las
 * cuentas a la vista, que es lo que hace falta para decidir si se gira hoy.
 */
@Component({
  selector: 'app-tesoreria-por-pagar',
  standalone: true,
  imports: [CopPipe, RegistrarPagoModal],
  templateUrl: './tesoreria-por-pagar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TesoreriaPorPagar {
  protected readonly admin = inject(AdminApiService);

  protected readonly busqueda = signal('');
  protected readonly pagando = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly hecho = signal<string | null>(null);

  constructor() {
    this.admin.loadPurchases();
  }

  private readonly pendientes = computed(() =>
    // `saldo > 0` además del estado: una compra a la que ya se le giró todo en
    // abonos queda saldada aunque el estado tarde un instante en llegar.
    this.admin.purchases().filter((c) => c.estado === 'pendiente' && c.saldo > 0),
  );

  protected readonly visibles = computed(() => {
    const termino = this.busqueda().trim().toLowerCase();
    if (termino === '') return this.pendientes();
    return this.pendientes().filter((c) => c.origen.toLowerCase().includes(termino));
  });

  /** Lo que FALTA por girar, no lo que costaron: los abonos ya salieron. */
  protected readonly total = computed(() => this.visibles().reduce((s, c) => s + c.saldo, 0));

  /**
   * ¿Alcanza lo que hay en las cuentas para pagar todo lo pendiente?
   *
   * Es la pregunta que de verdad se hace quien va a girar, y por eso va arriba
   * junto al total en vez de obligar a comparar dos cifras de pantallas
   * distintas.
   */
  protected readonly cubiertoPorCaja = computed(() => {
    const disponible = this.admin.tesoreria()?.disponible ?? 0;
    return disponible >= this.total();
  });

  protected readonly faltante = computed(() =>
    Math.max(0, this.total() - (this.admin.tesoreria()?.disponible ?? 0)),
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

  // ── El giro ───────────────────────────────────────────────────────────

  /** La compra sobre la que está abierta la ventana, o `null` si está cerrada. */
  protected readonly pagandoCompra = signal<ApiPurchase | null>(null);
  protected readonly errorModal = signal<string | null>(null);

  private readonly cop = new CopPipe();

  protected abrirPago(compra: ApiPurchase): void {
    this.error.set(null);
    this.hecho.set(null);
    this.errorModal.set(null);
    this.pagandoCompra.set(compra);
  }

  protected cerrarPago(): void {
    this.pagandoCompra.set(null);
    this.errorModal.set(null);
  }

  /**
   * Gira lo que se haya escrito, no necesariamente todo.
   *
   * Antes el botón giraba el total siempre, porque la compra solo sabía estar
   * 'pendiente' o 'pagada'. Con abonos (migración 0036) se le puede dar al
   * agricultor lo que hay hoy y el resto el viernes, que es como se paga de
   * verdad en la plaza.
   */
  protected confirmarPago(pago: PagoConfirmado): void {
    const compra = this.pagandoCompra();
    if (!compra) return;

    this.pagando.set(compra.id);
    this.errorModal.set(null);

    this.admin
      .markPurchasePaid(compra.id, { monto: pago.monto, metodo: pago.metodo })
      .subscribe({
        next: (actualizada) => {
          this.pagando.set(null);
          this.pagandoCompra.set(null);
          this.hecho.set(
            actualizada.saldo <= 0
              ? `${compra.origen} queda al día.`
              : `Abonados ${this.cop.transform(pago.monto)} a ${compra.origen}. Faltan ${this.cop.transform(actualizada.saldo)}.`,
          );
          // El giro sale de una cuenta: los saldos de arriba cambian.
          this.admin.loadTesoreria();
        },
        error: (err: ApiErrorBody) => {
          this.pagando.set(null);
          this.errorModal.set(err.message);
        },
      });
  }
}
