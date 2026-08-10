import { AdminGroup, CategoryId } from './product.model';

/**
 * Clasificación ABC de control de inventario: se ordenan los productos por
 * ingresos y se acumula el porcentaje.
 *
 * - **A**: hasta el 80 % acumulado. Poca referencias, casi toda la plata.
 * - **B**: del 80 % al 95 %.
 * - **C**: el resto — mucha referencia y poco ingreso.
 *
 * Sirve para decidir qué nunca puede faltar en bodega.
 */
export type AbcClass = 'A' | 'B' | 'C';

/** Fila del resumen de ventas por producto. */
export interface ProductSales {
  readonly productId: string;
  readonly name: string;
  readonly image: string;
  readonly imageAlt: string;
  /** Finca que lo cosechó: la trazabilidad es parte del producto, no un extra. */
  readonly origin: string;
  readonly categoryId: CategoryId;
  readonly group: AdminGroup;
  readonly units: number;
  readonly revenue: number;
  /** Existencias que quedan hoy, para cruzar venta contra reposición. */
  readonly stock: number;
  /** En cuántos pedidos distintos apareció. */
  readonly orderCount: number;
  readonly abc: AbcClass;
  /** Participación en los ingresos, 0–1. */
  readonly revenueShare: number;
}

/**
 * Método de recaudo. Hoy solo existe consignación bancaria porque el checkout
 * es manual, pero se modela como lista para que añadir efectivo o datáfono no
 * obligue a cambiar la forma del cierre.
 */
export type PaymentMethod = 'consignacion';

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  consignacion: 'Consignación bancaria',
};

export interface MethodTotal {
  readonly method: PaymentMethod;
  readonly orderCount: number;
  readonly total: number;
}

/**
 * Cierre de jornada. Es un documento histórico: congela las cifras del momento
 * en que se cerró, no se recalcula después. Si mañana cambia un precio, un
 * cierre viejo debe seguir diciendo lo que se recaudó ese día.
 */
export interface CashClosing {
  readonly id: string;
  readonly reference: string;
  readonly closedAt: string;
  readonly closedBy: string;
  readonly orderCount: number;
  readonly unitCount: number;
  /** Venta de producto, sin envíos. */
  readonly productRevenue: number;
  readonly shippingCollected: number;
  /** Producto + envíos: lo que realmente entró a la cuenta. */
  readonly grossSales: number;
  readonly byMethod: readonly MethodTotal[];
  /** Referencias de los pedidos incluidos, para poder auditar el cierre. */
  readonly orderRefs: readonly string[];
}
