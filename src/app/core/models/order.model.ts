/**
 * Ciclo de vida de un pedido. El flujo solo avanza: no hay vuelta atrás.
 *
 * - `verificacion`: llegó por la web con comprobante de consignación adjunto.
 *   El stock **ya está reservado** (se descontó al finalizar la compra), falta
 *   que alguien confirme que la transferencia entró al banco.
 * - `pendiente`: entró por otro canal (teléfono, WhatsApp directo). Todavía no
 *   ha tocado el inventario; se descuenta al aprobarlo.
 */
export type OrderStatus =
  | 'verificacion'
  | 'pendiente'
  | 'aprobado'
  | 'enviado'
  | 'cancelado';

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  verificacion: 'Pendiente de verificación',
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  enviado: 'Enviado',
  cancelado: 'Cancelado',
};

/**
 * Estados desde los que todavía se puede anular.
 *
 * Un pedido aprobado ya entró en la caja de la jornada y uno enviado ya va en
 * camino: deshacer cualquiera de los dos descuadraría las cuentas o el
 * inventario frente a lo que de verdad pasó. El servidor aplica esta misma
 * regla, que es la que cuenta.
 */
export const CANCELABLE: readonly OrderStatus[] = ['verificacion', 'pendiente'];

export function isCancelable(status: OrderStatus): boolean {
  return CANCELABLE.includes(status);
}

/**
 * Estados desde los que todavía se pueden tocar las líneas del pedido.
 *
 * Igual que `CANCELABLE`, pero incluye `aprobado`: aprobar solo confirma el
 * pago y descuenta inventario, no congela qué se pidió. Un pedido enviado ya
 * salió de la finca y uno cancelado ya no es una venta — ninguno de los dos
 * admite editar qué llevaba. El servidor aplica la misma regla.
 */
export const EDITABLE: readonly OrderStatus[] = ['verificacion', 'pendiente', 'aprobado'];

export function isEditable(status: OrderStatus): boolean {
  return EDITABLE.includes(status);
}

/**
 * Eventos de la traza de un pedido: los estados reales más `'editado'`, una
 * marca de auditoría que no es un estado — el pedido sigue donde estaba, solo
 * cambiaron sus líneas. Ver la migración 0009 para el porqué de que viva en
 * `order_status_log` y no en `orders.estado`.
 */
export type OrderLogEvent = OrderStatus | 'editado';

export const ORDER_LOG_LABELS: Readonly<Record<OrderLogEvent, string>> = {
  ...ORDER_STATUS_LABELS,
  editado: 'Productos editados',
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

import { ProductComponent } from './product.model';

/**
 * Línea de pedido. Guarda `unitPrice` y `productName` en vez de resolverlos
 * contra el catálogo al pintar: un pedido es un documento histórico y debe
 * seguir mostrando lo que se cobró aunque el precio cambie después.
 */
export interface OrderLine {
  readonly productId: string;
  readonly productName: string;
  readonly unitPrice: number;
  /**
   * Costo por unidad al momento de la venta. Se congela igual que `unitPrice`:
   * si el costo de compra cambia después, un pedido viejo debe seguir
   * mostrando la ganancia real que dejó en su momento.
   */
  readonly unitCost: number;
  readonly quantity: number;
  /**
   * Qué lleva dentro, si es una canasta. Se copia del `Product` del carrito al
   * confirmar la compra, igual que el resto de la línea: la pantalla de éxito
   * no vuelve a preguntarle nada al servidor, arma todo con lo que ya sabía el
   * navegador.
   */
  readonly contains?: readonly ProductComponent[];
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

export function orderTotal(order: Order): number {
  return order.lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0);
}

export function orderUnits(order: Order): number {
  return order.lines.reduce((total, line) => total + line.quantity, 0);
}

/** Ganancia de venta de producto, sin contar el envío. */
export function orderProfit(order: Order): number {
  return order.lines.reduce(
    (total, line) => total + (line.unitPrice - line.unitCost) * line.quantity,
    0,
  );
}

