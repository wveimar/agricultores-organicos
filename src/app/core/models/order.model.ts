/**
 * Ciclo de vida de un pedido. El flujo solo avanza: no hay vuelta atrás.
 *
 * - `verificacion`: llegó por la web con comprobante de consignación adjunto.
 *   El stock **ya está reservado** (se descontó al finalizar la compra), falta
 *   que alguien confirme que la transferencia entró al banco.
 * - `pendiente`: entró por otro canal (teléfono, WhatsApp directo). Todavía no
 *   ha tocado el inventario; se descuenta al aprobarlo.
 */
export type OrderStatus = 'verificacion' | 'pendiente' | 'aprobado' | 'enviado';

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  verificacion: 'Pendiente de verificación',
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  enviado: 'Enviado',
};

/** Comprobante de consignación subido por el cliente. */
export interface PaymentProof {
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  /**
   * Data URL ya redimensionada y recomprimida. Se guarda así porque no hay
   * backend donde subir el archivo; ver el aviso de tamaño en
   * `shared/utils/image-file.ts`.
   */
  readonly dataUrl: string;
  readonly uploadedAt: string;
}

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
  readonly customerPhone: string;
  readonly customerAddress: string;
  /** ISO 8601. */
  readonly placedAt: string;
  readonly status: OrderStatus;
  readonly lines: readonly OrderLine[];
  /** Quién aprobó, para trazabilidad. Solo existe si `status !== 'pendiente'`. */
  readonly approvedBy?: string;
  readonly approvedAt?: string;

  /**
   * `true` cuando el inventario ya se descontó al crear el pedido (compras
   * hechas por la web). Es lo que impide el **doble descuento**: al aprobarlo,
   * el panel salta la resta porque las unidades ya salieron de bodega.
   */
  readonly stockReserved?: boolean;
  readonly paymentProof?: PaymentProof;

  /**
   * Cierre de caja que archivó este pedido. Tenerlo apuntando al cierre (en
   * vez de un booleano `archivado`) permite auditar después qué pedidos
   * entraron en qué jornada.
   */
  readonly closingId?: string;
  /** Desglose calculado en el checkout, para no recalcularlo al mostrarlo. */
  readonly totals?: OrderTotals;
}

/**
 * Desglose económico. Se congela en el pedido en vez de recalcularse: si el
 * umbral de envío cambia mañana, un pedido viejo debe seguir mostrando lo que
 * se cobró de verdad.
 *
 * Sin IVA: esta tienda vende directo de finca a consumidor y no está
 * facturando con impuesto discriminado en esta demo.
 */
export interface OrderTotals {
  readonly subtotal: number;
  readonly shipping: number;
  readonly total: number;
}

/** Datos que aporta el cliente al finalizar la compra. */
export interface NewOrderInput {
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string;
  readonly lines: readonly OrderLine[];
  readonly totals: OrderTotals;
  /** El comprobante es opcional: se puede confirmar y adjuntarlo después. */
  readonly paymentProof?: PaymentProof;
}

export type PlacementResult =
  | { readonly ok: true; readonly order: Order }
  | {
      readonly ok: false;
      readonly reason: 'insufficient-stock';
      readonly shortfalls: readonly StockShortfall[];
    }
  | { readonly ok: false; readonly reason: 'empty-cart' };

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
