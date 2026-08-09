/** Ciclo de vida de un pedido. El flujo solo avanza: no hay vuelta atrás. */
export type OrderStatus = 'pendiente' | 'aprobado' | 'enviado';

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  enviado: 'Enviado',
};

/**
 * Línea de pedido. Guarda `unitPrice` y `productName` en vez de resolverlos
 * contra el catálogo al pintar: un pedido es un documento histórico y debe
 * seguir mostrando lo que se cobró aunque el precio cambie después.
 */
export interface OrderLine {
  readonly productId: string;
  readonly productName: string;
  readonly unitPrice: number;
  readonly quantity: number;
}

export interface Order {
  readonly id: string;
  readonly reference: string;
  readonly customerName: string;
  readonly customerEmail: string;
  readonly city: string;
  /** ISO 8601. */
  readonly placedAt: string;
  readonly status: OrderStatus;
  readonly lines: readonly OrderLine[];
  /** Quién aprobó, para trazabilidad. Solo existe si `status !== 'pendiente'`. */
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export function orderTotal(order: Order): number {
  return order.lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0);
}

export function orderUnits(order: Order): number {
  return order.lines.reduce((total, line) => total + line.quantity, 0);
}

/** Motivo por el que una aprobación no pudo completarse. */
export interface StockShortfall {
  readonly productId: string;
  readonly productName: string;
  readonly requested: number;
  readonly available: number;
}

export type ApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' | 'already-approved' }
  | { readonly ok: false; readonly reason: 'insufficient-stock'; readonly shortfalls: readonly StockShortfall[] };
