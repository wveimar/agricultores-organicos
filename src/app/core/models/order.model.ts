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
  | 'cancelado'
  /** Solo en pedidos contra entrega: el domiciliario ya cobró. No es lo mismo
   *  que el efectivo ya esté en la caja de la finca — ver `efectivoLiquidado`. */
  | 'pago';

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  verificacion: 'Pendiente de verificación',
  pendiente: 'Pendiente',
  aprobado: 'Aprobado',
  enviado: 'Enviado',
  cancelado: 'Cancelado',
  pago: 'Pagado (contra entrega)',
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

/** Cómo se paga el pedido. Fuente: `orders.metodo_pago`. */
export type PaymentMethod = 'transferencia' | 'contraentrega' | 'credito' | 'entrega_en_tienda';

/**
 * Las acciones que mueven un pedido, no los estados a los que llega.
 *
 * La distinción es la que sostiene todo lo demás: `estado` no es un campo que
 * se edite, es el **resultado** de una operación con efectos colaterales.
 * Aprobar descuenta inventario y sella `aprobado_por`; cancelar lo devuelve y
 * escribe un motivo; liquidar ni siquiera cambia `estado`. Por eso el panel
 * ofrece acciones —cada una con su endpoint— y nunca un `UPDATE estado = ?`:
 * eso dejaría el inventario y la caja mintiendo respecto a lo que se muestra.
 */
export type OrderAction =
  | 'aprobar'
  | 'enviar'
  | 'pagar'
  | 'liquidar'
  | 'credito'
  | 'cancelar'
  | 'rechazar';

export interface OrderActionOption {
  readonly action: OrderAction;
  readonly label: string;
  /**
   * Dónde queda el pedido. `null` cuando la acción no mueve `estado`:
   * `liquidar` deja el pedido en 'pago' y solo levanta `efectivo_liquidado`;
   * `credito` deja el pedido donde estaba y solo cambia `metodo_pago`.
   */
  readonly resulting: OrderStatus | null;
  /** Pide confirmación con motivo antes de ejecutarse. */
  readonly confirms: boolean;
  /** Devuelve stock o anula la venta: se pinta aparte dentro del menú. */
  readonly destructive: boolean;
}

/** Lo mínimo que hace falta saber de un pedido para decidir qué admite. */
export interface OrderActionContext {
  readonly status: OrderStatus;
  readonly metodoPago: PaymentMethod;
  /** 1 cuando el efectivo del domiciliario ya entró a la caja de la finca. */
  readonly efectivoLiquidado: number;
}

/**
 * Transiciones legales desde donde está el pedido ahora mismo.
 *
 * Réplica exacta de las guardias del Worker (`routes/orders.ts`), y por eso el
 * menú nunca ofrece algo que vaya a volver con un 409. El servidor las vuelve
 * a comprobar igual: esto es ergonomía, no seguridad — dos admins con la lista
 * abierta a la vez pueden verla desactualizada, y ahí manda el `WHERE estado =
 * ...` de la sentencia, no este mapa.
 *
 * No aparece 'recaudar' (cobrar un crédito) a propósito: se hace desde
 * /admin/cartera, donde se ve la deuda completa del cliente y no un pedido
 * suelto.
 */
export function availableActions(order: OrderActionContext): readonly OrderActionOption[] {
  const options: OrderActionOption[] = [];
  const fiable = order.metodoPago !== 'credito';

  switch (order.status) {
    case 'verificacion':
    case 'pendiente':
      // Mismo endpoint para las dos, distinto punto de partida: en
      // 'verificacion' el dinero ya se dio por transferido y falta confirmar
      // que entró al banco; en 'pendiente' ni siquiera ha tocado inventario.
      // La opción muestra a dónde llega —'Aprobado'—, no el verbo del botón
      // que tenía cada una: un desplegable se lee como "elegir el siguiente
      // estado", y el verbo antiguo tapaba justo ese dato.
      options.push(option('aprobar', 'aprobado'));
      break;

    case 'aprobado':
      options.push(option('enviar', 'enviado'));
      if (fiable) {
        // No hay estado "Aprobado (a crédito)": esto solo cambia
        // `metodo_pago`, el pedido se queda en 'aprobado'. Por eso no puede
        // llevar el nombre de un estado como las demás — mostrar "Aprobado"
        // aquí sería mentir sobre a dónde llega.
        options.push(creditOption());
      }
      break;

    case 'enviado':
      // Fiar sigue siendo posible con el pedido en la calle: pasa cuando el
      // mayorista pide plazo después de que salió el camión. Mismo motivo que
      // arriba: no mueve `estado`, así que no puede llamarse "Enviado".
      if (fiable) {
        options.push(creditOption());
      }
      if (order.metodoPago === 'contraentrega') {
        options.push(option('pagar', 'pago'));
      }
      break;

    case 'pago':
      if (order.metodoPago === 'contraentrega' && order.efectivoLiquidado === 0) {
        // Tampoco cambia `estado` —el pedido sigue en 'pago'—, solo levanta
        // `efectivo_liquidado`. Reutiliza el texto de `ORDER_LOG_LABELS`
        // porque es el mismo evento que ya se ve en la traza del pedido.
        options.push({
          action: 'liquidar',
          label: ORDER_LOG_LABELS.liquidado,
          resulting: null,
          confirms: false,
          destructive: false,
        });
      }
      break;

    case 'cancelado':
      break;
  }

  // Las de anular van al final y aparte: comparten menú con la acción normal,
  // que es justo donde un clic despistado hace daño.
  if (isCancelable(order.status)) {
    options.push({
      action: 'cancelar',
      label: 'Cancelar pedido…',
      resulting: 'cancelado',
      confirms: true,
      destructive: true,
    });
  }

  // Única reversión de un 'enviado': cancelar está bloqueado una vez sale de
  // la finca. Solo tiene sentido contra entrega — el caso real es "el cliente
  // no abrió la puerta", que no aplica a una transferencia ya verificada.
  if (order.status === 'enviado' && order.metodoPago === 'contraentrega') {
    options.push({
      action: 'rechazar',
      label: 'Rechazar entrega…',
      resulting: 'cancelado',
      confirms: true,
      destructive: true,
    });
  }

  return options;
}

/**
 * Una opción cuya etiqueta es, literalmente, el nombre del estado al que
 * llega — no el verbo de la acción que lo produce. Es lo que hace que el
 * desplegable se lea como "elegir el siguiente estado" en vez de listar
 * nombres de botones que no dicen a dónde van.
 */
function option(action: OrderAction, resulting: OrderStatus): OrderActionOption {
  return { action, label: ORDER_STATUS_LABELS[resulting], resulting, confirms: false, destructive: false };
}

/**
 * "Pasar a crédito" no encaja en `option()`: no mueve `estado`, solo
 * `metodo_pago`, así que no tiene un nombre de estado que mostrar sin mentir
 * sobre a dónde llega el pedido.
 */
function creditOption(): OrderActionOption {
  return { action: 'credito', label: 'Pasar a crédito', resulting: null, confirms: false, destructive: false };
}

/**
 * Eventos de la traza de un pedido: los estados reales más `'editado'`, una
 * marca de auditoría que no es un estado — el pedido sigue donde estaba, solo
 * cambiaron sus líneas. Ver la migración 0009 para el porqué de que viva en
 * `order_status_log` y no en `orders.estado`.
 */
export type OrderLogEvent = OrderStatus | 'editado' | 'liquidado' | 'rechazado';

export const ORDER_LOG_LABELS: Readonly<Record<OrderLogEvent, string>> = {
  ...ORDER_STATUS_LABELS,
  editado: 'Productos editados',
  // Marca de auditoría, como 'editado': el pedido ya estaba en 'pago', esto
  // solo documenta que el efectivo llegó físicamente a la finca.
  liquidado: 'Efectivo entregado a caja',
  // También de auditoría: `orders.estado` queda en 'cancelado' (reutilizado),
  // esto distingue "rechazado en la puerta" de una cancelación temprana.
  rechazado: 'Entrega rechazada',
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

  /** Siempre presente: todo pedido nace con un método, no solo los contra entrega. */
  readonly metodoPago: 'transferencia' | 'contraentrega' | 'entrega_en_tienda';

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

