import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiDelivery, ApiErrorBody } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/**
 * Lo que ve el domiciliario en la calle: pedidos 'enviado' que todavía tiene
 * pendientes.
 *
 * No todos traen cobro: uno contra entrega necesita `markOrderPaid` (con
 * modal, porque involucra plata); cualquier otro método solo necesita
 * `confirmDelivery` (sin modal — no hay nada que verificar más que la puerta).
 * `isCashOnDelivery()` decide cuál de las dos ofrecer.
 *
 * Pantalla deliberadamente distinta del panel de escritorio (`orders-manager`):
 * nada de tabla densa, nada de costo ni margen (esta vista viene de
 * `GET /api/admin/entregas`, que nunca los selecciona — ver el porqué en
 * `worker/src/routes/orders.ts`). Solo lo que hace falta para tocar la puerta,
 * cobrar si toca y seguir: cliente, dirección, teléfono, cuánto cobrar.
 */
@Component({
  selector: 'app-delivery-orders',
  imports: [CopPipe],
  templateUrl: './delivery-orders.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeliveryOrders {
  protected readonly adminApi = inject(AdminApiService);

  /** Pedido cuyo cobro está pendiente de confirmar en el modal. */
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly workingId = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);

  protected readonly confirmingEntrega = computed(() => {
    const id = this.confirmingId();
    return id ? (this.adminApi.deliveries().find((e) => e.id === id) ?? null) : null;
  });

  constructor() {
    this.adminApi.loadDeliveries();
    // La lista de repartidores solo la usa quien asigna. Se pide igual: si el
    // usuario es domiciliario, el Worker le responde 403 y la señal se queda
    // vacía, que es justo lo que esconde el selector.
    this.adminApi.loadCouriers();
  }

  // ───────────────── Abono de una deuda vieja, en la puerta ─────────────────

  /** Entrega cuyo formulario de abono está abierto. */
  protected readonly abonandoId = signal<string | null>(null);
  protected readonly montoAbono = signal(0);

  protected onMontoAbono(event: Event): void {
    this.montoAbono.set(Number((event.target as HTMLInputElement).value) || 0);
  }

  protected abrirAbono(entrega: ApiDelivery): void {
    this.feedback.set(null);
    this.montoAbono.set(0);
    this.abonandoId.set(entrega.id);
  }

  protected cerrarAbono(): void {
    this.abonandoId.set(null);
  }

  /**
   * Registra plata que el cliente paga de deudas anteriores.
   *
   * Es distinto de cobrar el pedido que se está entregando: eso lo hace
   * «Confirmar entrega y pago». Esto es para cuando, ya en la puerta, el
   * cliente aprovecha y abona de lo que debía de antes — que es donde el
   * dinero se perdía, porque había que anotarlo en un papel y teclearlo
   * después.
   *
   * El servidor lo aplica a las facturas más viejas primero y lo marca sin
   * liquidar: esa plata va en el bolsillo del domiciliario hasta que la
   * entregue en la finca.
   */
  protected registrarAbono(entrega: ApiDelivery): void {
    const monto = this.montoAbono();
    if (!entrega.contactId || monto <= 0) {
      this.feedback.set('Escribe cuánto te dio el cliente.');
      return;
    }

    this.feedback.set(null);
    this.workingId.set(entrega.id);

    this.adminApi
      .createPayment({ contactId: entrega.contactId, monto, metodo: 'efectivo' })
      .subscribe({
        next: ({ anticipo }) => {
          this.workingId.set(null);
          this.abonandoId.set(null);
          this.adminApi.loadDeliveries();
          this.feedback.set(
            anticipo > 0
              ? `Abono registrado. Sobraron ${anticipo.toLocaleString('es-CO')}: quedan a favor del cliente.`
              : 'Abono registrado.',
          );
        },
        error: (fallo: ApiErrorBody) => {
          this.workingId.set(null);
          this.feedback.set(fallo.message);
        },
      });
  }

  /**
   * Asigna, reasigna o suelta el domiciliario de un pedido.
   *
   * El selector solo aparece si hay repartidores cargados, y eso solo pasa
   * para `GESTOR_PEDIDOS`: un domiciliario no se adjudica pedidos a sí mismo.
   * El Worker lo rechaza igual, esto solo evita ofrecer un control que falla.
   */
  protected asignar(orderId: string, event: Event): void {
    const valor = (event.target as HTMLSelectElement).value;
    this.feedback.set(null);
    this.workingId.set(orderId);

    this.adminApi.assignCourier(orderId, valor === '' ? null : valor).subscribe({
      next: (order) => {
        this.workingId.set(null);
        this.feedback.set(
          order.domiciliarioNombre
            ? `Se lo lleva ${order.domiciliarioNombre}.`
            : 'Pedido sin domiciliario asignado.',
        );
      },
      error: (fallo: ApiErrorBody) => {
        this.workingId.set(null);
        this.feedback.set(fallo.message);
      },
    });
  }

  protected total(entrega: ApiDelivery): number {
    return entrega.items.reduce((suma, item) => suma + item.precioUnitario * item.cantidad, 0);
  }

  protected units(entrega: ApiDelivery): number {
    return entrega.items.reduce((suma, item) => suma + item.cantidad, 0);
  }

  /** `tel:` con solo dígitos: el navegador ignora espacios, pero un `+` inicial se conserva. */
  protected telHref(telefono: string): string {
    return `tel:${telefono.replace(/[^\d+]/g, '')}`;
  }

  /** Solo un contra entrega trae dinero que cobrar en la puerta. */
  protected isCashOnDelivery(entrega: ApiDelivery): boolean {
    return entrega.metodoPago === 'contraentrega';
  }

  protected askConfirm(entrega: ApiDelivery): void {
    this.confirmingId.set(entrega.id);
    this.feedback.set(null);
  }

  protected dismissConfirm(): void {
    this.confirmingId.set(null);
  }

  protected confirmPaid(entrega: ApiDelivery): void {
    this.confirmingId.set(null);
    this.workingId.set(entrega.id);

    this.adminApi.markOrderPaid(entrega.id).subscribe({
      next: () => {
        this.workingId.set(null);
        this.feedback.set(`${entrega.referencia} cobrado. Buen trabajo.`);
        // markOrderPaid() actualiza la lista del panel de escritorio
        // (adminApi.orders), no esta — son dos endpoints distintos. Se
        // recarga para que el pedido recién cobrado desaparezca de aquí.
        this.adminApi.loadDeliveries();
      },
      error: (error: ApiErrorBody) => {
        this.workingId.set(null);
        this.feedback.set(error.message);
        // Alguien más pudo haberlo cobrado primero (dos domiciliarios con el
        // mismo pedido, mal asignado): refrescar quita de la lista lo que ya
        // no está pendiente, en vez de dejar un botón que solo va a fallar.
        this.adminApi.loadDeliveries();
      },
    });
  }

  /**
   * Confirma la entrega de un pedido que no es contra entrega. Sin modal, a
   * diferencia de `confirmPaid`: no hay plata que verificar antes de tocar el
   * botón, así que el paso extra solo estorbaría.
   */
  protected confirmDelivered(entrega: ApiDelivery): void {
    this.workingId.set(entrega.id);

    this.adminApi.confirmDelivery(entrega.id).subscribe({
      next: () => {
        this.workingId.set(null);
        this.feedback.set(`${entrega.referencia} entregado. Buen trabajo.`);
        this.adminApi.loadDeliveries();
      },
      error: (error: ApiErrorBody) => {
        this.workingId.set(null);
        this.feedback.set(error.message);
        this.adminApi.loadDeliveries();
      },
    });
  }
}
