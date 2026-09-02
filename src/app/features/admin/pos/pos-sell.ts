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
  ApiContactMatch,
  ApiErrorBody,
  ApiPosVenta,
  ApiProduct,
} from '../../../core/api/api-client';
import { ProductUnit, unitPresentation } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { CategoryIcon } from '../../../shared/category-icon/category-icon';
import { ContactSearch } from '../../../shared/contact-search/contact-search';
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
  imports: [FormsModule, CopPipe, PosReceipt, CategoryIcon, ContactSearch],
  templateUrl: './pos-sell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [PosTicketService],
})
export class PosSell {
  private readonly admin = inject(AdminApiService);
  protected readonly ticket = inject(PosTicketService);

  private readonly buscadorRef = viewChild<ElementRef<HTMLInputElement>>('buscador');

  protected readonly productos = this.admin.products;

  protected readonly busqueda = signal('');

  /**
   * El cliente de esta venta.
   *
   * `null` no significa "venta anónima": significa que el cajero todavía no
   * ha decidido. La venta anónima es elegir explícitamente «Consumidor final»,
   * que es una ficha real con el documento genérico de la DIAN. Esa distinción
   * es la que permite que toda venta acabe con cédula.
   */
  protected readonly contactoElegido = signal<ApiContactMatch | null>(null);

  protected readonly metodoPago = signal<'efectivo' | 'tarjeta' | 'credito'>('efectivo');
  protected readonly reciboSolicitado = signal(true);

  /**
   * Cuánto dio el cliente, cuando es menos que el total — la misma idea que
   * el abono del domiciliario en `delivery-orders.ts`. `0` es "no hay abono":
   * se cobra completo.
   */
  protected readonly montoAbono = signal(0);

  protected onMontoAbono(valor: string): void {
    this.montoAbono.set(Number(valor) || 0);
  }

  /**
   * Solo cuenta como abono si de verdad deja algo pendiente. Si lo que
   * escribió el cajero alcanza o supera el total, es un cobro completo — igual
   * que en el domiciliario, no tiene sentido tratarlo como abono.
   */
  protected readonly huboAbonoParcial = computed(
    () => this.montoAbono() > 0 && this.montoAbono() < this.ticket.subtotal(),
  );

  protected readonly guardando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ultimaVenta = signal<ApiPosVenta | null>(null);

  /** Lo que se acaba de escanear y no existe: se avisa en vez de callar. */
  protected readonly sinCoincidencia = signal<string | null>(null);

  constructor() {
    this.admin.loadProducts();
    this.admin.loadCategories();
    this.admin.loadAdminGroups();
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


  // ── Navegación por grupos y categorías ────────────────────────────────
  //
  // El mismo recorrido que la tienda: grupo → categoría → producto. Se replica
  // aquí en vez de reutilizar `CategoryFilterService` porque ese servicio es
  // `providedIn: 'root'` y su filtro lo comparte Inventario: si la caja
  // escribiera en él, dejar el mostrador filtrado por «Hojas» dejaría también
  // Inventario filtrado por «Hojas» al abrirlo después. Son dos pantallas con
  // dos contextos, y ese propio servicio ya advierte de ese riesgo.
  //
  // Y hay una diferencia de fondo: la tienda filtra `Product` del catálogo
  // público; la caja necesita `ApiProduct`, que es lo único que trae stock y
  // código de barras.

  /** 'todos' o el id de un grupo de `admin_groups`. */
  protected readonly grupoActivo = signal<string>('todos');
  /** 'todas' o el id de una categoría. Se reinicia al cambiar de grupo. */
  protected readonly categoriaActiva = signal<string>('todas');

  /** Solo grupos activos que de verdad tienen algo que vender hoy. */
  protected readonly grupos = computed(() => {
    const conProducto = new Set(this.vendibles().map((p) => p.grupoAdmin));
    return this.admin
      .adminGroups()
      .filter((g) => g.activo === 1 && conProducto.has(g.id))
      .sort((a, b) => a.orden - b.orden);
  });

  /** Lo que hay dentro del grupo abierto, antes de filtrar por categoría. */
  private readonly delGrupo = computed(() => {
    const grupo = this.grupoActivo();
    return grupo === 'todos'
      ? this.vendibles()
      : this.vendibles().filter((p) => p.grupoAdmin === grupo);
  });

  /**
   * Categorías del grupo abierto, con cuántos productos tiene cada una.
   *
   * Se cuentan sobre `delGrupo` y no sobre el catálogo entero: dentro de
   * «Huerto», el chip «Hojas» tiene que decir cuántas hojas hay en el huerto,
   * no cuántas hay en toda la finca.
   */
  protected readonly categorias = computed(() => {
    const cuentas = new Map<string, number>();
    for (const p of this.delGrupo()) {
      cuentas.set(p.categoriaId, (cuentas.get(p.categoriaId) ?? 0) + 1);
    }

    return this.admin
      .categories()
      .filter((c) => c.activo === 1 && cuentas.has(c.id))
      .sort((a, b) => a.orden - b.orden)
      .map((c) => ({ ...c, cuenta: cuentas.get(c.id) ?? 0 }));
  });

  protected readonly totalDelGrupo = computed(() => this.delGrupo().length);

  /**
   * La rejilla: lo que se ve en el panel central.
   *
   * Buscar tiene prioridad sobre los filtros. Con el cliente enfrente, quien
   * teclea «tomate» quiere el tomate esté donde esté, no «no hay resultados en
   * esta categoría» — que sería técnicamente cierto y prácticamente inútil.
   */
  protected readonly rejilla = computed(() => {
    const termino = this.busqueda().trim().toLowerCase();

    if (termino !== '') {
      return this.vendibles().filter(
        (p) =>
          p.nombre.toLowerCase().includes(termino) ||
          p.origen.toLowerCase().includes(termino) ||
          (p.codigoBarras ?? '').toLowerCase() === termino,
      );
    }

    const categoria = this.categoriaActiva();
    return categoria === 'todas'
      ? this.delGrupo()
      : this.delGrupo().filter((p) => p.categoriaId === categoria);
  });

  protected elegirGrupo(id: string): void {
    this.grupoActivo.set(id);
    // La categoría del grupo anterior no existe en el nuevo: dejarla puesta
    // mostraría una rejilla vacía sin explicar por qué.
    this.categoriaActiva.set('todas');
    this.busqueda.set('');
    this.enfocarBuscador();
  }

  protected elegirCategoria(id: string): void {
    this.categoriaActiva.set(id);
    this.busqueda.set('');
    this.enfocarBuscador();
  }

  /**
   * Cuántas unidades de cada producto van ya en el ticket, por id.
   *
   * Es un mapa y no una búsqueda por tarjeta porque la rejilla puede tener
   * cuarenta productos en pantalla: buscar en el ticket una vez por tarjeta
   * serían cuarenta recorridos en cada detección de cambios, y esto se
   * recalcula solo cuando el ticket cambia de verdad.
   */
  private readonly cantidadesEnTicket = computed(
    () => new Map(this.ticket.items().map((l) => [l.product.id, l.cantidad])),
  );

  /** Lo que pinta la insignia de la tarjeta. 0 = no está en el ticket. */
  protected enTicket(productId: string): number {
    return this.cantidadesEnTicket().get(productId) ?? 0;
  }

  /** «500 gr», «1 unidad»: la presentación que se vende, bajo el nombre. */
  protected presentacion(producto: ApiProduct): string {
    return unitPresentation(producto.cantidadUnidad, producto.unidad as ProductUnit);
  }

  /**
   * Fiar exige ficha con cupo libre. Se comprueba aquí para no ofrecer una
   * opción que el servidor va a rechazar — él manda igual, esto es ergonomía.
   */
  protected readonly puedeFiar = computed(() => this.cupoRestante() > 0);

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

    const coincidencias = this.rejilla();
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

  protected elegirCliente(contacto: ApiContactMatch): void {
    this.contactoElegido.set(contacto);
    this.enfocarBuscador();
  }

  /**
   * La venta sin identificar. No deja el cliente en blanco: apunta a la ficha
   * «Consumidor final», con el documento 222222222222 que la DIAN reserva para
   * esto. Un toque, y la caja queda lista para vender.
   */
  protected ventaAnonima(): void {
    this.admin.consumidorFinal().subscribe({
      next: (contacto) => {
        this.contactoElegido.set(contacto);
        this.enfocarBuscador();
      },
      error: () =>
        this.error.set(
          'No encontré la ficha «Consumidor final». Reconstruye la base con npm run db:reset.',
        ),
    });
  }

  protected quitarCliente(): void {
    this.contactoElegido.set(null);
    if (this.metodoPago() === 'credito') {
      this.metodoPago.set('efectivo');
    }
  }

  /** Nivel de precios legible. Sin rol de mayorista, precio de lista. */
  protected readonly nivelPrecio = computed(() => {
    const rol = this.contactoElegido()?.nivelPrecio;
    return rol ? rol.replace('MAYORISTA_N', 'Mayorista N') : 'Minorista';
  });

  /**
   * Cuánto le queda de cupo. Es lo que decide si «Crédito» se puede elegir, y
   * el cajero tiene que verlo ANTES de marcar productos: descubrirlo al cobrar,
   * con el ticket lleno y el cliente esperando, es el peor momento posible.
   */
  protected readonly cupoRestante = computed(() => {
    const c = this.contactoElegido();
    return c ? Math.max(0, c.cupoCredito - c.deuda) : 0;
  });

  protected onMetodoChange(valor: string): void {
    this.metodoPago.set(valor as 'efectivo' | 'tarjeta' | 'credito');
    // A crédito no se cobra nada ahora mismo — un abono puesto antes de
    // cambiar de forma de pago dejaría de tener sentido si se quedara ahí.
    if (valor === 'credito') {
      this.montoAbono.set(0);
    }
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
      (this.metodoPago() !== 'credito' || this.puedeFiar()) &&
      // Un abono deja debiendo el resto: esa deuda es de una persona, no de
      // un mostrador, igual que fiar completo.
      (!this.huboAbonoParcial() || this.contactoElegido() !== null),
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
        ...(this.huboAbonoParcial() ? { montoAbono: this.montoAbono() } : {}),
      })
      .subscribe({
        next: (venta) => {
          this.ultimaVenta.set(venta);
          this.ticket.vaciar();
          this.contactoElegido.set(null);
          this.metodoPago.set('efectivo');
          this.montoAbono.set(0);
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
