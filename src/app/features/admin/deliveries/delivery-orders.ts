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
