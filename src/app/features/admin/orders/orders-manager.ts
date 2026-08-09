import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminStoreService } from '../../../core/services/admin-store.service';
import { AuthService } from '../../../core/services/auth.service';
import {
  ORDER_STATUS_LABELS,
  Order,
  OrderStatus,
  StockShortfall,
  orderTotal,
  orderUnits,
} from '../../../core/models/order.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

const STATUS_STYLES: Readonly<Record<OrderStatus, string>> = {
  pendiente: 'bg-honey/20 text-clay-deep',
  aprobado: 'bg-sage-light text-moss-deep',
  enviado: 'bg-linen text-ink-soft',
};

const FILTERS: ReadonlyArray<{ value: OrderStatus | 'todos'; label: string }> = [
  { value: 'todos', label: 'Todos' },
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'aprobado', label: 'Aprobados' },
  { value: 'enviado', label: 'Enviados' },
];

@Component({
  selector: 'app-orders-manager',
  imports: [CopPipe],
  templateUrl: './orders-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrdersManager {
  protected readonly store = inject(AdminStoreService);
  private readonly auth = inject(AuthService);

  protected readonly filters = FILTERS;
  protected readonly statusLabels = ORDER_STATUS_LABELS;
  protected readonly statusStyles = STATUS_STYLES;

  protected readonly activeFilter = signal<OrderStatus | 'todos'>('todos');
  protected readonly expandedId = signal<string | null>(null);

  /** Faltantes del último intento fallido, por id de pedido. */
  protected readonly blocked = signal<{ orderId: string; shortfalls: readonly StockShortfall[] } | null>(null);
  protected readonly feedback = signal<string | null>(null);

  protected readonly visible = computed<readonly Order[]>(() => {
    const filter = this.activeFilter();
    const orders =
      filter === 'todos'
        ? this.store.orders()
        : this.store.orders().filter((order) => order.status === filter);

    // Pendientes primero, y dentro de cada grupo lo más reciente arriba.
    const weight: Record<OrderStatus, number> = { pendiente: 0, aprobado: 1, enviado: 2 };
    return orders
      .slice()
      .sort(
        (a, b) =>
          weight[a.status] - weight[b.status] ||
          new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime(),
      );
  });

  protected readonly countsByStatus = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.store.orders().length };
    for (const order of this.store.orders()) {
      totals[order.status] = (totals[order.status] ?? 0) + 1;
    }
    return totals;
  });

  protected total(order: Order): number {
    return orderTotal(order);
  }

  protected units(order: Order): number {
    return orderUnits(order);
  }

  /** Stock actual de un producto, para pintarlo junto a la cantidad pedida. */
  protected availableFor(productId: string): number {
    return this.store.productById(productId)?.stock ?? 0;
  }

  protected toggle(orderId: string): void {
    this.expandedId.update((current) => (current === orderId ? null : orderId));
  }

  /**
   * Acción crítica. El servicio valida todo el pedido antes de descontar; aquí
   * solo se traduce el resultado a algo que el gestor pueda entender y accionar.
   */
  protected approve(order: Order): void {
    this.blocked.set(null);
    this.feedback.set(null);

    const approver = this.auth.user()?.name ?? 'Desconocido';
    const result = this.store.approveOrder(order.id, approver);

    if (result.ok) {
      this.feedback.set(`${order.reference} aprobado. Inventario descontado.`);
      return;
    }

    if (result.reason === 'insufficient-stock') {
      this.blocked.set({ orderId: order.id, shortfalls: result.shortfalls });
      this.expandedId.set(order.id);
      return;
    }

    this.feedback.set(
      result.reason === 'already-approved'
        ? `${order.reference} ya había sido aprobado.`
        : 'No se encontró el pedido.',
    );
  }

  protected ship(order: Order): void {
    this.blocked.set(null);
    if (this.store.markShipped(order.id)) {
      this.feedback.set(`${order.reference} marcado como enviado.`);
    }
  }

  protected shortfallsFor(orderId: string): readonly StockShortfall[] | null {
    const current = this.blocked();
    return current?.orderId === orderId ? current.shortfalls : null;
  }
}
