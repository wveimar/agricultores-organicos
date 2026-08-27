import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import {
  ApiCashSummary,
  ApiCategory,
  ApiClient,
  ApiClosing,
  ApiClosingOrder,
  ApiContact,
  ApiCarteraRow,
  ApiCodPending,
  ApiConsolidation,
  ApiDelivery,
  ApiErrorBody,
  ApiExpense,
  ApiOrder,
  ApiOrderStatusLogEntry,
  ApiProduct,
  ApiPurchase,
  ApiSalesRow,
  ApiUser,
  ApiWholesaleRow,
  ApiWholesaleTariff,
  ContactInput,
  ExpenseCategory,
  PurchaseInput,
  PurchaseItemInput,
} from '../api/api-client';
import { UserRole, WholesaleRole } from '../models/user.model';

type SalesTotals = { unidades: number; ingresos: number; costo: number; ganancia: number };

const EMPTY_TOTALS: SalesTotals = { unidades: 0, ingresos: 0, costo: 0, ganancia: 0 };

/** Recalcula el resumen tras editar una fila, sin volver a pedir la tarifa. */
function recomputeSummary(products: readonly ApiWholesaleRow[]): ApiWholesaleTariff['resumen'] {
  const conDescuento = products.filter((p) => p.porcentaje !== null);
  return {
    conDescuento: conDescuento.length,
    total: products.length,
    bajoCosto: conDescuento.filter((p) => p.precioMayorista < p.precioCosto).length,
  };
}

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

  // ──────────────────────────────── Categorías ────────────────────────────────

  readonly categories = signal<readonly ApiCategory[]>([]);
  readonly categoriesLoading = signal(false);
  readonly categoriesError = signal<string | null>(null);

  /**
   * Todas, incluidas las desactivadas: esta es la pantalla desde donde se
   * vuelven a encender, así que esconderlas las dejaría inalcanzables.
   */
  loadCategories(): void {
    this.categoriesLoading.set(true);
    this.categoriesError.set(null);

    this.api.adminCategories().subscribe({
      next: (rows) => {
        this.categories.set(rows);
        this.categoriesLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.categoriesError.set(error.message);
        this.categoriesLoading.set(false);
      },
    });
  }

  /** Las que se pueden elegir al archivar un producto: solo las activas. */
  readonly selectableCategories = computed(() =>
    this.categories().filter((c) => c.activo === 1),
  );

  categoryById(id: string): ApiCategory | undefined {
    return this.categories().find((c) => c.id === id);
  }

  /**
   * `id → nombre legible`, para reportes y tarifas.
   *
   * Cada pantalla se armaba el suyo desde la constante `CATEGORIES`; ahora sale
   * de la tabla, así que una categoría creada hoy ya no aparece en un informe
   * como `panaderia-fina` en bruto. Quien lo use debe seguir cayendo al id con
   * `?? id`: el informe puede traer una categoría borrada después de la venta.
   */
  readonly categoryLabels = computed<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(this.categories().map((c) => [c.id, c.nombre])),
  );

  createCategory(input: Parameters<ApiClient['createCategory']>[0]): Observable<ApiCategory> {
    return this.api.createCategory(input).pipe(
      tap((created) => this.categories.set([...this.categories(), created])),
    );
  }

  updateCategory(
    id: string,
    patch: Parameters<ApiClient['updateCategory']>[1],
  ): Observable<ApiCategory> {
    return this.api.updateCategory(id, patch).pipe(
      tap((updated) =>
        // Se conserva `productos`: el recuento lo calcula el listado y la
        // respuesta del PUT no lo trae. Sin esto, editar un nombre dejaría la
        // fila diciendo que está vacía y el botón de borrar se activaría.
        this.categories.set(
          this.categories().map((c) =>
            c.id === id ? { ...updated, productos: c.productos } : c,
          ),
        ),
      ),
    );
  }

  deleteCategory(id: string): Observable<void> {
    return this.api.deleteCategory(id).pipe(
      tap(() => this.categories.set(this.categories().filter((c) => c.id !== id))),
    );
  }

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
    parentId?: string | null;
    varianteEtiqueta?: string | null;
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
    parentId?: string | null;
    varianteEtiqueta?: string | null;
  }): Observable<ApiProduct> {
    return this.api.updateProductFull(id, input).pipe(
      tap((updated) => {
        // Basta con sustituir la fila: las agrupaciones de variantes son
        // `computed` sobre esta misma señal, así que cambiar el `parentId` de
        // una fila reordena los grupos solo, sin recargar el inventario.
        this.products.update((list) => list.map((p) => (p.id === id ? updated : p)));
      }),
    );
  }

  // ─────────────────────────────── Variantes ───────────────────────────────

  /**
   * Variantes agrupadas por el id de su madre.
   *
   * Se calcula una vez por carga del inventario, no una por fila pintada: la
   * tabla tiene una fila por producto y preguntar recorriendo la lista en cada
   * una sería cuadrático.
   */
  private readonly variantsByParent = computed<ReadonlyMap<string, readonly ApiProduct[]>>(() => {
    const groups = new Map<string, ApiProduct[]>();

    for (const product of this.products()) {
      if (!product.parentId) {
        continue;
      }
      const siblings = groups.get(product.parentId);
      if (siblings) {
        siblings.push(product);
      } else {
        groups.set(product.parentId, [product]);
      }
    }

    for (const siblings of groups.values()) {
      siblings.sort((a, b) => a.precio - b.precio || a.nombre.localeCompare(b.nombre, 'es'));
    }

    return groups;
  });

  variantsOf(parentId: string): readonly ApiProduct[] {
    return this.variantsByParent().get(parentId) ?? [];
  }

  isParent(productId: string): boolean {
    return this.variantsByParent().has(productId);
  }

  productById(id: string): ApiProduct | undefined {
    return this.products().find((product) => product.id === id);
  }

  /**
   * Productos que pueden hacer de madre para `productId`.
   *
   * Se descartan los mismos tres casos que rechaza el Worker, para que la
   * elección imposible ni siquiera aparezca en el desplegable: uno mismo, las
   * que ya son variantes de otro, y —si este producto ya agrupa variantes— se
   * devuelve lista vacía, porque colgarlo lo convertiría en nieto de alguien.
   */
  possibleParents(productId: string | null): readonly ApiProduct[] {
    if (productId && this.isParent(productId)) {
      return [];
    }

    return this.products()
      .filter((product) => !product.parentId && product.id !== productId)
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
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

  /** El domiciliario (o un admin de respaldo) marca que cobró un pedido contra entrega. */
  markOrderPaid(id: string): Observable<ApiOrder> {
    return this.api.markOrderPaid(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
      }),
    );
  }

  /**
   * El domiciliario confirma que entregó un pedido que no es contra entrega.
   * No hay nada que cobrar ni recaudar: solo actualiza la lista de escritorio
   * por si `entregadoEn` llega a mostrarse ahí. La lista de entregas la
   * refresca el propio componente con `loadDeliveries()`, igual que hace
   * `markOrderPaid` desde la pantalla del domiciliario.
   */
  confirmDelivery(id: string): Observable<ApiOrder> {
    return this.api.confirmDelivery(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
      }),
    );
  }

  /** Fía un pedido al mayorista que lo hizo. El Worker valida cupo y plazo. */
  grantCredit(id: string): Observable<ApiOrder> {
    return this.api.grantCredit(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
        // Acaba de nacer una deuda: la cartera ya no dice lo mismo.
        this.loadCartera();
      }),
    );
  }

  /**
   * El mayorista pagó. A partir de aquí el pedido sí cuenta como recaudado y
   * lo recogerá el siguiente cierre de caja, así que hay que refrescar las
   * tres cosas que cambian de significado a la vez.
   */
  collectCredit(id: string): Observable<ApiOrder> {
    return this.api.collectCredit(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
        this.cartera.update((list) => list.filter((d) => d.id !== id));
        this.loadCashSummary();
      }),
    );
  }

  /** Confirma que el efectivo de un pedido contra entrega ya está en la finca. */
  settleOrderCash(id: string): Observable<ApiOrder> {
    return this.api.settleOrderCash(id).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
        // El resumen de caja acaba de cambiar de significado: este pedido
        // pasa a contar como recaudado, y sale de la lista de pendientes.
        this.loadCashSummary();
        if (this.codPending().length > 0) {
          this.loadCodPending();
        }
      }),
    );
  }

  /**
   * El cliente rechazó el pedido en la puerta. Igual que cancelOrder(): puede
   * devolver stock, así que refresca el inventario cuando corresponde.
   */
  rejectDelivery(id: string, motivo?: string): Observable<{ order: ApiOrder; unidadesDevueltas: number }> {
    return this.api.rejectDelivery(id, motivo).pipe(
      tap(({ order, unidadesDevueltas }) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? order : o)));
        if (unidadesDevueltas > 0 && this.products().length > 0) {
          this.loadProducts();
        }
      }),
    );
  }

  /** Pedidos contra entrega listos para cobrar, para la vista del domiciliario. */
  readonly deliveries = signal<readonly ApiDelivery[]>([]);
  readonly deliveriesLoading = signal(false);
  readonly deliveryCount = computed(() => this.deliveries().length);

  loadDeliveries(): void {
    this.deliveriesLoading.set(true);
    this.api.deliveries().subscribe({
      next: (list) => {
        this.deliveries.set(list);
        this.deliveriesLoading.set(false);
      },
      error: () => this.deliveriesLoading.set(false),
    });
  }

  /**
   * Guarda la lista de líneas editada. Si el pedido tenía stock reservado, el
   * Worker ya ajustó el inventario en la misma transacción: se refresca el
   * catálogo para que el panel de inventario no quede con cifras viejas.
   */
  updateOrderItems(
    id: string,
    items: readonly { productId: string; cantidad: number }[],
  ): Observable<ApiOrder> {
    return this.api.updateOrderItems(id, items).pipe(
      tap((updated) => {
        this.orders.update((list) => list.map((o) => (o.id === id ? updated : o)));
        if (this.products().length > 0) {
          this.loadProducts();
        }
      }),
    );
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

  // ─────────────────────────── Tarifas de mayorista ───────────────────────────

  readonly wholesaleTariff = signal<ApiWholesaleTariff | null>(null);
  readonly wholesaleLoading = signal(false);

  loadWholesaleTariff(role: WholesaleRole): void {
    this.wholesaleLoading.set(true);
    // Se limpia antes de pedir: dejar la tarifa del nivel anterior en pantalla
    // mientras carga el siguiente enseñaría descuentos que no son los de ese
    // nivel, y son cifras sobre las que alguien decide.
    this.wholesaleTariff.set(null);

    this.api.wholesaleTariff(role).subscribe({
      next: (tariff) => {
        this.wholesaleTariff.set(tariff);
        this.wholesaleLoading.set(false);
      },
      error: () => this.wholesaleLoading.set(false),
    });
  }

  /**
   * Fija el descuento de un producto y refleja el cambio en la tabla sin
   * volver a pedir el catálogo entero: la respuesta ya trae el precio
   * calculado por el servidor, que es el que se va a cobrar.
   */
  setWholesaleDiscount(
    role: WholesaleRole,
    productId: string,
    porcentaje: number,
  ): Observable<{
    productId: string;
    role: WholesaleRole;
    porcentaje: number | null;
    precioMayorista: number;
    bajoCosto: boolean;
  }> {
    return this.api.setWholesaleDiscount(role, productId, porcentaje).pipe(
      tap((res) => {
        this.wholesaleTariff.update((tariff) => {
          if (!tariff) {
            return tariff;
          }
          const products = tariff.products.map((row) =>
            row.productId === productId
              ? { ...row, porcentaje: res.porcentaje, precioMayorista: res.precioMayorista }
              : row,
          );
          return { ...tariff, products, resumen: recomputeSummary(products) };
        });
      }),
    );
  }

  setWholesaleBulk(
    role: WholesaleRole,
    productIds: readonly string[],
    porcentaje: number,
  ): Observable<{ role: WholesaleRole; porcentaje: number | null; aplicados: number }> {
    return this.api.setWholesaleBulk(role, productIds, porcentaje).pipe(
      // Aquí sí se recarga: la respuesta masiva solo dice cuántos se aplicaron,
      // no el precio resultante de cada uno. Recalcularlos en el navegador
      // sería duplicar la fórmula del servidor en un tercer sitio.
      tap(() => this.loadWholesaleTariff(role)),
    );
  }

  // ─────────────────────────── Consolidado semanal ───────────────────────────

  readonly consolidation = signal<ApiConsolidation | null>(null);
  readonly consolidationLoading = signal(false);
  readonly consolidationError = signal<string | null>(null);

  /**
   * Carga el consolidado. Sin rango trae la jornada abierta.
   *
   * No se cachea entre visitas a la pantalla: entre el jueves y el viernes se
   * aprueban pedidos, y un consolidado viejo manda a cosechar de menos.
   */
  loadConsolidation(range: { desde?: string; hasta?: string } = {}): void {
    this.consolidationLoading.set(true);
    this.consolidationError.set(null);

    this.api.consolidation(range).subscribe({
      next: (data) => {
        this.consolidation.set(data);
        this.consolidationLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.consolidationError.set(error.message);
        this.consolidationLoading.set(false);
      },
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

  /** Lo que los mayoristas deben hoy. Vacío mientras no se haya pedido. */
  readonly cartera = signal<readonly ApiCarteraRow[]>([]);
  readonly carteraLoading = signal(false);
  readonly carteraError = signal<string | null>(null);

  loadCartera(): void {
    this.carteraLoading.set(true);
    this.carteraError.set(null);
    this.api.cartera().subscribe({
      next: (list) => {
        this.cartera.set(list);
        this.carteraLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.carteraError.set(error.message);
        this.carteraLoading.set(false);
      },
    });
  }

  /**
   * Venta fiada, para la métrica junto al recaudado del cierre.
   *
   * Solo producto, igual que todas las cifras de venta del panel: el
   * domicilio no cuenta como ingreso. Para saber cuánto hay que pedirle de
   * verdad al mayorista está `carteraPorCobrar`.
   */
  readonly carteraTotal = computed(() =>
    this.cartera().reduce((suma, deuda) => suma + deuda.total, 0),
  );

  /**
   * Lo que hay que cobrar: producto **más** domicilio.
   *
   * El mayorista debe las dos cosas — el domicilio no será venta de la finca,
   * pero se lo cobraron igual. Va separada de `carteraTotal` porque las dos
   * responden preguntas distintas: aquella "cuánto vendí fiado", esta "cuánta
   * plata tengo que recoger".
   */
  readonly carteraPorCobrar = computed(() =>
    this.cartera().reduce((suma, deuda) => suma + deuda.total + deuda.envio, 0),
  );

  /** Lo ya vencido, que es lo que de verdad preocupa. */
  readonly carteraVencida = computed(() =>
    this.cartera()
      .filter((deuda) => deuda.tramo !== 'corriente')
      .reduce((suma, deuda) => suma + deuda.total, 0),
  );

  /** Efectivo contra entrega cobrado, esperando que un admin confirme que llegó a la finca. */
  readonly codPending = signal<readonly ApiCodPending[]>([]);

  loadCodPending(): void {
    this.api.codPending().subscribe({ next: (list) => this.codPending.set(list) });
  }

  // ──────────────── Gastos operativos y pago a las fincas ────────────────

  /** Gastos de la jornada abierta: los que todavía no ha adoptado un cierre. */
  readonly expenses = signal<readonly ApiExpense[]>([]);
  readonly expensesLoading = signal(false);
  readonly expensesError = signal<string | null>(null);

  loadExpenses(): void {
    this.expensesLoading.set(true);
    this.expensesError.set(null);
    this.api.expenses().subscribe({
      next: (list) => {
        this.expenses.set(list);
        this.expensesLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.expensesError.set(error.message);
        this.expensesLoading.set(false);
      },
    });
  }

  /**
   * Lo que se lleva la operación esta jornada. Es lo que se restará de la
   * ganancia al cerrar, así que se muestra antes de cerrar y no después.
   */
  readonly expensesTotal = computed(() =>
    this.expenses().reduce((suma, gasto) => suma + gasto.monto, 0),
  );

  createExpense(gasto: {
    descripcion: string;
    monto: number;
    categoria: ExpenseCategory;
  }): Observable<ApiExpense> {
    return this.api.createExpense(gasto).pipe(
      tap((creado) => {
        // Al principio: la lista va de más reciente a más antiguo, igual que
        // la ordena el Worker. Sin esto habría que recargar para verlo.
        this.expenses.update((list) => [creado, ...list]);
      }),
    );
  }

  deleteExpense(id: string): Observable<void> {
    return this.api.deleteExpense(id).pipe(
      tap(() => {
        this.expenses.update((list) => list.filter((gasto) => gasto.id !== id));
      }),
    );
  }

  // ───────────── Agenda: proveedores y clientes ─────────────

  /** La agenda completa, activos e inactivos. El filtrado va en la vista. */
  readonly contacts = signal<readonly ApiContact[]>([]);
  readonly contactsLoading = signal(false);
  readonly contactsError = signal<string | null>(null);

  loadContacts(): void {
    this.contactsLoading.set(true);
    this.contactsError.set(null);
    this.api.contacts({ incluirInactivos: true }).subscribe({
      next: (list) => {
        this.contacts.set(list);
        this.contactsLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.contactsError.set(error.message);
        this.contactsLoading.set(false);
      },
    });
  }

  /** Proveedores activos, que es lo que ofrece el selector de compras. */
  readonly proveedoresActivos = computed(() =>
    this.contacts().filter((c) => c.esProveedor === 1 && c.activo === 1),
  );

  createContact(contacto: ContactInput): Observable<ApiContact> {
    return this.api.createContact(contacto).pipe(
      tap((creado) => {
        this.contacts.update((list) =>
          [...list, creado].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
        );
      }),
    );
  }

  updateContact(id: string, contacto: ContactInput): Observable<ApiContact> {
    return this.api.updateContact(id, contacto).pipe(
      tap((actualizado) => {
        // Se conservan los contadores del listado: la respuesta del PATCH trae
        // solo la ficha, y perderlos dejaría la fila diciendo "0 pedidos".
        this.contacts.update((list) =>
          list
            .map((c) => (c.id === id ? { ...c, ...actualizado } : c))
            .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
        );
      }),
    );
  }

  deleteContact(id: string): Observable<void> {
    return this.api.deleteContact(id).pipe(
      tap(() => {
        this.contacts.update((list) => list.filter((c) => c.id !== id));
      }),
    );
  }

  // ─────────────────────── Compras a las fincas ───────────────────────

  /** Historial completo de compras. El filtrado por finca/estado va en la vista. */
  readonly purchases = signal<readonly ApiPurchase[]>([]);
  readonly purchasesLoading = signal(false);
  readonly purchasesError = signal<string | null>(null);

  loadPurchases(): void {
    this.purchasesLoading.set(true);
    this.purchasesError.set(null);
    this.api.purchases().subscribe({
      next: (list) => {
        this.purchases.set(list);
        this.purchasesLoading.set(false);
      },
      error: (error: ApiErrorBody) => {
        this.purchasesError.set(error.message);
        this.purchasesLoading.set(false);
      },
    });
  }

  /** Lo que se le debe todavía a los agricultores, de lo que hay cargado. */
  readonly purchasesPendiente = computed(() =>
    this.purchases()
      .filter((compra) => compra.estado === 'pendiente')
      .reduce((suma, compra) => suma + compra.totalPago, 0),
  );

  /**
   * Registrar una compra mueve inventario y costo, así que además de meterla
   * en la lista hay que refrescar el catálogo: los productos que se ven en el
   * panel acaban de cambiar de stock y de `precioCosto`.
   */
  createPurchase(compra: PurchaseInput): Observable<ApiPurchase> {
    return this.api.createPurchase(compra).pipe(
      tap((creada) => {
        this.purchases.update((list) => [creada, ...list]);
        this.loadProducts();
      }),
    );
  }

  updatePurchase(id: string, compra: PurchaseInput): Observable<ApiPurchase> {
    return this.api.updatePurchase(id, compra).pipe(
      tap((actualizada) => {
        this.purchases.update((list) => list.map((c) => (c.id === id ? actualizada : c)));
        this.loadProducts();
      }),
    );
  }

  deletePurchase(id: string): Observable<void> {
    return this.api.deletePurchase(id).pipe(
      tap(() => {
        this.purchases.update((list) => list.filter((c) => c.id !== id));
        this.loadProducts();
      }),
    );
  }

  /** Solo cambia el estado: el inventario ya se movió al registrar. */
  markPurchasePaid(id: string): Observable<ApiPurchase> {
    return this.api.markPurchasePaid(id).pipe(
      tap((actualizada) => {
        this.purchases.update((list) => list.map((c) => (c.id === id ? actualizada : c)));
      }),
    );
  }
}
