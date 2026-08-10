import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AdminStoreService } from './admin-store.service';
import { CartService } from './cart.service';
import { KV_KEYS, KvStore } from './kv-store.service';
import { FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../models/cart.model';
import {
  NewOrderInput,
  Order,
  OrderLine,
  OrderTotals,
  PaymentProof,
  PlacementResult,
} from '../models/order.model';

/** Número de la cooperativa en formato internacional, sin `+` ni espacios. */
export const WHATSAPP_NUMBER = '573001234567';

/** Datos para la consignación manual. No hay pasarela de pago. */
export const BANK_DETAILS = {
  bank: 'Bancolombia',
  accountType: 'Cuenta de ahorros',
  accountNumber: '412-000188-42',
  holder: 'Cooperativa Agricultores Orgánicos',
  nit: 'NIT 901.482.117-3',
} as const;

export type CheckoutStep = 'formulario' | 'exito';

@Injectable({ providedIn: 'root' })
export class CheckoutService {
  private readonly cart = inject(CartService);
  private readonly store = inject(AdminStoreService);
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
   * Cierra la compra: reserva inventario, crea el pedido en estado
   * `verificacion` y vacía el carrito. El descuento de stock ocurre aquí, no al
   * aprobarlo, para que el panel de administración lo vea de inmediato.
   *
   * El comprobante es opcional: si el cliente no lo tiene a mano todavía, el
   * pedido se confirma igual y queda pendiente de que lo adjunte o lo envíe
   * por WhatsApp.
   */
  placeOrder(customer: { name: string; phone: string; address: string }): PlacementResult {
    const lines: OrderLine[] = this.cart.items().map((line) => ({
      productId: line.product.id,
      productName: line.product.name,
      unitPrice: line.product.price,
      unitCost: line.product.costPrice,
      quantity: line.quantity,
    }));

    const proof = this.proof();
    const input: NewOrderInput = {
      customerName: customer.name,
      customerPhone: customer.phone,
      customerAddress: customer.address,
      lines,
      totals: this.totals(),
      ...(proof ? { paymentProof: proof } : {}),
    };

    const result = this.store.placeCustomerOrder(input);
    if (!result.ok) {
      return result;
    }

    this.placedOrder.set(result.order);
    this.cart.clear();
    this.proof.set(null);

    return result;
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
      order.paymentProof
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
