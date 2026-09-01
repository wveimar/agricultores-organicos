import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminApiService } from '../../../core/services/admin-api.service';
import {
  ApiContact,
  ApiErrorBody,
  ApiPosVenta,
  ApiProduct,
} from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { PosTicketService } from './pos-ticket.service';
import { PosReceipt } from './pos-receipt';

/**
 * Caja — la pantalla donde se atiende al cliente que está en el mostrador.
 *
 * El objetivo de diseño es uno solo: **que la fila avance**. De ahí las tres
 * decisiones que explican casi todo lo demás:
 *
 * 1. **Un único campo con el foco puesto.** El cursor vive en el buscador y
 *    vuelve ahí después de cada acción. Un lector de códigos de barras es un
 *    teclado que escribe rápido y manda Enter: si el foco está donde debe, el
 *    escaneo "simplemente funciona" sin ningún modo especial.
 *
 * 2. **Enter resuelve las dos formas de buscar.** Primero se prueba una
 *    coincidencia EXACTA por código de barras —el caso del lector—; si no la
 *    hay, queda la lista filtrada por nombre para hacer clic. Sin adivinar
 *    velocidades de tecleo ni distinguir "modo escáner", que es frágil.
 *
 * 3. **El precio definitivo lo pone el servidor.** Esta pantalla estima sobre
 *    el precio de lista. Si el cliente tiene descuento de mayorista en su
 *    ficha, el Worker lo aplica y el total real llega en la respuesta. Se avisa
 *    en pantalla para que el cajero no cante en voz alta una cifra que va a
 *    cambiar.
 */
@Component({
  selector: 'app-pos-sell',
  standalone: true,
  imports: [FormsModule, CopPipe, PosReceipt],
  templateUrl: './pos-sell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [PosTicketService],
})
export class PosSell {
  private readonly admin = inject(AdminApiService);
  protected readonly ticket = inject(PosTicketService);

  private readonly buscadorRef = viewChild<ElementRef<HTMLInputElement>>('buscador');

  protected readonly productos = this.admin.products;
  protected readonly contactos = this.admin.contacts;

  protected readonly busqueda = signal('');
  protected readonly clienteBusqueda = signal('');
  protected readonly contactoElegido = signal<ApiContact | null>(null);

  protected readonly metodoPago = signal<'efectivo' | 'tarjeta' | 'credito'>('efectivo');
  protected readonly reciboSolicitado = signal(true);

  protected readonly guardando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ultimaVenta = signal<ApiPosVenta | null>(null);

  /** Lo que se acaba de escanear y no existe: se avisa en vez de callar. */
  protected readonly sinCoincidencia = signal<string | null>(null);

  constructor() {
    this.admin.loadProducts();
    this.admin.loadContacts();
    this.admin.loadAjustes();
    this.admin.loadPosVentas();

    // El ajuste global solo decide cómo llega la casilla marcada; el cajero
    // puede cambiarla en cada venta preguntándole al cliente.
    queueMicrotask(() => {
      const ajuste = this.admin.ajustes().find((a) => a.clave === 'pos_recibo_por_defecto');
      if (ajuste) {
        this.reciboSolicitado.set(ajuste.valor === '1');
      }
    });
  }

  /**
   * Lo que se puede vender: activo, con stock, y que no sea una madre de
   * variantes (esas no se venden, se vende una de sus presentaciones).
   */
  private readonly vendibles = computed(() =>
    this.productos().filter((p) => p.activo !== 0 && !p.tieneVariantes),
  );

  /**
   * Ocho como mucho, igual que el buscador de Pedidos: una lista larga en una
   * caja no ayuda, estorba.
   */
  protected readonly resultados = computed(() => {
    const termino = this.busqueda().trim().toLowerCase();
    if (termino === '') {
      return [];
    }
    return this.vendibles()
      .filter(
        (p) =>
          p.nombre.toLowerCase().includes(termino) ||
          (p.codigoBarras ?? '').toLowerCase() === termino,
      )
      .slice(0, 8);
  });

  protected readonly clientesFiltrados = computed(() => {
    const termino = this.clienteBusqueda().trim().toLowerCase();
    if (termino === '') {
      return [];
    }
    return this.contactos()
      .filter(
        (c) =>
          c.esCliente === 1 &&
          c.activo === 1 &&
          (c.nombre.toLowerCase().includes(termino) ||
            (c.telefono ?? '').includes(termino) ||
            (c.documento ?? '').includes(termino)),
      )
      .slice(0, 8);
  });

  /** Fiar exige ficha: la deuda es de una persona, no de un mostrador. */
  protected readonly puedeFiar = computed(() => this.contactoElegido() !== null);

  protected readonly cupoDisponible = computed(() => {
    const contacto = this.contactoElegido();
    return contacto ? contacto.cupoCredito : 0;
  });

  /**
   * Enter en el buscador: primero el código exacto, luego el nombre.
   *
   * Si hay una sola coincidencia por nombre, también se añade — teclear medio
   * nombre y pulsar Enter es más rápido que soltar el teclado para hacer clic.
   */
  protected onBuscadorEnter(): void {
    const termino = this.busqueda().trim();
    if (termino === '') {
      return;
    }

    const porCodigo = this.vendibles().find(
      (p) => (p.codigoBarras ?? '').toLowerCase() === termino.toLowerCase(),
    );

    if (porCodigo) {
      this.agregar(porCodigo);
      return;
    }

    const coincidencias = this.resultados();
    if (coincidencias.length === 1) {
      this.agregar(coincidencias[0]);
      return;
    }

    if (coincidencias.length === 0) {
      this.sinCoincidencia.set(termino);
    }
  }

  protected agregar(product: ApiProduct): void {
    if (product.stock <= 0) {
      this.error.set(`"${product.nombre}" está agotado.`);
      return;
    }
    this.ticket.agregar(product);
    this.busqueda.set('');
    this.sinCoincidencia.set(null);
    this.error.set(null);
    this.enfocarBuscador();
  }

  protected enfocarBuscador(): void {
    // El foco vuelve al buscador después de cada acción: es lo que permite
    // escanear el siguiente producto sin tocar el ratón.
    queueMicrotask(() => this.buscadorRef()?.nativeElement.focus());
  }

  protected setCantidad(productId: string, valor: string): void {
    this.ticket.setCantidad(productId, Number(valor) || 0);
  }

  protected setPrecio(productId: string, valor: string): void {
    this.ticket.setPrecio(productId, valor === '' ? null : Number(valor));
  }

  protected setMotivo(productId: string, valor: string): void {
    this.ticket.setMotivo(productId, valor);
  }

  protected elegirCliente(contacto: ApiContact): void {
    this.contactoElegido.set(contacto);
    this.clienteBusqueda.set('');
    this.enfocarBuscador();
  }

  protected quitarCliente(): void {
    this.contactoElegido.set(null);
    if (this.metodoPago() === 'credito') {
      this.metodoPago.set('efectivo');
    }
  }

  protected onMetodoChange(valor: string): void {
    this.metodoPago.set(valor as 'efectivo' | 'tarjeta' | 'credito');
  }

  /** Qué líneas llevan un precio cambiado a mano y todavía sin explicar. */
  protected readonly ajustesSinMotivo = computed(() =>
    this.ticket
      .items()
      .filter(
        (l) =>
          l.precioManual !== null &&
          l.precioManual !== l.product.precio &&
          l.motivoAjuste.trim() === '',
      )
      .map((l) => l.product.nombre),
  );

  protected readonly puedeVender = computed(
    () =>
      !this.ticket.vacio() &&
      !this.guardando() &&
      this.ajustesSinMotivo().length === 0 &&
      (this.metodoPago() !== 'credito' || this.puedeFiar()),
  );

  protected vender(): void {
    if (!this.puedeVender()) {
      return;
    }

    this.guardando.set(true);
    this.error.set(null);

    this.admin
      .posSell({
        contactId: this.contactoElegido()?.id ?? null,
        items: this.ticket.aPayload(),
        metodoPago: this.metodoPago(),
        reciboSolicitado: this.reciboSolicitado(),
      })
      .subscribe({
        next: (venta) => {
          this.ultimaVenta.set(venta);
          this.ticket.vaciar();
          this.contactoElegido.set(null);
          this.metodoPago.set('efectivo');
          this.guardando.set(false);
          this.enfocarBuscador();
        },
        error: (err: ApiErrorBody) => {
          this.error.set(err.message);
          this.guardando.set(false);
        },
      });
  }

  /** Cierra el recibo y deja la caja lista para el siguiente cliente. */
  protected cerrarRecibo(): void {
    this.ultimaVenta.set(null);
    this.enfocarBuscador();
  }

  protected imprimir(): void {
    window.print();
  }
}
