import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Observable, map } from 'rxjs';
import { CartService } from './cart.service';
import { KV_KEYS, KvStore } from './kv-store.service';
import { ApiClient } from '../api/api-client';
import { FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../models/cart.model';
import { Order, OrderLine, OrderTotals, PaymentProof } from '../models/order.model';

/**
 * Número de la cooperativa en formato internacional, sin `+` ni espacios.
 *
 * `wa.me` exige el indicativo del país pegado al número y sin símbolos: con
 * `+57 301 606 6121` el enlace abre WhatsApp sin destinatario, y el cliente
 * cree que envió el mensaje.
 */
export const WHATSAPP_NUMBER = '573016066121';

/** Datos para la consignación manual. No hay pasarela de pago. */
export const BANK_DETAILS = {
  bank: 'Bancolombia',
  accountType: 'Cuenta de ahorros',
  accountNumber: '64715834837',
  holder: 'wveimar Mamian Ramirez',
  cc: 'cc 70-907-972',
} as const;

export type CheckoutStep = 'formulario' | 'exito';

@Injectable({ providedIn: 'root' })
export class CheckoutService {
  private readonly cart = inject(CartService);
  private readonly api = inject(ApiClient);
  private readonly kv = inject(KvStore);

  /** Pedido recién creado. Se rehidrata para que sobreviva a un F5. */
  readonly placedOrder = signal<Order | null>(this.hydrateLastOrder());

  /**
   * Transición carrito → éxito. Es un `computed`, no una señal aparte: el paso
   * *es* «¿hay un pedido creado?». Cuando eran dos estados, recargar la página
   * rehidrataba el pedido pero devolvía el paso a `formulario`, y la pantalla
   * de éxito se perdía.
   */
  readonly step = computed<CheckoutStep>(() => (this.placedOrder() ? 'exito' : 'formulario'));

  /** Comprobante opcional: se puede confirmar el pedido y adjuntarlo después. */
  readonly proof = signal<PaymentProof | null>(null);

  readonly subtotal = this.cart.subtotal;

  readonly shipping = computed(() =>
    this.cart.isEmpty() || this.subtotal() >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST,
  );

  readonly total = computed(() => this.subtotal() + this.shipping());

  readonly totals = computed<OrderTotals>(() => ({
    subtotal: this.subtotal(),
    shipping: this.shipping(),
    total: this.total(),
  }));

  constructor() {
    // El pedido en verificación se guarda aparte del listado del panel para
    // poder repintar la pantalla de éxito tal cual tras una recarga.
    effect(() => {
      const order = this.placedOrder();
      if (order) {
        this.kv.put(KV_KEYS.lastOrder, order);
      } else {
        this.kv.delete(KV_KEYS.lastOrder);
      }
    });
  }

  setProof(proof: PaymentProof | null): void {
    this.proof.set(proof);
  }

  /**
   * Cierra la compra contra el backend real: `POST /api/orders` reserva
   * inventario y crea el pedido en una sola transacción del lado del
   * servidor (ver `worker/src/routes/orders.ts`). Si otra venta se llevó las
   * últimas unidades entre que se cargó la página y este clic, el Worker
   * responde 400 con los faltantes exactos y aquí no se toca nada más.
   *
   * El comprobante es opcional: si el cliente no lo tiene a mano todavía, el
   * pedido se confirma igual y queda pendiente de que lo adjunte o lo envíe
   * por WhatsApp.
   */
  placeOrder(customer: {
    name: string;
    phone: string;
    address: string;
    metodoPago: 'transferencia' | 'contraentrega';
  }): Observable<Order> {
    const cartLines = this.cart.items();
    // Un comprobante no significa nada en contra entrega: no hay nada que
    // verificar contra el banco. Se ignora aunque quedara alguno cargado de
    // un cambio de método a mitad del formulario.
    const proof = customer.metodoPago === 'transferencia' ? this.proof() : null;
    const totals = this.totals();

    const lines: OrderLine[] = cartLines.map((line) => ({
      productId: line.product.id,
      productName: line.product.name,
      unitPrice: line.product.price,
      unitCost: line.product.costPrice,
      quantity: line.quantity,
      contains: line.product.contains,
    }));

    return this.api
      .createOrder({
        clienteNombre: customer.name,
        clienteTelefono: customer.phone,
        clienteDireccion: customer.address,
        envio: totals.shipping,
        items: cartLines.map((line) => ({ productId: line.product.id, cantidad: line.quantity })),
        metodoPago: customer.metodoPago,
        ...(proof ? { comprobanteNombre: proof.fileName, comprobanteUrl: proof.dataUrl } : {}),
      })
      .pipe(
        map((apiOrder) => {
          // La pantalla de éxito se arma con lo que ya sabíamos en el
          // navegador (líneas, totales, comprobante) más lo único que solo el
          // servidor puede asignar: id, referencia y fecha real de creación.
          const created: Order = {
            id: apiOrder.id,
            reference: apiOrder.referencia,
            customerName: customer.name,
            customerPhone: customer.phone,
            customerAddress: customer.address,
            placedAt: apiOrder.creadoEn,
            status: apiOrder.estado,
            metodoPago: customer.metodoPago,
            lines,
            stockReserved: true,
            totals,
            ...(proof ? { paymentProof: proof } : {}),
          };

          this.placedOrder.set(created);
          this.cart.clear();
          this.proof.set(null);

          return created;
        }),
      );
  }

  /** Vuelve al formulario y olvida el pedido mostrado. */
  reset(): void {
    this.placedOrder.set(null);
  }

  /**
   * Enlace de WhatsApp con el resumen. `encodeURIComponent` es obligatorio:
   * el mensaje lleva saltos de línea, acentos y el símbolo `$`, que romperían
   * la query string si viajaran en crudo.
   */
  whatsappLink(order: Order): string {
    const lines = order.lines
      .map((line) => `• ${line.quantity} × ${line.productName} — ${money(line.unitPrice * line.quantity)}`)
      .join('\n');

    const totals = order.totals;

    const message = [
      `Hola, acabo de hacer el pedido *${order.reference}* en la tienda.`,
      '',
      '*Productos:*',
      lines,
      '',
      totals ? `Subtotal: ${money(totals.subtotal)}` : '',
      totals ? `Envío: ${totals.shipping === 0 ? 'Gratis' : money(totals.shipping)}` : '',
      totals ? `*Total: ${money(totals.total)}*` : '',
      '',
      order.metodoPago === 'contraentrega'
        ? 'Pago en efectivo cuando me lo entreguen.'
        : order.paymentProof
          ? `Ya cargué el comprobante de consignación en la web (${order.paymentProof.fileName}).`
          : 'Te envío el comprobante de consignación por este chat.',
      'Quedo atento a la confirmación. ¡Gracias!',
    ]
      .filter((part) => part !== '')
      .join('\n');

    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  }

  private hydrateLastOrder(): Order | null {
    return this.kv.get<Order>(KV_KEYS.lastOrder);
  }
}

function money(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(value);
}
