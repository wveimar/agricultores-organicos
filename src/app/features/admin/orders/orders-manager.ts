import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import {
  ApiErrorBody,
  ApiOrder,
  ApiOrderStatusLogEntry,
  Shortfall,
} from '../../../core/api/api-client';
import { ORDER_STATUS_LABELS, OrderStatus, isCancelable } from '../../../core/models/order.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

const STATUS_STYLES: Readonly<Record<OrderStatus, string>> = {
  verificacion: 'bg-clay/15 text-clay-deep',
  pendiente: 'bg-honey/20 text-clay-deep',
  aprobado: 'bg-sage-light text-moss-deep',
  enviado: 'bg-linen text-ink-soft',
  cancelado: 'bg-berry/12 text-berry',
};

const FILTERS: ReadonlyArray<{ value: OrderStatus | 'todos'; label: string }> = [
  { value: 'todos', label: 'Todos' },
  { value: 'verificacion', label: 'Por verificar' },
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'aprobado', label: 'Aprobados' },
  { value: 'enviado', label: 'Enviados' },
  { value: 'cancelado', label: 'Cancelados' },
];

@Component({
  selector: 'app-orders-manager',
  imports: [CopPipe],
  templateUrl: './orders-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrdersManager {
  protected readonly adminApi = inject(AdminApiService);

  protected readonly filters = FILTERS;
  protected readonly statusLabels = ORDER_STATUS_LABELS;
  protected readonly statusStyles = STATUS_STYLES;

  protected readonly activeFilter = signal<OrderStatus | 'todos'>('todos');
  protected readonly expandedId = signal<string | null>(null);
  protected readonly workingId = signal<string | null>(null);

  /** Faltantes del último intento fallido, por id de pedido. */
  protected readonly blocked = signal<{ orderId: string; shortfalls: readonly Shortfall[] } | null>(null);
  protected readonly feedback = signal<string | null>(null);

  /** Traza por pedido, cargada bajo demanda al abrir el detalle. */
  protected readonly history = signal<ReadonlyMap<string, readonly ApiOrderStatusLogEntry[]>>(new Map());
  protected readonly historyLoading = signal<string | null>(null);

  /**
   * Comprobantes ya descargados, como object URLs (`blob:`).
   *
   * La imagen no puede ir en un `<img src="/api/...">` porque el endpoint pide
   * el JWT y el navegador no lo manda en la carga de una imagen. Se baja como
   * Blob por HttpClient (que sí pasa por el interceptor) y se envuelve en una
   * object URL. Se cachean por pedido para no volver a pedir la misma imagen
   * cada vez que se abre y cierra el detalle.
   */
  private readonly receiptUrls = signal<ReadonlyMap<string, string>>(new Map());
  protected readonly receiptLoading = signal<string | null>(null);
  protected readonly receiptErrors = signal<ReadonlyMap<string, string>>(new Map());

  constructor() {
    this.adminApi.loadOrders();

    // Cada object URL retiene su blob en memoria hasta que se revoca. Sin
    // esto, revisar veinte comprobantes en una sesión larga deja veinte
    // imágenes vivas aunque ya no se muestre ninguna.
    inject(DestroyRef).onDestroy(() => {
      for (const url of this.receiptUrls().values()) {
        URL.revokeObjectURL(url);
      }
    });
  }

  protected readonly visible = computed<readonly ApiOrder[]>(() => {
    const filter = this.activeFilter();
    const orders = this.adminApi.orders();
    const filtered = filter === 'todos' ? orders : orders.filter((order) => order.estado === filter);

    // Lo que espera decisión primero, y dentro de cada grupo lo más reciente arriba.
    // Lo cancelado va al final: ya no espera ninguna decisión.
    const weight: Record<OrderStatus, number> = {
      verificacion: 0,
      pendiente: 1,
      aprobado: 2,
      enviado: 3,
      cancelado: 4,
    };
    return filtered
      .slice()
      .sort(
        (a, b) =>
          weight[a.estado] - weight[b.estado] ||
          new Date(b.creadoEn).getTime() - new Date(a.creadoEn).getTime(),
      );
  });

  protected readonly countsByStatus = computed<Record<string, number>>(() => {
    const orders = this.adminApi.orders();
    const totals: Record<string, number> = { todos: orders.length };
    for (const order of orders) {
      totals[order.estado] = (totals[order.estado] ?? 0) + 1;
    }
    return totals;
  });

  protected total(order: ApiOrder): number {
    return order.items.reduce((sum, item) => sum + item.precioUnitario * item.cantidad, 0);
  }

  protected units(order: ApiOrder): number {
    return order.items.reduce((sum, item) => sum + item.cantidad, 0);
  }


  protected toggle(order: ApiOrder): void {
    const opening = this.expandedId() !== order.id;
    this.expandedId.set(opening ? order.id : null);

    if (!opening) {
      return;
    }

    this.loadHistory(order.id);

    // Solo si hay comprobante y no se ha bajado ya en esta sesión.
    if (order.tieneComprobante && !this.receiptUrls().has(order.id)) {
      this.loadReceipt(order.id);
    }
  }

  protected receiptUrlFor(orderId: string): string | null {
    return this.receiptUrls().get(orderId) ?? null;
  }

  protected receiptErrorFor(orderId: string): string | null {
    return this.receiptErrors().get(orderId) ?? null;
  }

  /** Reintento manual, para cuando la descarga falló por un corte de red. */
  protected retryReceipt(orderId: string): void {
    this.receiptErrors.update((map) => {
      const next = new Map(map);
      next.delete(orderId);
      return next;
    });
    this.loadReceipt(orderId);
  }

  private loadReceipt(orderId: string): void {
    this.receiptLoading.set(orderId);

    this.adminApi.orderReceipt(orderId).subscribe({
      next: (blob) => {
        this.receiptLoading.set(null);
        this.receiptUrls.update((map) =>
          new Map(map).set(orderId, URL.createObjectURL(blob)),
        );
      },
      error: (error: ApiErrorBody) => {
        this.receiptLoading.set(null);
        this.receiptErrors.update((map) => new Map(map).set(orderId, error.message));
      },
    });
  }

  protected historyFor(orderId: string): readonly ApiOrderStatusLogEntry[] {
    return this.history().get(orderId) ?? [];
  }

  private loadHistory(orderId: string): void {
    this.historyLoading.set(orderId);
    this.adminApi.orderHistory(orderId).subscribe({
      next: (entries) => {
        this.historyLoading.set(null);
        this.history.update((map) => new Map(map).set(orderId, entries));
      },
      error: () => this.historyLoading.set(null),
    });
  }

  /**
   * Acción crítica. El Worker valida todo el pedido dentro de una transacción
   * antes de descontar; aquí solo se traduce el resultado a algo accionable.
   */
  protected approve(order: ApiOrder): void {
    this.blocked.set(null);
    this.feedback.set(null);
    this.workingId.set(order.id);

    this.adminApi.approveOrder(order.id).subscribe({
      next: () => {
        this.workingId.set(null);
        this.feedback.set(`${order.referencia} aprobado. Inventario descontado.`);
        if (this.expandedId() === order.id) {
          this.loadHistory(order.id);
        }
      },
      error: (error: ApiErrorBody) => {
        this.workingId.set(null);

        if (error.code === 'stock-insuficiente') {
          const shortfalls = (error.details as { shortfalls?: Shortfall[] } | undefined)?.shortfalls ?? [];
          this.blocked.set({ orderId: order.id, shortfalls });
          this.expandedId.set(order.id);
          return;
        }

        this.feedback.set(error.message);
      },
    });
  }

  protected ship(order: ApiOrder): void {
    this.blocked.set(null);
    this.workingId.set(order.id);

    this.adminApi.shipOrder(order.id).subscribe({
      next: () => {
        this.workingId.set(null);
        this.feedback.set(`${order.referencia} marcado como enviado.`);
        if (this.expandedId() === order.id) {
          this.loadHistory(order.id);
        }
      },
      error: (error: ApiErrorBody) => {
        this.workingId.set(null);
        this.feedback.set(error.message);
      },
    });
  }

  protected shortfallsFor(orderId: string): readonly Shortfall[] | null {
    const current = this.blocked();
    return current?.orderId === orderId ? current.shortfalls : null;
  }

  // ─────────────────────────── Cancelar un pedido ───────────────────────────

  /** Pedido cuya cancelación está pendiente de confirmar. */
  protected readonly cancelingId = signal<string | null>(null);
  protected readonly cancelReason = signal('');

  protected canCancel(order: ApiOrder): boolean {
    return isCancelable(order.estado as OrderStatus);
  }

  /**
   * Se pide confirmación en vez de cancelar al primer clic.
   *
   * Cancelar devuelve stock y escribe en la traza: no hay botón de deshacer, y
   * el de cancelar queda junto al de aprobar, que es justo donde un clic
   * despistado hace daño.
   */
  protected askCancel(order: ApiOrder): void {
    this.cancelingId.set(order.id);
    this.cancelReason.set('');
    this.blocked.set(null);
    this.feedback.set(null);
  }

  protected dismissCancel(): void {
    this.cancelingId.set(null);
    this.cancelReason.set('');
  }

  protected onReason(event: Event): void {
    this.cancelReason.set((event.target as HTMLInputElement).value);
  }

  // ─────────────────────────── Eliminar un pedido ───────────────────────────

  /**
   * Pedido cuya eliminación está pendiente de confirmar.
   *
   * Eliminar no es cancelar: cancelar deja constancia de que el pedido existió
   * y de por qué se anuló; eliminar borra la fila y, con ella, sus líneas y su
   * trazabilidad. Es para lo que nunca debió estar ahí —pruebas, spam, un
   * doble clic— y por eso pide confirmación aparte.
   */
  protected readonly deletingId = signal<string | null>(null);

  /** Un pedido archivado en un cierre de caja no se puede borrar. */
  protected canDelete(order: ApiOrder): boolean {
    return order.closingId === null;
  }

  protected askDelete(order: ApiOrder): void {
    this.deletingId.set(order.id);
    this.cancelingId.set(null);
    this.blocked.set(null);
    this.feedback.set(null);
  }

  protected dismissDelete(): void {
    this.deletingId.set(null);
  }

  protected confirmDelete(order: ApiOrder): void {
    this.workingId.set(order.id);

    this.adminApi.deleteOrder(order.id).subscribe({
      next: ({ unidadesDevueltas }) => {
        this.workingId.set(null);
        this.deletingId.set(null);
        this.feedback.set(
          unidadesDevueltas > 0
            ? `${order.referencia} eliminado. ${unidadesDevueltas} ${
                unidadesDevueltas === 1 ? 'unidad vuelve' : 'unidades vuelven'
              } al inventario.`
            : `${order.referencia} eliminado.`,
        );
      },
      error: (error: ApiErrorBody) => {
        this.workingId.set(null);
        this.deletingId.set(null);
        this.feedback.set(error.message);
      },
    });
  }

  protected confirmCancel(order: ApiOrder): void {
    this.workingId.set(order.id);

    this.adminApi.cancelOrder(order.id, this.cancelReason().trim() || undefined).subscribe({
      next: ({ unidadesDevueltas }) => {
        this.workingId.set(null);
        this.cancelingId.set(null);
        this.cancelReason.set('');
        this.feedback.set(
          unidadesDevueltas > 0
            ? `${order.referencia} cancelado. ${unidadesDevueltas} ${
                unidadesDevueltas === 1 ? 'unidad vuelve' : 'unidades vuelven'
              } al inventario.`
            : `${order.referencia} cancelado. No tenía inventario apartado.`,
        );
        if (this.expandedId() === order.id) {
          this.loadHistory(order.id);
        }
      },
      error: (error: ApiErrorBody) => {
        this.workingId.set(null);
        this.cancelingId.set(null);
        this.feedback.set(error.message);
      },
    });
  }
}
