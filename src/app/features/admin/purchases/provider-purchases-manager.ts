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
  protected readonly origen = signal('');
  protected readonly notas = signal('');
  protected readonly lineas = signal<readonly LineaBorrador[]>([]);

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
    // El selector de productos sale del catálogo: hace falta para saber qué
    // fincas hay y qué vende cada una.
    this.adminApi.loadProducts();
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

  /** Las fincas que hay, sacadas del catálogo. Ordenadas para poder buscarlas. */
  protected readonly origenes = computed<readonly string[]>(() =>
    [...new Set(this.comprables().map((p) => p.origen).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    ),
  );

  /** Lo que vende la finca elegida, menos lo que ya está en el borrador. */
  protected readonly disponibles = computed<readonly ApiProduct[]>(() => {
    const finca = this.origen();
    if (!finca) {
      return [];
    }
    const yaPuestos = new Set(this.lineas().map((l) => l.productId));
    return this.comprables().filter((p) => p.origen === finca && !yaPuestos.has(p.id));
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
      this.origen().trim().length > 0 &&
      this.lineas().length > 0 &&
      this.lineas().every((l) => l.cantidad > 0 && l.costoUnitario >= 0),
  );

  // ─────────────────────────── Formulario ───────────────────────────

  protected nuevaCompra(): void {
    this.editandoId.set(null);
    this.origen.set('');
    this.notas.set('');
    this.lineas.set([]);
    this.formError.set(null);
    this.feedback.set(null);
    this.abierto.set(true);
  }

  /** Carga una compra existente en el formulario para corregirla. */
  protected editar(compra: ApiPurchase): void {
    this.editandoId.set(compra.id);
    this.origen.set(compra.origen);
    this.notas.set(compra.notas ?? '');
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
   * Cambiar de finca vacía el detalle: los productos ya elegidos son de la
   * anterior, y una compra mezcla de dos fincas no se le puede girar a nadie.
   */
  protected onOrigen(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value !== this.origen()) {
      this.lineas.set([]);
    }
    this.origen.set(value);
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
      origen: this.origen().trim(),
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
