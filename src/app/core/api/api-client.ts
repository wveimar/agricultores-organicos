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
  readonly comprobanteUrl?: string | null;
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

  login(email: string, password: string): Observable<ApiSession> {
    return this.http
      .post<ApiSession>('/api/auth/login', { email, password })
      .pipe(
        tap((session) => this.tokens.set(session)),
        catchError(handleError),
      );
  }

  logout(): void {
    this.tokens.clear();
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

  updateProduct(
    id: string,
    patch: Partial<{ precio: number; precioCosto: number; stock: number; stockSeguridad: number }>,
  ): Observable<ApiProduct> {
    return this.http
      .patch<{ product: ApiProduct }>(`/api/admin/products/${id}`, patch)
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

  shipOrder(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/enviar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
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
