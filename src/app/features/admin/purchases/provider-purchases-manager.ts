import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiProduct, ApiPurchase } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Una línea del formulario, antes de mandarla. */
interface LineaBorrador {
  readonly productId: string;
  readonly nombre: string;
  readonly unidad: string;
  cantidad: number;
  costoUnitario: number;
}

/**
 * Compras a las fincas.
 *
 * Registrar una compra sube el inventario y fija el costo del producto en el
 * catálogo. No se resta de la ganancia: ese costo ya se cuenta al vender,
 * cuando viaja congelado a la línea del pedido. La pantalla lo dice, porque
 * es la duda que le va a surgir a cualquiera que mire las dos cifras.
 *
 * El formulario es de tres pasos —finca, productos, cantidades— y no un
 * asistente con navegación: son tres bloques que se rellenan de arriba abajo
 * y hay que poder volver a cualquiera sin perder lo escrito.
 */
@Component({
  selector: 'app-provider-purchases-manager',
  imports: [CopPipe],
  templateUrl: './provider-purchases-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderPurchasesManager {
  protected readonly adminApi = inject(AdminApiService);

  // ── Formulario ──
  protected readonly abierto = signal(false);
  /** Con valor = estamos corrigiendo esa compra, no creando una. */
  protected readonly editandoId = signal<string | null>(null);
  /** La ficha del proveedor en la agenda, no un texto suelto. */
  protected readonly contactId = signal('');
  protected readonly notas = signal('');
  protected readonly lineas = signal<readonly LineaBorrador[]>([]);
  /** Filtra el desplegable de productos, que ahora los ofrece todos. */
  protected readonly busqueda = signal('');

  protected readonly guardando = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);

  // ── Historial ──
  protected readonly filtroOrigen = signal('');
  protected readonly filtroEstado = signal<'todos' | 'pendiente' | 'pagado'>('todos');
  protected readonly ocupadoId = signal<string | null>(null);
  protected readonly confirmandoBorrado = signal<string | null>(null);
  protected readonly expandida = signal<string | null>(null);

  constructor() {
    this.adminApi.loadPurchases();
    this.adminApi.loadProducts();
    // Los proveedores salen de la agenda, no de `products.origen`.
    this.adminApi.loadContacts();
  }

  // ─────────────────────────── Catálogo ───────────────────────────

  /**
   * Productos que pueden recibir inventario.
   *
   * Las canastas con receta y las madres de variantes quedan fuera: su
   * `stock_actual` vale 0 por definición y su disponibilidad se calcula desde
   * los componentes o las hijas. El servidor las rechaza igualmente — esto
   * evita ofrecer en pantalla algo que va a fallar al guardar.
   */
  private readonly comprables = computed<readonly ApiProduct[]>(() =>
    this.adminApi.products().filter((p) => !p.tieneVariantes && !p.esCanasta),
  );

  /** Proveedores de la agenda, activos. Es lo que ofrece el paso 1. */
  protected readonly proveedores = computed(() => this.adminApi.proveedoresActivos());

  /**
   * Lo que se puede añadir a la compra: **todo** el catálogo, menos lo que ya
   * está en el borrador.
   *
   * No se filtra por `products.origen` a propósito. La misma lechuga se le
   * compra a una vereda esta semana y a otra la siguiente, así que filtrar por
   * el origen del catálogo dejaría fuera justo la compra que se quiere
   * registrar. `origen` es de dónde se dice que viene el producto de cara al
   * cliente; quién lo puso esta vez lo dice la compra.
   *
   * Como la lista es entonces larga, el desplegable se filtra por texto.
   */
  protected readonly disponibles = computed<readonly ApiProduct[]>(() => {
    const yaPuestos = new Set(this.lineas().map((l) => l.productId));
    const termino = this.busqueda().trim().toLowerCase();

    return this.comprables().filter((p) => {
      if (yaPuestos.has(p.id)) {
        return false;
      }
      if (!termino) {
        return true;
      }
      return (
        p.nombre.toLowerCase().includes(termino) ||
        (p.origen ?? '').toLowerCase().includes(termino)
      );
    });
  });

  // ─────────────────────────── Totales ───────────────────────────

  protected subtotalDe(linea: LineaBorrador): number {
    return linea.cantidad * linea.costoUnitario;
  }

  /**
   * El total del borrador, en vivo. El servidor lo recalcula igual y rechaza
   * la compra si no coinciden: esta cifra es para decidir, no para confiar.
   */
  protected readonly total = computed(() =>
    this.lineas().reduce((suma, l) => suma + l.cantidad * l.costoUnitario, 0),
  );

  protected readonly puedeGuardar = computed(
    () =>
      this.contactId().length > 0 &&
      this.lineas().length > 0 &&
      this.lineas().every((l) => l.cantidad > 0 && l.costoUnitario >= 0),
  );

  // ─────────────────────────── Formulario ───────────────────────────

  protected nuevaCompra(): void {
    this.editandoId.set(null);
    this.contactId.set('');
    this.notas.set('');
    this.lineas.set([]);
    this.busqueda.set('');
    this.formError.set(null);
    this.feedback.set(null);
    this.abierto.set(true);
  }

  /** Carga una compra existente en el formulario para corregirla. */
  protected editar(compra: ApiPurchase): void {
    this.editandoId.set(compra.id);
    // Las compras anteriores a la agenda no tienen ficha: el selector queda
    // vacío y hay que elegir proveedor para poder guardar. Es lo correcto —
    // así se van enlazando a medida que se tocan.
    this.contactId.set(compra.contactId ?? '');
    this.notas.set(compra.notas ?? '');
    this.busqueda.set('');
    this.lineas.set(
      compra.items.map((item) => ({
        productId: item.productId,
        nombre: item.productoNombre,
        unidad: item.unidad,
        cantidad: item.cantidad,
        costoUnitario: item.costoUnitario,
      })),
    );
    this.formError.set(null);
    this.feedback.set(null);
    this.abierto.set(true);
  }

  protected cerrar(): void {
    this.abierto.set(false);
    this.editandoId.set(null);
    this.formError.set(null);
  }

  /**
   * Cambiar de proveedor NO vacía el detalle.
   *
   * Antes sí lo hacía, cuando los productos se filtraban por finca y los ya
   * elegidos dejaban de tener sentido. Ahora cualquier producto se le puede
   * comprar a cualquiera, así que corregir el proveedor de una compra ya
   * escrita es un caso normal —te equivocaste de vereda— y borrar el detalle
   * sería castigar la corrección.
   */
  protected onContacto(event: Event): void {
    this.contactId.set((event.target as HTMLSelectElement).value);
  }

  protected onBusqueda(event: Event): void {
    this.busqueda.set((event.target as HTMLInputElement).value);
  }

  protected onNotas(event: Event): void {
    this.notas.set((event.target as HTMLTextAreaElement).value);
  }

  /** Añade el producto con el costo del catálogo como punto de partida. */
  protected agregar(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const productId = select.value;
    select.value = '';

    const producto = this.comprables().find((p) => p.id === productId);
    if (!producto) {
      return;
    }

    this.lineas.update((list) => [
      ...list,
      {
        productId: producto.id,
        nombre: producto.nombre,
        unidad: producto.unidad,
        cantidad: 1,
        costoUnitario: producto.precioCosto ?? 0,
      },
    ]);
  }

  protected quitar(productId: string): void {
    this.lineas.update((list) => list.filter((l) => l.productId !== productId));
  }

  protected onCantidad(productId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    this.lineas.update((list) =>
      list.map((l) =>
        l.productId === productId
          ? { ...l, cantidad: Number.isFinite(value) ? Math.trunc(value) : 0 }
          : l,
      ),
    );
  }

  protected onCosto(productId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    this.lineas.update((list) =>
      list.map((l) =>
        l.productId === productId
          ? { ...l, costoUnitario: Number.isFinite(value) ? Math.trunc(value) : 0 }
          : l,
      ),
    );
  }

  protected guardar(): void {
    if (!this.puedeGuardar() || this.guardando()) {
      return;
    }

    this.guardando.set(true);
    this.formError.set(null);

    const payload = {
      contactId: this.contactId(),
      notas: this.notas().trim() || null,
      items: this.lineas().map((l) => ({
        productId: l.productId,
        cantidad: l.cantidad,
        costoUnitario: l.costoUnitario,
      })),
    };

    const id = this.editandoId();
    const peticion = id
      ? this.adminApi.updatePurchase(id, payload)
      : this.adminApi.createPurchase(payload);

    peticion.subscribe({
      next: (compra) => {
        this.guardando.set(false);
        this.abierto.set(false);
        this.editandoId.set(null);
        this.feedback.set(
          id
            ? `Compra a ${compra.origen} corregida. El inventario quedó ajustado.`
            : `Compra a ${compra.origen} registrada. El inventario ya subió.`,
        );
      },
      error: (error: ApiErrorBody) => {
        this.guardando.set(false);
        this.formError.set(error.message);
      },
    });
  }

  // ─────────────────────────── Historial ───────────────────────────

  protected readonly visibles = computed<readonly ApiPurchase[]>(() => {
    const finca = this.filtroOrigen();
    const estado = this.filtroEstado();

    return this.adminApi.purchases().filter((compra) => {
      if (finca && compra.origen !== finca) {
        return false;
      }
      if (estado !== 'todos' && compra.estado !== estado) {
        return false;
      }
      return true;
    });
  });

  /** Las fincas que aparecen en el historial, para el desplegable del filtro. */
  protected readonly origenesEnHistorial = computed<readonly string[]>(() =>
    [...new Set(this.adminApi.purchases().map((c) => c.origen))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    ),
  );

  protected onFiltroOrigen(event: Event): void {
    this.filtroOrigen.set((event.target as HTMLSelectElement).value);
  }

  protected onFiltroEstado(estado: 'todos' | 'pendiente' | 'pagado'): void {
    this.filtroEstado.set(estado);
  }

  protected alternar(compra: ApiPurchase): void {
    this.expandida.set(this.expandida() === compra.id ? null : compra.id);
  }

  protected pagar(compra: ApiPurchase): void {
    this.ocupadoId.set(compra.id);
    this.formError.set(null);

    this.adminApi.markPurchasePaid(compra.id).subscribe({
      next: () => {
        this.ocupadoId.set(null);
        this.feedback.set(`Pago a ${compra.origen} registrado.`);
      },
      error: (error: ApiErrorBody) => {
        this.ocupadoId.set(null);
        this.formError.set(error.message);
      },
    });
  }

  /**
   * Borrar devuelve la mercancía al inventario, así que se pide confirmación:
   * a diferencia de un gasto, esto mueve stock que quizá alguien ya contó.
   */
  protected pedirBorrado(compra: ApiPurchase): void {
    this.confirmandoBorrado.set(compra.id);
    this.formError.set(null);
  }

  protected cancelarBorrado(): void {
    this.confirmandoBorrado.set(null);
  }

  protected borrar(compra: ApiPurchase): void {
    this.ocupadoId.set(compra.id);
    this.formError.set(null);

    this.adminApi.deletePurchase(compra.id).subscribe({
      next: () => {
        this.ocupadoId.set(null);
        this.confirmandoBorrado.set(null);
        this.feedback.set(`Compra a ${compra.origen} eliminada. El inventario se devolvió.`);
      },
      error: (error: ApiErrorBody) => {
        this.ocupadoId.set(null);
        this.confirmandoBorrado.set(null);
        // El caso frecuente es `stock-ya-vendido`, y su mensaje ya dice qué
        // producto y cuántas unidades quedan: se muestra tal cual.
        this.formError.set(error.message);
      },
    });
  }

  protected unidadesDe(compra: ApiPurchase): number {
    return compra.items.reduce((suma, item) => suma + item.cantidad, 0);
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
