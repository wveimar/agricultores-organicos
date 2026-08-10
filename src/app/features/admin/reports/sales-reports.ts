import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiClosing, ApiErrorBody, ApiSalesRow } from '../../../core/api/api-client';
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

  constructor() {
    this.adminApi.loadSalesReport();
    this.adminApi.loadCashSummary();
    this.adminApi.loadClosings();
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

  protected download(closing: ApiClosing): void {
    const blob = new Blob([this.buildReceipt(closing)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${closing.referencia}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * El cierre no guarda la lista de referencias de pedido (el esquema solo
   * enlaza cada pedido a su cierre por `closing_id`, no al revés), así que el
   * recibo muestra el conteo pero no el detalle línea por línea.
   */
  private buildReceipt(closing: ApiClosing): string {
    const when = new Date(closing.cerradoEn).toLocaleString('es-CO');

    return [
      'AGRICULTORES ORGÁNICOS',
      `Cierre de jornada ${closing.referencia}`,
      `Fecha: ${when}`,
      `Responsable: ${closing.cerradoPor}`,
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
