import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AdminStoreService } from './admin-store.service';
import { KV_KEYS, KvStore } from './kv-store.service';
import { ADMIN_GROUP_OF, AdminGroup } from '../models/product.model';
import {
  AbcClass,
  CashClosing,
  MethodTotal,
  ProductSales,
} from '../models/report.model';

/** Umbrales de la clasificación ABC, sobre ingresos acumulados. */
const ABC_A_LIMIT = 0.8;
const ABC_B_LIMIT = 0.95;

export type ClosingResult =
  | { readonly ok: true; readonly closing: CashClosing }
  | { readonly ok: false; readonly reason: 'sin-ventas' };

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly store = inject(AdminStoreService);
  private readonly kv = inject(KvStore);

  /** Filtro de grupo del resumen por producto. */
  readonly group = signal<AdminGroup | 'todos'>('todos');

  /** Historial de cierres, el más reciente primero. */
  private readonly closingLog = signal<readonly CashClosing[]>(this.hydrateClosings());
  readonly historyLog = this.closingLog.asReadonly();

  /** Pedidos que entrarían en el próximo cierre. */
  readonly closableOrders = this.store.closableOrders;

  constructor() {
    effect(() => this.kv.put(KV_KEYS.closings, this.closingLog()));
  }

  // ───────────────────────────── Resumen de ventas ─────────────────────────────

  /**
   * Agrega las líneas de los pedidos vendibles por producto y les asigna la
   * clase ABC. Todo sale de un `computed` sobre la señal de pedidos: cambiar
   * un pedido en otra pantalla repinta este reporte sin recalcular a mano.
   */
  readonly salesByProduct = computed<readonly ProductSales[]>(() => {
    const orders = this.closableOrders();

    const totals = new Map<
      string,
      { units: number; revenue: number; orderIds: Set<string> }
    >();

    for (const order of orders) {
      for (const line of order.lines) {
        const entry = totals.get(line.productId) ?? {
          units: 0,
          revenue: 0,
          orderIds: new Set<string>(),
        };
        entry.units += line.quantity;
        entry.revenue += line.unitPrice * line.quantity;
        entry.orderIds.add(order.id);
        totals.set(line.productId, entry);
      }
    }

    const grandTotal = [...totals.values()].reduce((sum, entry) => sum + entry.revenue, 0);

    // Se ordena por ingreso antes de acumular: la clase ABC depende del orden.
    const rows = [...totals.entries()]
      .map(([productId, entry]) => {
        const product = this.store.productById(productId);
        return {
          productId,
          // Un producto retirado del catálogo sigue apareciendo en ventas
          // pasadas; se degrada en vez de romper la tabla.
          name: product?.name ?? 'Producto retirado del catálogo',
          image: product?.image ?? '',
          imageAlt: product?.imageAlt ?? '',
          origin: product?.origin ?? 'Origen no disponible',
          categoryId: product?.categoryId ?? 'despensa',
          group: product ? ADMIN_GROUP_OF[product.categoryId] : 'agroindustriales',
          units: entry.units,
          revenue: entry.revenue,
          stock: product?.stock ?? 0,
          orderCount: entry.orderIds.size,
          revenueShare: grandTotal > 0 ? entry.revenue / grandTotal : 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    let cumulative = 0;
    return rows.map((row) => {
      // Se clasifica con el acumulado **previo**: el producto que cruza el 80 %
      // sigue siendo clase A. Mirando el acumulado posterior, un producto que
      // por sí solo pasara del 80 % caería en B y la clase A quedaría vacía.
      const before = cumulative;
      cumulative += row.revenueShare;
      return { ...row, abc: classify(before) } as ProductSales;
    });
  });

  /** Resumen filtrado por el grupo activo. El ABC se conserva del cálculo global. */
  readonly visibleSales = computed<readonly ProductSales[]>(() => {
    const group = this.group();
    if (group === 'todos') {
      return this.salesByProduct();
    }
    return this.salesByProduct().filter((row) => row.group === group);
  });

  /** Top 3 por ingresos. Se toma del global, no del filtro. */
  readonly topProducts = computed(() => this.salesByProduct().slice(0, 3));

  readonly countsByGroup = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.salesByProduct().length };
    for (const row of this.salesByProduct()) {
      totals[row.group] = (totals[row.group] ?? 0) + 1;
    }
    return totals;
  });

  // ──────────────────────────────── KPIs ────────────────────────────────

  readonly productRevenue = computed(() =>
    this.salesByProduct().reduce((sum, row) => sum + row.revenue, 0),
  );

  readonly unitsSold = computed(() =>
    this.salesByProduct().reduce((sum, row) => sum + row.units, 0),
  );

  readonly approvedCount = computed(() => this.closableOrders().length);

  /** Envíos cobrados. Los pedidos antiguos sin desglose cuentan como 0. */
  readonly shippingCollected = computed(() =>
    this.closableOrders().reduce((sum, order) => sum + (order.totals?.shipping ?? 0), 0),
  );

  readonly grossSales = computed(() => this.productRevenue() + this.shippingCollected());

  readonly averageTicket = computed(() => {
    const count = this.approvedCount();
    return count > 0 ? Math.round(this.grossSales() / count) : 0;
  });

  /**
   * Desglose por método de recaudo. Todo va a consignación bancaria porque el
   * checkout es manual; la estructura admite más métodos sin cambios.
   */
  readonly byMethod = computed<readonly MethodTotal[]>(() => [
    {
      method: 'consignacion',
      orderCount: this.approvedCount(),
      total: this.grossSales(),
    },
  ]);

  readonly canClose = computed(() => this.approvedCount() > 0);

  // ─────────────────────────────── Cierre ───────────────────────────────

  /**
   * Cierra la jornada: congela las cifras en un `CashClosing` y archiva los
   * pedidos incluidos.
   *
   * Las cifras se calculan **antes** de archivar. Si se leyeran después, los
   * `computed` ya habrían excluido esos pedidos y el cierre quedaría en cero.
   */
  performClosing(closedBy: string): ClosingResult {
    const orders = this.closableOrders();
    if (orders.length === 0) {
      return { ok: false, reason: 'sin-ventas' };
    }

    const closing: CashClosing = {
      id: `c-${Date.now()}`,
      reference: this.nextReference(),
      closedAt: new Date().toISOString(),
      closedBy,
      orderCount: orders.length,
      unitCount: this.unitsSold(),
      productRevenue: this.productRevenue(),
      shippingCollected: this.shippingCollected(),
      grossSales: this.grossSales(),
      byMethod: this.byMethod(),
      orderRefs: orders.map((order) => order.reference),
    };

    this.store.archiveOrders(
      orders.map((order) => order.id),
      closing.id,
    );

    this.closingLog.update((log) => [closing, ...log]);

    return { ok: true, closing };
  }

  /** Genera el cierre en texto plano para descargarlo o pegarlo en WhatsApp. */
  buildReceipt(closing: CashClosing): string {
    const money = (value: number) =>
      new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        maximumFractionDigits: 0,
      }).format(value);

    const when = new Date(closing.closedAt).toLocaleString('es-CO');

    return [
      'AGRICULTORES ORGÁNICOS',
      `Cierre de jornada ${closing.reference}`,
      `Fecha: ${when}`,
      `Responsable: ${closing.closedBy}`,
      '',
      '--- RESUMEN ---',
      `Pedidos cerrados:   ${closing.orderCount}`,
      `Unidades vendidas:  ${closing.unitCount}`,
      `Venta de producto:  ${money(closing.productRevenue)}`,
      `Envíos cobrados:    ${money(closing.shippingCollected)}`,
      `TOTAL RECAUDADO:    ${money(closing.grossSales)}`,
      '',
      '--- POR MÉTODO ---',
      ...closing.byMethod.map(
        (entry) => `Consignación bancaria: ${money(entry.total)} (${entry.orderCount} pedidos)`,
      ),
      '',
      '--- PEDIDOS INCLUIDOS ---',
      ...closing.orderRefs.map((ref) => `- ${ref}`),
      '',
      'Documento generado en el navegador. Sin valor fiscal.',
    ].join('\n');
  }

  /** Descarga el cierre como .txt usando un Blob local, sin servidor. */
  downloadReceipt(closing: CashClosing): void {
    const blob = new Blob([this.buildReceipt(closing)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `${closing.reference}.txt`;
    link.click();

    // Sin esto el Blob queda retenido en memoria mientras viva la pestaña.
    URL.revokeObjectURL(url);
  }

  private nextReference(): string {
    const highest = this.closingLog().reduce((max, closing) => {
      const parsed = Number.parseInt(closing.reference.replace(/\D/g, ''), 10);
      return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
    }, 0);
    return `CIERRE-${String(highest + 1).padStart(4, '0')}`;
  }

  private hydrateClosings(): readonly CashClosing[] {
    return this.kv.get<CashClosing[]>(KV_KEYS.closings) ?? [];
  }
}

/** `shareBefore` es el acumulado *antes* de sumar el producto que se clasifica. */
function classify(shareBefore: number): AbcClass {
  if (shareBefore < ABC_A_LIMIT) {
    return 'A';
  }
  return shareBefore < ABC_B_LIMIT ? 'B' : 'C';
}
