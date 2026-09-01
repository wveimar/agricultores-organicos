import { Injectable, computed, signal } from '@angular/core';
import { ApiProduct } from '../../../core/api/api-client';

/**
 * El ticket que el cajero está armando ahora mismo.
 *
 * ── Por qué no reutiliza `CartService` ──
 *
 * El carrito de la tienda arrastra tres cosas que en un mostrador estorban:
 * el umbral de envío gratis (aquí no hay envío), la persistencia en
 * `localStorage` entre sesiones (una venta a medias NO debe reaparecer mañana
 * cuando otra persona abra la caja) y el concepto de "mi" carrito ligado a
 * quien navega. Aquí el ticket es de la venta que se está atendiendo, se vacía
 * en cuanto se cobra, y no sobrevive a nada.
 *
 * Lo que sí comparte es la regla de no pasarse del stock: se topa igual que en
 * la tienda, porque el Worker lo va a rechazar de todos modos y es mejor que el
 * cajero lo vea antes de decírselo al cliente.
 */

export interface LineaTicket {
  readonly product: ApiProduct;
  readonly cantidad: number;
  /**
   * Precio que el cajero fijó a mano, si tocó el campo. `null` = el que calcule
   * el servidor (lista o descuento de mayorista de la ficha).
   *
   * Ojo: el precio de la ficha del cliente se aplica en el Worker, así que
   * mientras esto sea `null` el total de esta pantalla es una ESTIMACIÓN sobre
   * el precio de lista. El total real llega en la respuesta de la venta.
   */
  readonly precioManual: number | null;
  readonly motivoAjuste: string;
}

@Injectable()
export class PosTicketService {
  private readonly lineas = signal<readonly LineaTicket[]>([]);

  readonly items = this.lineas.asReadonly();

  readonly vacio = computed(() => this.lineas().length === 0);

  readonly unidades = computed(() =>
    this.lineas().reduce((suma, linea) => suma + linea.cantidad, 0),
  );

  /**
   * Lo que se le va a decir al cliente, con la advertencia de arriba: si tiene
   * descuento de mayorista, el definitivo lo pone el servidor y sale más bajo.
   */
  readonly subtotal = computed(() =>
    this.lineas().reduce(
      (suma, linea) => suma + (linea.precioManual ?? linea.product.precio) * linea.cantidad,
      0,
    ),
  );

  /** Cuántas unidades caben todavía de este producto. */
  private tope(product: ApiProduct, cantidad: number): number {
    return Math.max(1, Math.min(cantidad, product.stock));
  }

  /**
   * Suma una unidad, o crea la línea. Es lo que dispara cada escaneo, así que
   * escanear tres veces el mismo código tiene que dar cantidad 3, no tres
   * líneas iguales.
   */
  agregar(product: ApiProduct, cantidad = 1): void {
    const actuales = this.lineas();
    const existente = actuales.find((l) => l.product.id === product.id);

    if (existente) {
      this.setCantidad(product.id, existente.cantidad + cantidad);
      return;
    }

    this.lineas.set([
      ...actuales,
      {
        product,
        cantidad: this.tope(product, cantidad),
        precioManual: null,
        motivoAjuste: '',
      },
    ]);
  }

  setCantidad(productId: string, cantidad: number): void {
    if (cantidad <= 0) {
      this.quitar(productId);
      return;
    }

    this.lineas.set(
      this.lineas().map((linea) =>
        linea.product.id === productId
          ? { ...linea, cantidad: this.tope(linea.product, cantidad) }
          : linea,
      ),
    );
  }

  /** `null` devuelve la línea al precio automático. */
  setPrecio(productId: string, precio: number | null): void {
    this.lineas.set(
      this.lineas().map((linea) =>
        linea.product.id === productId
          ? { ...linea, precioManual: precio === null ? null : Math.max(0, Math.round(precio)) }
          : linea,
      ),
    );
  }

  setMotivo(productId: string, motivo: string): void {
    this.lineas.set(
      this.lineas().map((linea) =>
        linea.product.id === productId ? { ...linea, motivoAjuste: motivo } : linea,
      ),
    );
  }

  quitar(productId: string): void {
    this.lineas.set(this.lineas().filter((linea) => linea.product.id !== productId));
  }

  vaciar(): void {
    this.lineas.set([]);
  }

  /**
   * El ticket en el formato que espera el Worker.
   *
   * Solo se manda `precioManual` cuando de verdad lo hay: mandar el precio de
   * lista en cada línea haría que el servidor lo tratara como un ajuste manual
   * y le pidiera motivo a todo el mundo.
   */
  aPayload(): readonly {
    productId: string;
    cantidad: number;
    precioManual?: number;
    motivoAjuste?: string;
  }[] {
    return this.lineas().map((linea) => ({
      productId: linea.product.id,
      cantidad: linea.cantidad,
      ...(linea.precioManual === null
        ? {}
        : { precioManual: linea.precioManual, motivoAjuste: linea.motivoAjuste }),
    }));
  }
}
