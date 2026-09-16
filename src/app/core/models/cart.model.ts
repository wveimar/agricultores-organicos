import { Product, ProductSession } from './product.model';

export interface CartItem {
  readonly product: Product;
  readonly quantity: number;
  /**
   * Qué sesión reservó esta línea, solo cuando `product.type === 'servicio'`.
   * Se guarda la sesión completa (no solo el id) porque el carrito la pinta
   * —fecha, cupo— sin volver a consultar el catálogo.
   */
  readonly session?: ProductSession;
}

/** Umbral (COP) a partir del cual el envío deja de cobrarse. */
export const FREE_SHIPPING_THRESHOLD = 70_000;

/** Costo de envío en Marinilla cuando el subtotal no alcanza el umbral. */
export const SHIPPING_COST = 5_000;
