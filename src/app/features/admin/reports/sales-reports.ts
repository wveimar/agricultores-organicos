import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import {
  ApiClosing,
  ApiClosingOrder,
  ApiCodPending,
  ApiErrorBody,
  ApiSalesRow,
} from '../../../core/api/api-client';
import { ADMIN_GROUP_LABELS, AdminGroup } from '../../../core/models/product.model';
import { AbcClass, PAYMENT_METHOD_LABELS } from '../../../core/models/report.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Insignias del podio. Tonos terrosos, nada de oro/plata metálicos. */
const MEDAL_STYLES = [
  { label: 'Más vendido', chip: 'bg-clay text-bone' },
  { label: 'Segundo', chip: 'bg-sage text-moss-deep' },
  { label: 'Tercero', chip: 'bg-sand text-ink-soft' },
] as const;

const ABC_STYLES: Readonly<Record<AbcClass, { chip: string; hint: string }>> = {
  A: { chip: 'bg-moss text-bone', hint: 'Genera hasta el 80 % de los ingresos' },
  B: { chip: 'bg-sage-light text-moss-deep', hint: 'Del 80 % al 95 % de los ingresos' },
  C: { chip: 'bg-linen text-ink-muted', hint: 'Cola larga: mucha referencia, poco ingreso' },
};

function money(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(value);
}

@Component({
  selector: 'app-sales-reports',
  imports: [CopPipe],
  templateUrl: './sales-reports.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesReports {
  protected readonly adminApi = inject(AdminApiService);

  protected readonly groups = ADMIN_GROUP_LABELS;
  protected readonly medals = MEDAL_STYLES;
  protected readonly abcStyles = ABC_STYLES;
  protected readonly methodLabels = PAYMENT_METHOD_LABELS;

  protected readonly group = signal<AdminGroup | 'todos'>('todos');

  /** Cierre recién hecho, para mostrar el comprobante sin recargar. */
  protected readonly justClosed = signal<ApiClosing | null>(null);
  protected readonly confirming = signal(false);
  protected readonly closing = signal(false);
  protected readonly closeError = signal<string | null>(null);

  /**
   * Detalle de cada cierre, cargado al expandirlo.
   *
   * No se traen los pedidos de todos los cierres al abrir la pantalla: el
   * histórico llega a 50 registros y casi siempre solo interesa auditar uno.
   */
  protected readonly expandedClosing = signal<string | null>(null);
  private readonly closingDetail = signal<ReadonlyMap<string, readonly ApiClosingOrder[]>>(new Map());
  protected readonly detailLoading = signal<string | null>(null);
  protected readonly detailError = signal<string | null>(null);

  constructor() {
    this.adminApi.loadSalesReport();
    this.adminApi.loadCashSummary();
    this.adminApi.loadClosings();
    this.adminApi.loadCodPending();
    // Para el contador «En cartera» de los KPIs: lo fiado que aún no ha
    // entrado, al lado de lo que sí entró.
    this.adminApi.loadCartera();
  }

  protected readonly settlingId = signal<string | null>(null);

  /**
   * Confirma que el efectivo de un pedido contra entrega ya llegó a la finca.
   * Sin modal de confirmación aparte —a diferencia de cerrar caja— porque no
   * archiva nada ni es irreversible en el mismo sentido: solo cambia una
   * bandera de un pedido concreto.
   */
  protected settleCod(pendiente: ApiCodPending): void {
    this.settlingId.set(pendiente.id);
    this.adminApi.settleOrderCash(pendiente.id).subscribe({
      next: () => this.settlingId.set(null),
      error: () => this.settlingId.set(null),
    });
  }

  protected readonly visibleSales = computed<readonly ApiSalesRow[]>(() => {
    const group = this.group();
    const rows = this.adminApi.salesRows();
    return group === 'todos' ? rows : rows.filter((row) => row.grupoAdmin === group);
  });

  /** Ya viene ordenado por ingresos desde la consulta SQL. */
  protected readonly topProducts = computed(() => this.adminApi.salesRows().slice(0, 3));

  protected readonly countsByGroup = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.adminApi.salesRows().length };
    for (const row of this.adminApi.salesRows()) {
      totals[row.grupoAdmin] = (totals[row.grupoAdmin] ?? 0) + 1;
    }
    return totals;
  });

  protected readonly receiptPreview = computed(() => {
    const closing = this.justClosed();
    return closing ? this.buildReceipt(closing) : null;
  });

  protected setGroup(group: AdminGroup | 'todos'): void {
    this.group.set(group);
  }

  /** Posición en el podio global, o -1 si no está en el top 3. */
  protected medalIndex(productId: string): number {
    return this.topProducts().findIndex((row) => row.productId === productId);
  }

  protected askConfirm(): void {
    this.justClosed.set(null);
    this.closeError.set(null);
    this.confirming.set(true);
  }

  protected cancelClose(): void {
    this.confirming.set(false);
  }

  /**
   * Cierre de jornada. Se pide confirmación antes porque archiva pedidos en el
   * servidor y no hay forma de deshacerlo desde la interfaz.
   */
  protected confirmClose(): void {
    this.closing.set(true);
    this.closeError.set(null);

    this.adminApi.closeCash().subscribe({
      next: ({ closing }) => {
        this.closing.set(false);
        this.confirming.set(false);
        this.justClosed.set(closing);
        this.adminApi.loadSalesReport();
        window.scrollTo({ top: 0, behavior: 'instant' });
      },
      error: (error: ApiErrorBody) => {
        this.closing.set(false);
        this.confirming.set(false);
        this.closeError.set(error.message);
      },
    });
  }

  protected toggleClosing(closing: ApiClosing): void {
    const opening = this.expandedClosing() !== closing.id;
    this.expandedClosing.set(opening ? closing.id : null);
    this.detailError.set(null);

    if (opening && !this.closingDetail().has(closing.id)) {
      this.loadClosingDetail(closing.id);
    }
  }

  protected detailFor(closingId: string): readonly ApiClosingOrder[] {
    return this.closingDetail().get(closingId) ?? [];
  }

  private loadClosingDetail(closingId: string): void {
    this.detailLoading.set(closingId);

    this.adminApi.closingOrders(closingId).subscribe({
      next: (orders) => {
        this.detailLoading.set(null);
        this.closingDetail.update((map) => new Map(map).set(closingId, orders));
      },
      error: (error: ApiErrorBody) => {
        this.detailLoading.set(null);
        this.detailError.set(error.message);
      },
    });
  }

  /** Total cobrado de un pedido dentro del cierre: producto + su envío. */
  protected orderTotal(order: ApiClosingOrder): number {
    return order.ventaProducto + order.envio;
  }

  /**
   * Suma de las líneas mostradas. Sirve para auditar a ojo: si no coincide con
   * el total congelado en el cierre, algo no cuadra y hay que mirarlo.
   */
  protected detailTotal(closingId: string): number {
    return this.detailFor(closingId).reduce((sum, order) => sum + this.orderTotal(order), 0);
  }

  /**
   * El recibo incluye el detalle pedido a pedido, así que hay que tenerlo
   * cargado antes de generarlo. Si el cierre no se ha expandido todavía, se
   * pide primero y se descarga al llegar.
   */
  protected download(closing: ApiClosing): void {
    if (this.closingDetail().has(closing.id)) {
      this.saveReceipt(closing);
      return;
    }

    this.detailLoading.set(closing.id);
    this.adminApi.closingOrders(closing.id).subscribe({
      next: (orders) => {
        this.detailLoading.set(null);
        this.closingDetail.update((map) => new Map(map).set(closing.id, orders));
        this.saveReceipt(closing);
      },
      error: (error: ApiErrorBody) => {
        this.detailLoading.set(null);
        this.detailError.set(error.message);
      },
    });
  }

  private saveReceipt(closing: ApiClosing): void {
    const blob = new Blob([this.buildReceipt(closing)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${closing.referencia}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Los pedidos del cierre salen de `orders.closing_id`, la FK que puso el
   * propio cierre al archivarlos. Listarlos aquí es lo que hace el documento
   * auditable: se puede sumar la columna y comprobar que da el total.
   */
  private buildReceipt(closing: ApiClosing): string {
    const when = new Date(closing.cerradoEn).toLocaleString('es-CO');
    const orders = this.detailFor(closing.id);

    const detail = orders.length
      ? [
          '',
          '--- PEDIDOS INCLUIDOS ---',
          ...orders.map(
            (order) =>
              `${order.referencia}  ${order.unidades.toString().padStart(3)} uds  ` +
              `${money(this.orderTotal(order)).padStart(12)}  ${order.clienteNombre}`,
          ),
        ]
      : [];

    return [
      'AGRICULTORES ORGÁNICOS',
      `Cierre de jornada ${closing.referencia}`,
      `Fecha: ${when}`,
      `Responsable: ${closing.cerradoPor}`,
      ...detail,
      '',
      '--- RESUMEN ---',
      `Pedidos cerrados:   ${closing.pedidos}`,
      `Unidades vendidas:  ${closing.unidades}`,
      `Venta de producto:  ${money(closing.ventaProducto)}`,
      `Costo de producto:  ${money(closing.costoProducto)}`,
      `Ganancia:           ${money(closing.ganancia)}`,
      `Envíos cobrados:    ${money(closing.enviosCobrados)}`,
      `TOTAL RECAUDADO:    ${money(closing.totalRecaudado)}`,
      '',
      'Documento generado en el navegador. Sin valor fiscal.',
    ].join('\n');
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected sharePercent(share: number): number {
    return Math.round(share * 100);
  }

  protected marginPercent(row: ApiSalesRow): number {
    return row.ingresos > 0 ? Math.round((row.ganancia / row.ingresos) * 100) : 0;
  }

  protected readonly averageTicket = computed(() => {
    const summary = this.adminApi.cashSummary();
    if (!summary || summary.pedidos === 0) {
      return 0;
    }
    return Math.round(summary.totalRecaudado / summary.pedidos);
  });

  protected readonly profitMarginPercent = computed(() => {
    const summary = this.adminApi.cashSummary();
    if (!summary || summary.ventaProducto === 0) {
      return 0;
    }
    return summary.ganancia / summary.ventaProducto;
  });

  /** `metodo` llega como texto libre desde la API; se resuelve con fallback. */
  protected methodLabel(metodo: string): string {
    return (this.methodLabels as Record<string, string>)[metodo] ?? metodo;
  }
}
