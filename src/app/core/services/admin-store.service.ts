import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { PRODUCTS } from '../data/mock-catalog';
import { ORDERS } from '../data/mock-orders';
import { AdminGroup, ADMIN_GROUP_OF, Product, stockLevelOf } from '../models/product.model';
import { ApprovalResult, Order, StockShortfall } from '../models/order.model';
import { KV_KEYS, KvStore } from './kv-store.service';

/**
 * Lo único que el panel puede modificar de un producto. Se persiste **solo
 * esto**, no el producto entero: así los cambios de copy, foto o categoría que
 * lleguen en un despliegue nuevo se reflejan igual, en vez de quedar
 * congelados por lo que hubiera guardado el navegador.
 */
interface InventoryPatch {
  readonly id: string;
  readonly price: number;
  readonly stock: number;
  readonly safetyStock: number;
}

export interface InventoryEdit {
  readonly price: number;
  readonly stock: number;
  readonly safetyStock: number;
}

@Injectable({ providedIn: 'root' })
export class AdminStoreService {
  private readonly kv = inject(KvStore);

  /**
   * Fuente de verdad **única** del inventario. La tienda pública también lee de
   * aquí (vía `CatalogService`), así que aprobar un pedido en el panel deja el
   * catálogo actualizado al instante, sin recargar ni sincronizar nada.
   */
  private readonly inventory = signal<readonly Product[]>(this.hydrateInventory());
  private readonly orderList = signal<readonly Order[]>(this.hydrateOrders());

  readonly products = this.inventory.asReadonly();
  readonly orders = this.orderList.asReadonly();

  // ─────────────────────────────── Derivados ───────────────────────────────

  /** Productos en o por debajo de su stock de seguridad, los más críticos primero. */
  readonly alerts = computed(() =>
    this.inventory()
      .filter((product) => stockLevelOf(product) !== 'ok')
      .sort((a, b) => a.stock - b.stock),
  );

  readonly alertCount = computed(() => this.alerts().length);

  readonly outOfStockCount = computed(
    () => this.inventory().filter((product) => product.stock <= 0).length,
  );

  readonly pendingOrders = computed(() =>
    this.orderList().filter((order) => order.status === 'pendiente'),
  );

  readonly pendingCount = computed(() => this.pendingOrders().length);

  /** Unidades totales en bodega: cabecera del dashboard. */
  readonly totalUnits = computed(() =>
    this.inventory().reduce((total, product) => total + product.stock, 0),
  );

  /** Valor del inventario a precio de venta. */
  readonly inventoryValue = computed(() =>
    this.inventory().reduce((total, product) => total + product.stock * product.price, 0),
  );

  constructor() {
    // Persistencia automática. `effect` vuelve a correr con cada cambio de las
    // señales que lee, así que no hay que acordarse de guardar en cada acción.
    effect(() => {
      const patches: InventoryPatch[] = this.inventory().map((product) => ({
        id: product.id,
        price: product.price,
        stock: product.stock,
        safetyStock: product.safetyStock,
      }));
      this.kv.put(KV_KEYS.inventory, patches);
    });

    effect(() => this.kv.put(KV_KEYS.orders, this.orderList()));
  }

  // ──────────────────────────────── Consultas ────────────────────────────────

  productById(id: string): Product | undefined {
    return this.inventory().find((product) => product.id === id);
  }

  /** Inventario filtrado por la agrupación macro del panel. */
  byGroup(group: AdminGroup | 'todos'): readonly Product[] {
    if (group === 'todos') {
      return this.inventory();
    }
    return this.inventory().filter((product) => ADMIN_GROUP_OF[product.categoryId] === group);
  }

  // ──────────────────────────────── Comandos ────────────────────────────────

  /** Guarda precio y stock desde el formulario de inventario. */
  updateProduct(id: string, edit: InventoryEdit): void {
    this.inventory.update((products) =>
      products.map((product) =>
        product.id === id
          ? {
              ...product,
              price: Math.max(0, Math.round(edit.price)),
              stock: Math.max(0, Math.round(edit.stock)),
              safetyStock: Math.max(0, Math.round(edit.safetyStock)),
            }
          : product,
      ),
    );
  }

  /**
   * Acción crítica: aprueba un pedido y descuenta el inventario.
   *
   * Se valida **todo el pedido antes de tocar nada**. Si una sola línea no
   * alcanza, no se descuenta ninguna: aprobar a medias dejaría el pedido en
   * un estado que el resto de la app no sabe representar.
   */
  approveOrder(orderId: string, approvedBy: string): ApprovalResult {
    const order = this.orderList().find((candidate) => candidate.id === orderId);

    if (!order) {
      return { ok: false, reason: 'not-found' };
    }
    if (order.status !== 'pendiente') {
      return { ok: false, reason: 'already-approved' };
    }

    // Un pedido puede repetir el mismo producto en varias líneas: se suman
    // antes de comparar, o cada línea pasaría el chequeo por separado.
    const required = new Map<string, number>();
    for (const line of order.lines) {
      required.set(line.productId, (required.get(line.productId) ?? 0) + line.quantity);
    }

    const shortfalls: StockShortfall[] = [];
    for (const [productId, quantity] of required) {
      const product = this.productById(productId);
      const available = product?.stock ?? 0;
      if (available < quantity) {
        shortfalls.push({
          productId,
          productName: product?.name ?? 'Producto retirado del catálogo',
          requested: quantity,
          available,
        });
      }
    }

    if (shortfalls.length > 0) {
      return { ok: false, reason: 'insufficient-stock', shortfalls };
    }

    this.inventory.update((products) =>
      products.map((product) => {
        const quantity = required.get(product.id);
        return quantity ? { ...product, stock: product.stock - quantity } : product;
      }),
    );

    this.patchOrder(orderId, {
      status: 'aprobado',
      approvedBy,
      approvedAt: new Date().toISOString(),
    });

    return { ok: true };
  }

  /** Solo se puede enviar lo que ya está aprobado. */
  markShipped(orderId: string): boolean {
    const order = this.orderList().find((candidate) => candidate.id === orderId);
    if (order?.status !== 'aprobado') {
      return false;
    }
    this.patchOrder(orderId, { status: 'enviado' });
    return true;
  }

  /** Devuelve inventario y pedidos a los datos de fábrica. */
  resetDemo(): void {
    this.kv.delete(KV_KEYS.inventory);
    this.kv.delete(KV_KEYS.orders);
    this.inventory.set(PRODUCTS);
    this.orderList.set(ORDERS);
  }

  private patchOrder(orderId: string, patch: Partial<Order>): void {
    this.orderList.update((orders) =>
      orders.map((order) => (order.id === orderId ? { ...order, ...patch } : order)),
    );
  }

  // ─────────────────────────────── Hidratación ───────────────────────────────

  /**
   * Parte siempre del catálogo del código y superpone lo guardado. Un producto
   * nuevo aparece con su stock de fábrica en vez de quedar fuera, y uno
   * retirado desaparece aunque siga en `localStorage`.
   */
  private hydrateInventory(): readonly Product[] {
    const patches = this.kv.get<InventoryPatch[]>(KV_KEYS.inventory);
    if (!patches?.length) {
      return PRODUCTS;
    }

    const byId = new Map(patches.map((patch) => [patch.id, patch]));

    return PRODUCTS.map((product) => {
      const patch = byId.get(product.id);
      if (!patch) {
        return product;
      }
      return {
        ...product,
        price: this.safeNumber(patch.price, product.price),
        stock: this.safeNumber(patch.stock, product.stock),
        safetyStock: this.safeNumber(patch.safetyStock, product.safetyStock),
      };
    });
  }

  private hydrateOrders(): readonly Order[] {
    const stored = this.kv.get<Order[]>(KV_KEYS.orders);
    return stored?.length ? stored : ORDERS;
  }

  /** `localStorage` es texto editable a mano: nada de confiar en los números. */
  private safeNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  }
}
