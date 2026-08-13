import { Product } from './product.model';

export interface CartItem {
  readonly product: Product;
  readonly quantity: number;
}

/** Umbral (COP) a partir del cual el envío deja de cobrarse. */
export const FREE_SHIPPING_THRESHOLD = 70_000;

/** Costo de envío en Marinilla cuando el subtotal no alcanza el umbral. */
export const SHIPPING_COST = 5_000;
