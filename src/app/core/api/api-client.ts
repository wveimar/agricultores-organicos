import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, tap, throwError } from 'rxjs';
import { ApiSession, TokenStore } from './token-store';
import { UserRole } from '../models/user.model';
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
  readonly origen: string;
  readonly rating: number;
  readonly reviewCount: number;
  readonly badge: string | null;
  readonly stock: number;
  readonly imagen: string;
  readonly imagenHover: string | null;
  readonly imagenAlt: string;
  /** Solo en las respuestas de /api/admin/*. */
  readonly precioCosto?: number;
  readonly stockSeguridad?: number;
  readonly categoriaAbc?: 'A' | 'B' | 'C';
  readonly margenUnitario?: number;
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
    price: p.precio,
    compareAtPrice: p.precioAnterior ?? undefined,
    costPrice: p.precioCosto ?? 0,
    unit: p.unidad as ProductUnit,
    origin: p.origen,
    rating: p.rating,
    reviewCount: p.reviewCount,
    badge: (p.badge as ProductBadge | null) ?? undefined,
    stock: p.stock,
    safetyStock: p.stockSeguridad ?? 0,
    image: p.imagen,
    imageHover: p.imagenHover ?? undefined,
    imageAlt: p.imagenAlt,
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
}

export interface ApiOrderStatusLogEntry {
  readonly estado: 'verificacion' | 'pendiente' | 'aprobado' | 'enviado';
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
  readonly estado: 'verificacion' | 'pendiente' | 'aprobado' | 'enviado';
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
  readonly closingId: string | null;
  readonly creadoEn: string;
  readonly items: readonly ApiOrderItem[];
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

export interface ApiClosing {
  readonly id: string;
  readonly referencia: string;
  readonly cerradoEn: string;
  readonly cerradoPor: string;
  readonly pedidos: number;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
  readonly ganancia: number;
  readonly enviosCobrados: number;
  readonly totalRecaudado: number;
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
    origen: string;
    imagen: string;
    imagenHover?: string;
    imagenAlt: string;
  }): Observable<ApiProduct> {
    return this.http
      .post<{ product: ApiProduct }>('/api/admin/products', input)
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
    origen: string;
    imagen: string;
    imagenHover?: string;
    imagenAlt: string;
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

  shipOrder(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/enviar`, {})
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
