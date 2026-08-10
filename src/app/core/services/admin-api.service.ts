import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import {
  ApiCashSummary,
  ApiClient,
  ApiClosing,
  ApiClosingOrder,
  ApiErrorBody,
  ApiOrder,
  ApiOrderStatusLogEntry,
  ApiProduct,
  ApiSalesRow,
} from '../api/api-client';

type SalesTotals = { unidades: number; ingresos: number; costo: number; ganancia: number };

const EMPTY_TOTALS: SalesTotals = { unidades: 0, ingresos: 0, costo: 0, ganancia: 0 };

/**
 * Estado del panel administrativo respaldado por el Worker + D1.
 *
 * Es el reemplazo, para las pantallas de `/admin`, del viejo `AdminStoreService`
 * (que sigue existiendo y sigue siendo la fuente de la tienda pública, el
 * carrito y el checkout — ver la nota de alcance en el README). Aquí no hay
 * persistencia local: cada `load*()` es una petición HTTP real, y el estado
 * vive en memoria mientras dura la sesión de navegación.
 *
 * Cada `load*()` gestiona su propio `loading`/`error`; los métodos de
 * escritura (`updateProduct`, `approveOrder`, ...) devuelven el `Observable`
 * tal cual para que el componente pueda mostrar su propio mensaje de éxito o
 * error junto al control que disparó la acción — igual que hacía antes con el
 * `ApprovalResult` local.
 */
@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly api = inject(ApiClient);

  // ──────────────────────────────── Inventario ────────────────────────────────

  readonly products = signal<readonly ApiProduct[]>([]);
  readonly productsLoading = signal(false);
  readonly productsError = signal<string | null>(null);

  readonly alertCount = computed(
    () => this.products().filter((p) => p.stock <= (p.stockSeguridad ?? 0)).length,
  );

  readonly outOfStockCount = computed(
    () => this.products().filter((p) => p.stock <= 0).length,
  );

  loadProducts(): void {
    this.productsLoading.set(true);
    this.productsError.set(null);

    this.api.adminProducts().subscribe({
      next: (products) => {
        this.products.set(products);
        this.productsLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.productsError.set(error.message);
        this.productsLoading.set(false);
      },
    });
  }

  createProduct(input: {
    nombre: string;
    slug?: string;
    tagline?: string;
    categoriaId: string;
    grupoAdmin: 'frutas' | 'verduras' | 'agroindustriales';
    precio: number;
    precioCosto?: number;
    unidad: string;
    origen: string;
    imagen: string;
    imagenHover?: string;
    imagenAlt: string;
  }): Observable<ApiProduct> {
    return this.api.createProduct(input).pipe(
      tap((created) => {
        this.products.update((list) => [...list, created]);
      }),
    );
  }

  updateProduct(
    id: string,
    patch: Partial<{ precio: number; precioCosto: number; stock: number; stockSeguridad: number }>,
  ): Observable<ApiProduct> {
    return this.api.updateProduct(id, patch).pipe(
      tap((updated) => {
        this.products.update((list) => list.map((p) => (p.id === id ? updated : p)));
      }),
    );
  }

  // ───────────────────────────────── Pedidos ─────────────────────────────────

  readonly orders = signal<readonly ApiOrder[]>([]);
  readonly ordersLoading = signal(false);
  readonly ordersError = signal<string | null>(null);

  readonly pendingCount = computed(
    () => this.orders().filter((o) => o.estado === 'pendiente' || o.estado === 'verificacion').length,
  );

  /** Trae solo la jornada abierta: lo ya archivado en un cierre vive en Reportes. */
  loadOrders(): void {
    this.ordersLoading.set(true);
    this.ordersError.set(null);

    this.api.orders({ abiertos: true }).subscribe({
      next: (orders) => {
        this.orders.set(orders);
        this.ordersLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.ordersError.set(error.message);
        this.ordersLoading.set(false);
      },
    });
  }

  approveOrder(id: string): Observable<ApiOrder> {
    return this.api.approveOrder(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
      }),
    );
  }

  shipOrder(id: string): Observable<ApiOrder> {
    return this.api.shipOrder(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
      }),
    );
  }

  /** Traza de estados, para soporte postventa por WhatsApp. */
  orderHistory(id: string): Observable<readonly ApiOrderStatusLogEntry[]> {
    return this.api.orderHistory(id);
  }

  /** Imagen del comprobante (Workers KV), tras el JWT. */
  orderReceipt(id: string): Observable<Blob> {
    return this.api.orderReceipt(id);
  }

  // ───────────────────────────────── Reportes ─────────────────────────────────

  readonly salesRows = signal<readonly ApiSalesRow[]>([]);
  readonly salesTotals = signal<SalesTotals>(EMPTY_TOTALS);
  readonly salesLoading = signal(false);

  loadSalesReport(): void {
    this.salesLoading.set(true);

    this.api.salesReport().subscribe({
      next: (res) => {
        this.salesRows.set(res.products);
        this.salesTotals.set(res.totals);
        this.salesLoading.set(false);
      },
      error: () => this.salesLoading.set(false),
    });
  }

  readonly cashSummary = signal<ApiCashSummary | null>(null);

  loadCashSummary(): void {
    this.api.cashSummary().subscribe({ next: (summary) => this.cashSummary.set(summary) });
  }

  readonly closings = signal<readonly ApiClosing[]>([]);

  loadClosings(): void {
    this.api.closings().subscribe({ next: (list) => this.closings.set(list) });
  }

  /** Detalle de un cierre: los pedidos que lo componen. */
  closingOrders(id: string): Observable<readonly ApiClosingOrder[]> {
    return this.api.closingOrders(id);
  }

  readonly canClose = computed(() => (this.cashSummary()?.pedidos ?? 0) > 0);

  closeCash(): Observable<{ closing: ApiClosing; pedidosArchivados: number }> {
    return this.api.closeCash().pipe(
      tap(() => {
        // El cierre archiva pedidos y vacía la caja de la jornada: se refresca
        // todo lo que depende de "qué sigue abierto" en vez de parchear a mano.
        this.loadCashSummary();
        this.loadClosings();
        this.loadOrders();
      }),
    );
  }
}
