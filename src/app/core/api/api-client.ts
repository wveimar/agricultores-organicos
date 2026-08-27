import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, tap, throwError } from 'rxjs';
import { ApiSession, TokenStore } from './token-store';
import { UserRole, WholesaleRole } from '../models/user.model';
import {
  CategoryId,
  Product,
  ProductBadge,
  ProductUnit,
} from '../models/product.model';

/** Cuenta del panel. `password_hash` nunca sale del servidor. */
export interface ApiUser {
  readonly id: string;
  readonly email: string;
  readonly nombre: string;
  readonly activo: number;
  readonly creadoEn: string;
  readonly roles: readonly UserRole[];
  /** Cuánto se le puede fiar, en pesos. 0 = esta cuenta no compra a crédito. */
  readonly cupoCredito: number;
  /** A cuántos días vence lo que se le fía. */
  readonly diasCredito: number;
}

/** Forma estable de los errores del Worker: `{ error: { code, message, details } }`. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface Shortfall {
  readonly productId: string;
  readonly productName: string;
  readonly requested: number;
  readonly available: number;
}

/** Fila de `categories`. Los chips de la vitrina y el desplegable del panel. */
/** Un producto dentro de una canasta, con lo necesario para pintarlo. */
export interface ApiComponent {
  readonly childId: string;
  readonly nombre: string;
  readonly unidad: string;
  readonly cantidadUnidad: number;
  /** Stock del componente suelto, para ver cuál es el que frena la canasta. */
  readonly stock: number;
  readonly activo: number;
  /** Cuántos entran en UNA canasta. */
  readonly cantidadRequerida: number;
}

/** La receta completa de una canasta. */
export interface ApiRecipe {
  readonly parentId: string;
  readonly componentes: readonly ApiComponent[];
  /**
   * Cuántas canastas salen con el inventario de ahora, por el componente más
   * escaso. `null` = no es canasta, se vende con su propio stock.
   */
  readonly armables: number | null;
}

export interface ApiCategory {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string;
  /**
   * Clave de la silueta del chip: 'hoja', 'panal', 'espiga'… El repertorio
   * vive en `CategoryIcon`; aquí solo viaja cuál le toca. Vacío = la de por
   * defecto, que es lo que trae una categoría recién creada.
   */
  readonly icono: string;
  readonly grupoAdmin: 'frutas' | 'verduras' | 'agroindustriales';
  /** Posición del chip. Menor va antes. */
  readonly orden: number;
  readonly activo: 0 | 1;
  readonly actualizadoEn: string;
  /** Cuántos productos cuelgan de ella. Solo en `/api/admin/categories`. */
  readonly productos?: number;
}

export interface ApiProduct {
  readonly id: string;
  readonly slug: string;
  readonly nombre: string;
  readonly tagline: string;
  readonly categoriaId: string;
  readonly grupoAdmin: string;
  readonly precio: number;
  readonly precioAnterior: number | null;
  readonly unidad: string;
  /** Cuánto lleva la presentación: 500 con unidad 'gr', 5 con 'unidad'. */
  readonly cantidadUnidad: number;
  readonly origen: string;
  readonly rating: number;
  readonly reviewCount: number;
  readonly badge: string | null;
  /** 1 = sale en "Más vendidos" de la portada. Decisión comercial, no del stock. */
  readonly destacado: number;
  readonly stock: number;
  readonly imagen: string;
  readonly imagenHover: string | null;
  readonly imagenAlt: string;
  /** Producto sombrilla del que esta fila es variante. `null` = producto suelto o madre. */
  readonly parentId?: string | null;
  /** Solo en las madres: 'presentación', 'sabor'… */
  readonly varianteEtiqueta?: string | null;
  /**
   * Qué lleva dentro, si es una canasta. Solo lo que el cliente puede saber:
   * nombre y cuánto entra, nunca el stock ni el costo de cada componente.
   */
  readonly contiene?: readonly {
    readonly nombre: string;
    readonly cantidad: number;
    readonly unidad: string;
    readonly cantidadUnidad: number;
  }[];
  /**
   * Precio ya con el descuento del nivel de mayorista de la sesión. Solo llega
   * en `/api/products` y solo si la cuenta tiene tarifa para ese producto: sin
   * sesión, o siendo cliente normal, el campo no viene y se paga `precio`.
   *
   * Lo calcula el servidor. La tienda no recibe la tabla de descuentos, así
   * que desde el navegador no se pueden ver los tratos de otros niveles.
   */
  readonly precioMayorista?: number;
  readonly descuentoMayorista?: number;
  /** Solo en las respuestas de /api/admin/*. */
  readonly precioCosto?: number;
  readonly stockSeguridad?: number;
  readonly categoriaAbc?: 'A' | 'B' | 'C';
  readonly margenUnitario?: number;
  /**
   * 1 = tiene receta: su stock sale de los componentes, no de columna propia.
   * 1 en `tieneVariantes` = es madre y el inventario vive en sus hijas.
   *
   * Las pantallas que mueven inventario (registrar una compra) no deben
   * ofrecer ninguna de las dos: sumarles unidades escribiría en una columna
   * que nadie lee. Solo en `/api/admin/*`.
   */
  readonly esCanasta?: number;
  readonly tieneVariantes?: number;
  /**
   * 1 = se ofrece esta semana · 0 = el agricultor no tiene cosecha.
   *
   * Solo llega en `/api/admin/*`: el catálogo público ya viene filtrado por
   * el servidor, así que allí todo lo que llega está activo por definición.
   */
  readonly activo?: number;
}

/**
 * Traduce el `ApiProduct` del Worker (columnas en español, tal cual las
 * expone la API) al `Product` que ya consume toda la tienda pública
 * (`nombre` → `name`, `precio` → `price`, …).
 *
 * Existe para que conectar el catálogo público al backend real sea cambiar
 * **de dónde** sale el `Product[]`, no reescribir cada componente de la
 * vitrina. `/api/products` (el endpoint público) no manda `precioCosto` ni
 * `stockSeguridad` — son columnas solo de `/api/admin/*` — así que aquí caen
 * a 0: la tienda pública nunca los muestra, solo el panel.
 */
export function toProduct(p: ApiProduct): Product {
  return {
    id: p.id,
    slug: p.slug,
    name: p.nombre,
    tagline: p.tagline,
    categoryId: p.categoriaId as CategoryId,
    // `price` es siempre lo que paga quien mira: con tarifa de mayorista, el
    // precio ya descontado. Así el carrito y el checkout suman sin saber que
    // los mayoristas existen, y `listPrice` queda solo para pintar el tachado.
    price: p.precioMayorista ?? p.precio,
    listPrice: p.precioMayorista !== undefined ? p.precio : undefined,
    wholesaleDiscount: p.descuentoMayorista,
    compareAtPrice: p.precioAnterior ?? undefined,
    costPrice: p.precioCosto ?? 0,
    unit: p.unidad as ProductUnit,
    quantity: p.cantidadUnidad ?? 1,
    origin: p.origen,
    rating: p.rating,
    reviewCount: p.reviewCount,
    badge: (p.badge as ProductBadge | null) ?? undefined,
    featured: p.destacado === 1,
    stock: p.stock,
    safetyStock: p.stockSeguridad ?? 0,
    image: p.imagen,
    imageHover: p.imagenHover ?? undefined,
    imageAlt: p.imagenAlt,
    parentId: p.parentId ?? undefined,
    variantLabel: p.varianteEtiqueta ?? undefined,
    // Solo viene en las canastas. Su ausencia es lo que distingue un producto
    // normal de uno que se arma con otros, así que se deja `undefined` en vez
    // de un array vacío: la tienda pregunta por el contenido, no por su largo.
    contains: p.contiene?.map((c) => ({
      name: c.nombre,
      quantity: c.cantidad,
      unit: c.unidad as ProductUnit,
      unitQuantity: c.cantidadUnidad,
    })),
  };
}

export interface ApiOrderItem {
  readonly productId: string;
  readonly productoNombre: string;
  readonly precioUnitario: number;
  readonly costoUnitario: number;
  readonly cantidad: number;
  /**
   * Stock actual del producto, ya incluido en la línea del pedido. Así el
   * detalle es legible también para `GESTOR_PEDIDOS`, que no tiene permiso
   * sobre `/api/admin/products` (esa ruta expone costo y margen, que no son
   * de su incumbencia). `null` si el producto se borró del catálogo.
   */
  readonly stockDisponible: number | null;
  /**
   * Si esta línea es una canasta, qué llevaba dentro — con la receta
   * **congelada** el día que se vendió, no la de hoy. Ausente en un producto
   * simple; es lo que distingue una línea de la otra.
   */
  readonly contiene?: readonly {
    readonly nombre: string;
    readonly cantidad: number;
    readonly unidad: string;
    readonly cantidadUnidad: number;
  }[];
}

export interface ApiOrderStatusLogEntry {
  readonly estado:
    | 'verificacion' | 'pendiente' | 'aprobado' | 'enviado' | 'cancelado' | 'editado'
    | 'pago' | 'liquidado' | 'rechazado';
  readonly actorId: string | null;
  /** Nombre del cliente en la creación; nombre del admin en el resto de pasos. */
  readonly actorNombre: string | null;
  readonly creadoEn: string;
}

export interface ApiOrder {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  readonly estado: 'verificacion' | 'pendiente' | 'aprobado' | 'enviado' | 'cancelado' | 'pago';
  readonly stockReservado: number;
  readonly subtotal: number;
  readonly envio: number;
  readonly total: number;
  readonly comprobanteNombre?: string | null;
  /**
   * Si el pedido trae comprobante adjunto. La imagen **no** viaja en el
   * listado: vive en Workers KV y se pide aparte con `orderReceipt()` solo
   * cuando el admin abre ese pedido concreto.
   */
  readonly tieneComprobante?: number | null;
  readonly aprobadoEn?: string | null;
  readonly metodoPago: 'transferencia' | 'contraentrega' | 'credito';
  /** Solo importa para contra entrega — ver la migración 0015. */
  readonly efectivoLiquidado: number;
  /**
   * Cuándo vence la deuda. Solo en 'credito'; `null` en el resto, donde no
   * hay nada que vencer porque el dinero ya entró o se cobra en la puerta.
   */
  readonly venceEn: string | null;
  readonly closingId: string | null;
  readonly creadoEn: string;
  readonly items: readonly ApiOrderItem[];
}

/**
 * Un pedido 'enviado' pendiente en la calle, tal como lo ve un domiciliario.
 *
 * `metodoPago` decide qué le falta: a un contra entrega hay que cobrarle
 * (`markOrderPaid`), a cualquier otro solo confirmarle la entrega
 * (`confirmDelivery`) — no trae nada que cobrar.
 */
export interface ApiDelivery {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  readonly total: number;
  readonly creadoEn: string;
  readonly metodoPago: 'transferencia' | 'contraentrega' | 'credito';
  readonly items: readonly {
    readonly productoNombre: string;
    readonly precioUnitario: number;
    readonly cantidad: number;
  }[];
}

export interface ApiSalesRow {
  readonly productId: string;
  readonly nombre: string;
  readonly unidades: number;
  readonly ingresos: number;
  readonly costo: number;
  readonly ganancia: number;
  readonly pedidos: number;
  readonly origen: string;
  readonly grupoAdmin: string;
  readonly stockRestante: number;
  readonly imagen: string;
  readonly imagenAlt: string;
  readonly categoriaAbc: 'A' | 'B' | 'C';
  readonly participacion: number;
}

export interface ApiCashSummary {
  readonly pedidos: number;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
  readonly ganancia: number;
  readonly enviosCobrados: number;
  readonly totalRecaudado: number;
  readonly porMetodo: readonly { metodo: string; pedidos: number; total: number }[];
}

/** Una fila de la pantalla de tarifas: el producto y su descuento en un nivel. */
export interface ApiWholesaleRow {
  readonly productId: string;
  readonly nombre: string;
  readonly categoriaId: string;
  readonly grupoAdmin: string;
  readonly unidad: string;
  readonly cantidadUnidad: number;
  readonly precio: number;
  readonly precioCosto: number;
  readonly activo: number;
  /** `null` = sin trato especial en este nivel. */
  readonly porcentaje: number | null;
  readonly precioMayorista: number;
  readonly actualizadoEn: string | null;
}

export interface ApiWholesaleTariff {
  readonly role: WholesaleRole;
  readonly products: readonly ApiWholesaleRow[];
  readonly resumen: {
    readonly conDescuento: number;
    readonly total: number;
    /** Productos cuya tarifa queda por debajo del costo de la finca. */
    readonly bajoCosto: number;
  };
}

/** Una línea del consolidado: cuánto hay que cosechar de un producto. */
export interface ApiConsolidationProduct {
  readonly productId: string;
  readonly nombre: string;
  /** Presentaciones vendidas, no unidades de medida. */
  readonly cantidadTotal: number;
  readonly pedidos: number;
  readonly unidad: string;
  /** Cuánto lleva cada presentación: 500 con `unidad: 'gr'`. */
  readonly cantidadUnidad: number;
  readonly grupoAdmin: string;
  /** Categoría fina (lácteos, mieles, verduras…), no solo el grupo macro. */
  readonly categoriaId: string;
  readonly origen: string;
}

/** Un pedido en la hoja de ruta, con el domicilio ya auditado. */
/** Una canasta a armar, con cuántas y para cuántos pedidos. */
export interface ApiConsolidationBasket {
  readonly productId: string;
  readonly nombre: string;
  readonly cantidadTotal: number;
  readonly pedidos: number;
}

export interface ApiConsolidationOrder {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  readonly estado: string;
  readonly subtotal: number;
  readonly envio: number;
  readonly total: number;
  readonly unidades: number;
  readonly creadoEn: string;
  readonly cobroEnvio: boolean;
  /** Lo que la regla vigente dice que debió cobrarse. */
  readonly envioEsperado: number;
  readonly envioCorrecto: boolean;
  readonly diferenciaEnvio: number;
}

export interface ApiConsolidation {
  readonly ventana: {
    readonly desde: string | null;
    readonly hasta: string | null;
    readonly soloJornadaAbierta: boolean;
    readonly estados: readonly string[];
  };
  readonly regla: {
    readonly umbralEnvioGratis: number;
    readonly costoEnvio: number;
  };
  readonly productos: readonly ApiConsolidationProduct[];
  /**
   * Canastas a armar. **No se suman a `productos`**: sus componentes ya están
   * repartidos ahí como cantidades a cosechar, y contarlos otra vez duplicaría
   * el mismo tomate. Esta lista es para quien empaca, no para quien cosecha.
   */
  readonly canastas: readonly ApiConsolidationBasket[];
  readonly pedidos: readonly ApiConsolidationOrder[];
  readonly domicilios: {
    readonly pedidos: number;
    readonly conCobro: number;
    readonly sinCobro: number;
    readonly totalRecaudado: number;
    readonly diferencia: number;
    readonly descuadres: number;
  };
  readonly totales: {
    readonly pedidos: number;
    readonly referencias: number;
    readonly unidades: number;
    readonly ventaProducto: number;
  };
  /** Pedidos sin aprobar en la misma ventana: no entran, pero avisan. */
  readonly pendientes: {
    readonly pedidos: number;
    readonly subtotal: number;
  };
}

/** Una línea del detalle de un cierre: el pedido tal y como entró en la caja. */
export interface ApiClosingOrder {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly estado: 'verificacion' | 'pendiente' | 'aprobado' | 'enviado';
  readonly envio: number;
  readonly creadoEn: string;
  readonly aprobadoEn: string | null;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
}

/** Categorías del CHECK de `expenses`. Fuera de estas, D1 rechaza la fila. */
export type ExpenseCategory = 'transporte' | 'empaque' | 'servicios' | 'otros';

/**
 * Un gasto operativo de la jornada.
 *
 * `closingId` es toda la máquina de estados que tiene: `null` mientras la
 * jornada está abierta —y entonces se puede borrar— y con valor una vez el
 * cierre lo adoptó, cuando ya es parte de una cuenta congelada.
 */
export interface ApiExpense {
  readonly id: string;
  readonly descripcion: string;
  readonly monto: number;
  readonly categoria: ExpenseCategory;
  readonly creadoEn: string;
  readonly creadoPor: string | null;
  readonly closingId: string | null;
}

/** Una línea de compra: qué producto, cuánto y a qué costo se negoció. */
export interface ApiPurchaseItem {
  readonly productId: string;
  readonly productoNombre: string;
  readonly unidad: string;
  readonly cantidad: number;
  /** El costo pactado ese día, congelado. Puede diferir del catálogo de hoy. */
  readonly costoUnitario: number;
  readonly subtotal: number;
}

/**
 * Una compra a una finca.
 *
 * Registrarla sube el inventario y fija `products.precio_costo`. NO se resta
 * de la ganancia: ese costo ya se cuenta al vender, cuando viaja congelado a
 * la línea del pedido. Ver `worker/src/routes/purchases.ts`.
 */
export interface ApiPurchase {
  readonly id: string;
  /** Texto de `products.origen`, copiado al comprar. No es una referencia. */
  readonly origen: string;
  /** Suma del detalle, calculada por el servidor. */
  readonly totalPago: number;
  /** 'pendiente' = la mercancía entró pero al agricultor no se le ha girado. */
  readonly estado: 'pendiente' | 'pagado';
  readonly notas: string | null;
  readonly creadoEn: string;
  readonly creadoPor: string | null;
  readonly pagadoEn: string | null;
  readonly pagadoPor: string | null;
  readonly items: readonly ApiPurchaseItem[];
}

/** Lo que el formulario manda por línea. El servidor recalcula los totales. */
export interface PurchaseItemInput {
  readonly productId: string;
  readonly cantidad: number;
  readonly costoUnitario: number;
}

export interface ApiClosing {
  readonly id: string;
  readonly referencia: string;
  readonly cerradoEn: string;
  readonly cerradoPor: string;
  readonly pedidos: number;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
  /** Venta − costo de mercancía − gastos. Lo que quedó de verdad. */
  readonly ganancia: number;
  /** Congelado como dato operativo. No suma a nada — ver migración 0019. */
  readonly enviosCobrados: number;
  readonly totalRecaudado: number;
  /** Gastos operativos de la jornada. Ya restados en `ganancia`. */
  readonly totalGastos: number;
}

/**
 * Una deuda viva de un mayorista: pedido a crédito entregado y sin pagar.
 *
 * `diasVencido` y `tramo` los calcula el Worker contra el reloj de la base,
 * no el navegador: si los calculara cada cliente, dos personas en husos
 * distintos verían vencida la misma factura en días distintos.
 */
export interface ApiCarteraRow {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  /** Solo producto: el domicilio va aparte, en `envio`. */
  readonly total: number;
  /** Domicilio cobrado. No es venta, pero el mayorista sí lo debe: al cobrar
   *  hay que pedir `total + envio`. */
  readonly envio: number;
  readonly venceEn: string | null;
  readonly creadoEn: string;
  readonly estado: string;
  /** Negativo = aún no vence. Positivo = días de mora. `null` = sin fecha. */
  readonly diasVencido: number | null;
  readonly tramo: 'corriente' | '30' | '60' | '90';
}

/** Efectivo contra entrega ya cobrado por un domiciliario, pendiente de liquidar. */
export interface ApiCodPending {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  /** Solo producto: el domicilio va aparte, en `envio`. */
  readonly total: number;
  /** Domicilio cobrado. No es venta, pero el efectivo que trae el
   *  domiciliario sí lo incluye: al cuadrar hay que contar `total + envio`. */
  readonly envio: number;
  /** Quién y cuándo lo cobró. `null` si el pedido es de antes de este flujo. */
  readonly cobradoPor: string | null;
  readonly cobradoEn: string | null;
}

/**
 * Cliente HTTP del Worker.
 *
 * Las URLs son **relativas**: en producción el mismo Worker sirve la SPA y la
 * API, así que no hay CORS ni dominio que configurar. En desarrollo,
 * `proxy.conf.json` reenvía `/api` al `wrangler dev` local.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly tokens = inject(TokenStore);

  // ──────────────────────────────── Auth ────────────────────────────────

  /** Sitekey pública de Turnstile. Vacía = no está configurada en el servidor. */
  config(): Observable<{ turnstileSiteKey: string }> {
    return this.http
      .get<{ turnstileSiteKey: string }>('/api/config')
      .pipe(catchError(handleError));
  }

  login(email: string, password: string, turnstileToken?: string | null): Observable<ApiSession> {
    return this.http
      .post<ApiSession>('/api/auth/login', { email, password, turnstileToken })
      .pipe(
        tap((session) => this.tokens.set(session)),
        catchError(handleError),
      );
  }

  logout(): void {
    this.tokens.clear();
  }

  /**
   * Pide un enlace de recuperación.
   *
   * Responde 200 exista o no la cuenta, a propósito: la interfaz muestra el
   * mismo mensaje en ambos casos para no convertir esta pantalla en un censo
   * de correos registrados.
   */
  requestPasswordReset(email: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>('/api/auth/recuperar', { email })
      .pipe(catchError(handleError));
  }

  /** Cambia la contraseña con el token que llegó por correo. */
  resetPassword(token: string, nueva: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>('/api/auth/restablecer', { token, nueva })
      .pipe(catchError(handleError));
  }

  /** Cambia la contraseña de la sesión actual. Exige la vigente. */
  changeOwnPassword(actual: string, nueva: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>('/api/auth/password', { actual, nueva })
      .pipe(catchError(handleError));
  }

  // ──────────────────────────── Usuarios ────────────────────────────

  users(): Observable<readonly ApiUser[]> {
    return this.http
      .get<{ users: ApiUser[] }>('/api/admin/users')
      .pipe(map((res) => res.users), catchError(handleError));
  }

  createUser(input: {
    email: string;
    nombre: string;
    password: string;
    roles: readonly UserRole[];
  }): Observable<ApiUser> {
    return this.http
      .post<{ user: ApiUser }>('/api/admin/users', input)
      .pipe(map((res) => res.user), catchError(handleError));
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
    return this.http
      .patch<{ user: ApiUser }>(`/api/admin/users/${id}`, patch)
      .pipe(map((res) => res.user), catchError(handleError));
  }

  // ───────────────────────────── Categorías ─────────────────────────────

  /** Los chips de la vitrina. Solo las activas. */
  categories(): Observable<readonly ApiCategory[]> {
    return this.http
      .get<{ categories: ApiCategory[] }>('/api/categories')
      .pipe(map((res) => res.categories), catchError(handleError));
  }

  /** Todas, con cuántos productos cuelgan de cada una. */
  adminCategories(): Observable<readonly ApiCategory[]> {
    return this.http
      .get<{ categories: ApiCategory[] }>('/api/admin/categories')
      .pipe(map((res) => res.categories), catchError(handleError));
  }

  createCategory(input: {
    nombre: string;
    /** Se deduce del nombre si no se manda. */
    id?: string;
    descripcion?: string;
    icono?: string;
    grupoAdmin?: 'frutas' | 'verduras' | 'agroindustriales';
    orden?: number;
    activo?: 0 | 1;
  }): Observable<ApiCategory> {
    return this.http
      .post<{ category: ApiCategory }>('/api/admin/categories', input)
      .pipe(map((res) => res.category), catchError(handleError));
  }

  /** El `id` no se puede cambiar: es por donde apuntan los productos. */
  updateCategory(
    id: string,
    patch: Partial<{
      nombre: string;
      descripcion: string;
      icono: string;
      grupoAdmin: 'frutas' | 'verduras' | 'agroindustriales';
      orden: number;
      activo: 0 | 1;
    }>,
  ): Observable<ApiCategory> {
    return this.http
      .put<{ category: ApiCategory }>(`/api/admin/categories/${id}`, patch)
      .pipe(map((res) => res.category), catchError(handleError));
  }

  /** Falla con `categoria-en-uso` si todavía quedan productos dentro. */
  deleteCategory(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/categories/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ─────────────────────── Canastas, combos y mixes ───────────────────────

  /**
   * La receta de una canasta: qué productos la llenan y cuántos de cada uno.
   *
   * `armables` es `null` cuando el producto no tiene receta —entonces es un
   * producto normal con su propio stock— y un número cuando sí la tiene: lo
   * manda el componente que primero se agote.
   */
  productComponents(productId: string): Observable<ApiRecipe> {
    return this.http
      .get<ApiRecipe>(`/api/admin/products/${productId}/componentes`)
      .pipe(catchError(handleError));
  }

  /** Añade un componente o corrige su cantidad. Repetirlo deja lo mismo. */
  setProductComponent(
    productId: string,
    childId: string,
    cantidad: number,
  ): Observable<ApiRecipe> {
    return this.http
      .put<ApiRecipe>(`/api/admin/products/${productId}/componentes`, { childId, cantidad })
      .pipe(catchError(handleError));
  }

  /** Al quitar el último, el producto deja de ser canasta. */
  removeProductComponent(productId: string, childId: string): Observable<ApiRecipe> {
    return this.http
      .delete<ApiRecipe>(`/api/admin/products/${productId}/componentes/${childId}`)
      .pipe(catchError(handleError));
  }

  // ────────────────────────────── Catálogo ──────────────────────────────

  products(): Observable<readonly ApiProduct[]> {
    return this.http
      .get<{ products: ApiProduct[] }>('/api/products')
      .pipe(map((res) => res.products), catchError(handleError));
  }

  adminProducts(): Observable<readonly ApiProduct[]> {
    return this.http
      .get<{ products: ApiProduct[] }>('/api/admin/products')
      .pipe(map((res) => res.products), catchError(handleError));
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
    /** Id del producto sombrilla: nace ya como variante suya. */
    parentId?: string | null;
    /** Solo tiene efecto en las madres: 'presentación', 'sabor'… */
    varianteEtiqueta?: string | null;
  }): Observable<ApiProduct> {
    return this.http
      .post<{ product: ApiProduct }>('/api/admin/products', input)
      .pipe(map((res) => res.product), catchError(handleError));
  }

  /** Crea una variante a medio hacer a partir de otro producto. */
  duplicateProduct(id: string): Observable<ApiProduct> {
    return this.http
      .post<{ product: ApiProduct }>(`/api/admin/products/${id}/duplicar`, {})
      .pipe(map((res) => res.product), catchError(handleError));
  }

  updateProduct(
    id: string,
    patch: Partial<{
      precio: number;
      precioCosto: number;
      stock: number;
      stockSeguridad: number;
      /** 1 = se ofrece esta semana · 0 = sin oferta del agricultor. */
      activo: 0 | 1;
    }>,
  ): Observable<ApiProduct> {
    return this.http
      .patch<{ product: ApiProduct }>(`/api/admin/products/${id}`, patch)
      .pipe(map((res) => res.product), catchError(handleError));
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
    /**
     * `null` desliga la variante y la deja suelta; **omitirlo** deja el vínculo
     * como esté. El Worker distingue los dos casos a propósito, para que un
     * formulario que no conozca este campo no pueda soltar variantes de su
     * madre al guardar un cambio de precio.
     */
    parentId?: string | null;
    varianteEtiqueta?: string | null;
  }): Observable<ApiProduct> {
    return this.http
      .put<{ product: ApiProduct }>(`/api/admin/products/${id}`, input)
      .pipe(map((res) => res.product), catchError(handleError));
  }

  // ─────────────────────────────── Pedidos ───────────────────────────────

  createOrder(input: {
    clienteNombre: string;
    clienteTelefono: string;
    clienteDireccion: string;
    envio: number;
    items: readonly { productId: string; cantidad: number }[];
    comprobanteNombre?: string;
    /** Data URL del comprobante ya comprimido (ver `shared/utils/image-file.ts`). */
    comprobanteUrl?: string;
    /**
     * Se omite en transferencia: 'transferencia' es el default del servidor.
     *
     * 'credito' no cabe aquí a propósito: fiar es una decisión del panel sobre
     * una cuenta con cupo, no algo que se elija en el checkout. El Worker lo
     * vuelve a comprobar con lista blanca por si alguien llama a la API a mano.
     */
    metodoPago?: 'transferencia' | 'contraentrega';
  }): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>('/api/orders', input)
      .pipe(map((res) => res.order), catchError(handleError));
  }

  orders(params: { estado?: string; abiertos?: boolean } = {}): Observable<readonly ApiOrder[]> {
    const query = new URLSearchParams();
    if (params.estado) query.set('estado', params.estado);
    if (params.abiertos) query.set('abiertos', '1');

    return this.http
      .get<{ orders: ApiOrder[] }>(`/api/admin/orders?${query.toString()}`)
      .pipe(map((res) => res.orders), catchError(handleError));
  }

  approveOrder(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/aprobar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  cancelOrder(
    id: string,
    motivo?: string,
  ): Observable<{ order: ApiOrder; unidadesDevueltas: number }> {
    return this.http
      .post<{ order: ApiOrder; unidadesDevueltas: number }>(
        `/api/admin/orders/${id}/cancelar`,
        { motivo },
      )
      .pipe(catchError(handleError));
  }

  /** Borra un pedido del todo. Ver en el Worker qué casos no permite. */
  deleteOrder(id: string): Observable<{ ok: boolean; referencia: string; unidadesDevueltas: number }> {
    return this.http
      .delete<{ ok: boolean; referencia: string; unidadesDevueltas: number }>(
        `/api/admin/orders/${id}`,
      )
      .pipe(catchError(handleError));
  }

  shipOrder(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/enviar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** El domiciliario (o un admin de respaldo) marca que cobró un pedido contra entrega. */
  markOrderPaid(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/pagar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * El domiciliario confirma que entregó un pedido que NO es contra entrega
   * (ya venía pagado por transferencia). No hay nada que cobrar, así que a
   * diferencia de `markOrderPaid` esto no mueve `estado`, solo anota cuándo.
   */
  confirmDelivery(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/entregar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * Fía este pedido al mayorista que lo hizo. El Worker comprueba el cupo y
   * calcula el vencimiento con el plazo de esa cuenta.
   */
  grantCredit(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/credito`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * El mayorista pagó lo que debía.
   *
   * Endpoint propio y no `markOrderPaid`: a ese llega un DOMICILIARIO, que no
   * puede certificar una transferencia que no presenció. Ver collectCredit()
   * en el Worker.
   */
  collectCredit(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/recaudar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** Un admin confirma que el efectivo cobrado ya está físicamente en la finca. */
  settleOrderCash(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/liquidar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** El cliente rechazó el pedido en la puerta: devuelve el stock, como cancelar. */
  rejectDelivery(
    id: string,
    motivo?: string,
  ): Observable<{ order: ApiOrder; unidadesDevueltas: number }> {
    return this.http
      .post<{ order: ApiOrder; unidadesDevueltas: number }>(
        `/api/admin/orders/${id}/rechazar-entrega`,
        { motivo },
      )
      .pipe(catchError(handleError));
  }

  /** Pedidos contra entrega 'enviado', para la vista del domiciliario. Sin costo ni margen. */
  deliveries(): Observable<readonly ApiDelivery[]> {
    return this.http
      .get<{ entregas: ApiDelivery[] }>('/api/admin/entregas')
      .pipe(map((res) => res.entregas), catchError(handleError));
  }

  /**
   * Reemplaza las líneas de un pedido por la lista completa que se le pasa.
   * El Worker calcula el diff contra lo guardado: aquí no hace falta decir
   * qué se añadió, quitó o cambió, solo cómo debe quedar el pedido al final.
   */
  updateOrderItems(
    id: string,
    items: readonly { productId: string; cantidad: number }[],
  ): Observable<ApiOrder> {
    return this.http
      .patch<{ order: ApiOrder }>(`/api/admin/orders/${id}/items`, { items })
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** Traza de estados del pedido, para soporte postventa por WhatsApp. */
  orderHistory(id: string): Observable<readonly ApiOrderStatusLogEntry[]> {
    return this.http
      .get<{ history: ApiOrderStatusLogEntry[] }>(`/api/admin/orders/${id}/historial`)
      .pipe(map((res) => res.history), catchError(handleError));
  }

  /**
   * Imagen del comprobante, desde Workers KV.
   *
   * Llega como `Blob` y no como URL porque el endpoint exige el JWT: un
   * `<img src="/api/...">` no pasa por el interceptor y respondería 401. El
   * componente convierte este blob en una object URL para pintarlo.
   */
  orderReceipt(id: string): Observable<Blob> {
    return this.http
      .get(`/api/admin/orders/${id}/comprobante`, { responseType: 'blob' })
      .pipe(catchError(handleBlobError));
  }

  // ─────────────────────────────── Reportes ───────────────────────────────

  salesReport(): Observable<{
    products: readonly ApiSalesRow[];
    totals: { unidades: number; ingresos: number; costo: number; ganancia: number };
  }> {
    return this.http
      .get<{
        products: ApiSalesRow[];
        totals: { unidades: number; ingresos: number; costo: number; ganancia: number };
      }>('/api/admin/reports/sales')
      .pipe(catchError(handleError));
  }

  // ─────────────────────────── Tarifas de mayorista ───────────────────────────

  /** Catálogo completo con el descuento de ese nivel donde lo haya. */
  wholesaleTariff(role: WholesaleRole): Observable<ApiWholesaleTariff> {
    return this.http
      .get<ApiWholesaleTariff>(`/api/admin/wholesale/${role}`)
      .pipe(catchError(handleError));
  }

  /** Fija el descuento de un producto. `0` retira la tarifa. */
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
    return this.http
      .put<{
        productId: string;
        role: WholesaleRole;
        porcentaje: number | null;
        precioMayorista: number;
        bajoCosto: boolean;
      }>(`/api/admin/wholesale/${role}/${productId}`, { porcentaje })
      .pipe(catchError(handleError));
  }

  /** Mismo descuento a varios productos, en una sola transacción. */
  setWholesaleBulk(
    role: WholesaleRole,
    productIds: readonly string[],
    porcentaje: number,
  ): Observable<{ role: WholesaleRole; porcentaje: number | null; aplicados: number }> {
    return this.http
      .put<{ role: WholesaleRole; porcentaje: number | null; aplicados: number }>(
        `/api/admin/wholesale/${role}`,
        { productIds, porcentaje },
      )
      .pipe(catchError(handleError));
  }

  /**
   * Consolidado semanal. Sin fechas trae la jornada abierta —lo que se cosecha
   * para el próximo domingo—; con ellas, el rango pedido.
   */
  consolidation(range: { desde?: string; hasta?: string } = {}): Observable<ApiConsolidation> {
    const query = new URLSearchParams();
    if (range.desde) query.set('desde', range.desde);
    if (range.hasta) query.set('hasta', range.hasta);
    const suffix = query.toString() ? `?${query.toString()}` : '';

    return this.http
      .get<ApiConsolidation>(`/api/admin/reports/consolidation${suffix}`)
      .pipe(catchError(handleError));
  }

  cashSummary(): Observable<ApiCashSummary> {
    return this.http
      .get<ApiCashSummary>('/api/admin/reports/cash')
      .pipe(catchError(handleError));
  }

  closeCash(): Observable<{ closing: ApiClosing; pedidosArchivados: number }> {
    return this.http
      .post<{ closing: ApiClosing; pedidosArchivados: number }>('/api/admin/reports/cash/close', {})
      .pipe(catchError(handleError));
  }

  closings(): Observable<readonly ApiClosing[]> {
    return this.http
      .get<{ closings: ApiClosing[] }>('/api/admin/reports/closings')
      .pipe(map((res) => res.closings), catchError(handleError));
  }

  /**
   * Pedidos que componen un cierre pasado.
   *
   * Sale de `orders.closing_id`, la FK que el propio cierre puso al archivar.
   * No hay copia de la lista en ningún otro sitio: la relación se consulta,
   * no se duplica.
   */
  closingOrders(id: string): Observable<readonly ApiClosingOrder[]> {
    return this.http
      .get<{ orders: ApiClosingOrder[] }>(`/api/admin/reports/closings/${id}/pedidos`)
      .pipe(map((res) => res.orders), catchError(handleError));
  }

  /** Lo que los mayoristas deben, con su antigüedad ya calculada por el Worker. */
  cartera(): Observable<readonly ApiCarteraRow[]> {
    return this.http
      .get<{ deudores: ApiCarteraRow[] }>('/api/admin/reports/cartera')
      .pipe(map((res) => res.deudores), catchError(handleError));
  }

  /** Efectivo contra entrega ya cobrado, esperando que un admin lo liquide. */
  codPending(): Observable<readonly ApiCodPending[]> {
    return this.http
      .get<{ pendientes: ApiCodPending[] }>('/api/admin/reports/cod-pendiente')
      .pipe(map((res) => res.pendientes), catchError(handleError));
  }

  // ──────────────── Gastos operativos y pago a las fincas ────────────────

  /**
   * Gastos de un cierre, o los de la jornada abierta si no se pasa `closingId`.
   *
   * Sin cierre son los que todavía se pueden borrar y los que entrarán al
   * próximo; con cierre, los ya archivados, para auditar su `totalGastos`.
   */
  expenses(closingId?: string): Observable<readonly ApiExpense[]> {
    const query = closingId ? `?closing_id=${encodeURIComponent(closingId)}` : '';
    return this.http
      .get<{ gastos: ApiExpense[] }>(`/api/admin/expenses${query}`)
      .pipe(map((res) => res.gastos), catchError(handleError));
  }

  createExpense(gasto: {
    descripcion: string;
    monto: number;
    categoria: ExpenseCategory;
  }): Observable<ApiExpense> {
    return this.http
      .post<{ gasto: ApiExpense }>('/api/admin/expenses', gasto)
      .pipe(map((res) => res.gasto), catchError(handleError));
  }

  /** Solo funciona mientras el gasto siga sin cierre. El Worker manda. */
  deleteExpense(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/expenses/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ─────────────────────── Compras a las fincas ───────────────────────

  /** Historial de compras, con su detalle dentro. Filtros opcionales. */
  purchases(options?: {
    origen?: string;
    estado?: 'pendiente' | 'pagado';
  }): Observable<readonly ApiPurchase[]> {
    const params = new URLSearchParams();
    if (options?.origen) {
      params.set('origen', options.origen);
    }
    if (options?.estado) {
      params.set('estado', options.estado);
    }
    const query = params.toString() ? `?${params}` : '';

    return this.http
      .get<{ compras: ApiPurchase[] }>(`/api/admin/providers/purchases${query}`)
      .pipe(map((res) => res.compras), catchError(handleError));
  }

  /** Registra la compra: sube el inventario y fija el costo del catálogo. */
  createPurchase(compra: {
    origen: string;
    notas: string | null;
    items: readonly PurchaseItemInput[];
  }): Observable<ApiPurchase> {
    return this.http
      .post<{ compra: ApiPurchase }>('/api/admin/providers/purchases', compra)
      .pipe(map((res) => res.compra), catchError(handleError));
  }

  /**
   * Corrige una compra. El servidor devuelve al inventario lo anterior y suma
   * lo nuevo; si lo anterior ya se vendió, responde `stock-ya-vendido`.
   */
  updatePurchase(
    id: string,
    compra: { origen: string; notas: string | null; items: readonly PurchaseItemInput[] },
  ): Observable<ApiPurchase> {
    return this.http
      .patch<{ compra: ApiPurchase }>(`/api/admin/providers/purchases/${id}`, compra)
      .pipe(map((res) => res.compra), catchError(handleError));
  }

  /** Borra la compra y devuelve su mercancía al inventario. */
  deletePurchase(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/providers/purchases/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  /** Se le giró al agricultor. Solo cambia el estado: el stock ya entró. */
  markPurchasePaid(id: string): Observable<ApiPurchase> {
    return this.http
      .post<{ compra: ApiPurchase }>(`/api/admin/providers/purchases/${id}/pagar`, {})
      .pipe(map((res) => res.compra), catchError(handleError));
  }
}

/**
 * Normaliza el error para que los componentes reciban siempre un `ApiErrorBody`
 * y puedan discriminar por `code` (por ejemplo `stock-insuficiente`) en vez de
 * comparar textos, que cambian con cualquier retoque de copy.
 */
function handleError(response: HttpErrorResponse): Observable<never> {
  const body = response.error as { error?: ApiErrorBody } | null;

  if (body?.error?.code) {
    return throwError(() => body.error as ApiErrorBody);
  }

  // Error de red, o el servidor devolvió algo que no es nuestro JSON.
  return throwError(() => ({
    code: response.status === 0 ? 'sin-conexion' : 'error-desconocido',
    message:
      response.status === 0
        ? 'No se pudo contactar el servidor. Revisa tu conexión.'
        : `El servidor respondió ${response.status}.`,
  } satisfies ApiErrorBody));
}

/**
 * Variante para las respuestas `responseType: 'blob'`.
 *
 * Cuando la petición pide un blob, Angular entrega también el **cuerpo del
 * error** como blob, así que el `{ error: { code } }` del Worker no se puede
 * leer de forma síncrona. Se traduce por código de estado, que para este
 * endpoint alcanza: lo único que el panel necesita distinguir es "no hay
 * comprobante" de "no hay permiso" o "se cayó la conexión".
 */
function handleBlobError(response: HttpErrorResponse): Observable<never> {
  const byStatus: Record<number, ApiErrorBody> = {
    0: { code: 'sin-conexion', message: 'No se pudo contactar el servidor.' },
    401: { code: 'sesion-expirada', message: 'Tu sesión expiró. Vuelve a entrar.' },
    403: { code: 'sin-permiso', message: 'No tienes permiso para ver este comprobante.' },
    404: { code: 'sin-comprobante', message: 'Este pedido no tiene comprobante adjunto.' },
  };

  return throwError(
    () =>
      byStatus[response.status] ?? {
        code: 'error-desconocido',
        message: `El servidor respondió ${response.status}.`,
      },
  );
}
