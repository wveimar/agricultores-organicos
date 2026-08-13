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
  ApiUser,
} from '../api/api-client';
import { UserRole } from '../models/user.model';

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

  /**
   * Las alertas de reposición solo miran lo que se está ofreciendo. Un
   * producto marcado como sin oferta esta semana no "falta": es que no se
   * vende, y contarlo llenaría el aviso de ruido cada vez que el agricultor
   * dice que no hay cosecha.
   */
  readonly alertCount = computed(
    () =>
      this.products().filter((p) => p.activo !== 0 && p.stock <= (p.stockSeguridad ?? 0)).length,
  );

  readonly outOfStockCount = computed(
    () => this.products().filter((p) => p.activo !== 0 && p.stock <= 0).length,
  );

  /** Productos retirados de la venta a la espera de que vuelva la cosecha. */
  readonly inactiveCount = computed(() => this.products().filter((p) => p.activo === 0).length);

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
    cantidadUnidad?: number;
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
    patch: Partial<{
      precio: number;
      precioCosto: number;
      stock: number;
      stockSeguridad: number;
      activo: 0 | 1;
      destacado: 0 | 1;
    }>,
  ): Observable<ApiProduct> {
    return this.api.updateProduct(id, patch).pipe(
      tap((updated) => {
        this.products.update((list) => list.map((p) => (p.id === id ? updated : p)));
      }),
    );
  }

  /**
   * Duplica un producto y mete la copia en la lista al instante.
   *
   * El `tap` sobre la señal es lo que hace que la pantalla de edición
   * encuentre la copia sin volver a pedir el inventario: `edit-product` la
   * busca en `products()`, así que si la señal no se actualizara antes de
   * navegar, mostraría "producto no encontrado".
   */
  duplicateProduct(id: string): Observable<ApiProduct> {
    return this.api.duplicateProduct(id).pipe(
      tap((copia) => this.products.update((list) => [...list, copia])),
    );
  }

  /**
   * Destaca o retira un producto de "Más vendidos" de la portada.
   *
   * Es deliberadamente independiente del stock y de las ventas: destacar es
   * una decisión comercial, no un reflejo de la bodega. Un producto agotado
   * puede seguir destacado —aparece con su aviso de agotado— y uno con mucha
   * rotación puede no estarlo.
   */
  setFeatured(id: string, destacado: boolean): Observable<ApiProduct> {
    return this.updateProduct(id, { destacado: destacado ? 1 : 0 });
  }

  /**
   * Borra un pedido y quita su fila de la lista.
   *
   * El Worker devuelve el inventario que tuviera reservado, así que se refresca
   * también el catálogo si había unidades en juego.
   */
  deleteOrder(id: string): Observable<{ ok: boolean; referencia: string; unidadesDevueltas: number }> {
    return this.api.deleteOrder(id).pipe(
      tap(({ unidadesDevueltas }) => {
        this.orders.update((list) => list.filter((o) => o.id !== id));
        if (unidadesDevueltas > 0 && this.products().length > 0) {
          this.loadProducts();
        }
      }),
    );
  }

  /**
   * Marca si el producto se ofrece esta semana.
   *
   * Es la llamada semanal al agricultor traducida a un campo: en cuanto pasa a
   * 0 el producto desaparece del catálogo público y `POST /api/orders` lo
   * rechaza, así que nadie puede pedir algo que no se va a poder despachar.
   */
  setAvailability(id: string, disponible: boolean): Observable<ApiProduct> {
    return this.updateProduct(id, { activo: disponible ? 1 : 0 });
  }

  updateProductFull(id: string, input: {
    nombre: string;
    slug?: string;
    tagline?: string;
    categoriaId: string;
    grupoAdmin: 'frutas' | 'verduras' | 'agroindustriales';
    precio: number;
    precioCosto: number;
    unidad: string;
    cantidadUnidad?: number;
    origen: string;
    imagen: string;
    imagenHover?: string;
    imagenAlt: string;
  }): Observable<ApiProduct> {
    return this.api.updateProductFull(id, input).pipe(
      tap((updated) => {
        this.products.update((list) => list.map((p) => (p.id === id ? updated : p)));
      }),
    );
  }

  // ──────────────────────────────── Usuarios ────────────────────────────────

  readonly users = signal<readonly ApiUser[]>([]);
  readonly usersLoading = signal(false);
  readonly usersError = signal<string | null>(null);

  loadUsers(): void {
    this.usersLoading.set(true);
    this.usersError.set(null);

    this.api.users().subscribe({
      next: (users) => {
        this.users.set(users);
        this.usersLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.usersError.set(error.message);
        this.usersLoading.set(false);
      },
    });
  }

  createUser(input: {
    email: string;
    nombre: string;
    password: string;
    roles: readonly UserRole[];
  }): Observable<ApiUser> {
    return this.api.createUser(input).pipe(
      tap((created) => this.users.update((list) => [...list, created])),
    );
  }

  updateUser(
    id: string,
    patch: Partial<{
      nombre: string;
      email: string;
      password: string;
      roles: readonly UserRole[];
      activo: 0 | 1;
    }>,
  ): Observable<ApiUser> {
    return this.api.updateUser(id, patch).pipe(
      tap((updated) => {
        this.users.update((list) => list.map((u) => (u.id === id ? updated : u)));
      }),
    );
  }

  changeOwnPassword(actual: string, nueva: string): Observable<{ ok: boolean }> {
    return this.api.changeOwnPassword(actual, nueva);
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

  /**
   * Anula un pedido y devuelve al inventario lo que tuviera reservado.
   *
   * Se refresca también el inventario: si el pedido llevaba stock apartado,
   * las cifras del panel de productos acaban de cambiar y dejarlas viejas
   * llevaría a decidir sobre unidades que ya volvieron.
   */
  cancelOrder(id: string, motivo?: string): Observable<{ order: ApiOrder; unidadesDevueltas: number }> {
    return this.api.cancelOrder(id, motivo).pipe(
      tap(({ order, unidadesDevueltas }) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? order : o)));
        if (unidadesDevueltas > 0 && this.products().length > 0) {
          this.loadProducts();
        }
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
