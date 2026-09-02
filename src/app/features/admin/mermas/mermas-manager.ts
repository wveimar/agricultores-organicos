import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import {
  ApiErrorBody,
  ApiMerma,
  ApiMermaReporte,
  ApiProduct,
  MOTIVO_MERMA_LABELS,
  MotivoMerma,
} from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { MermaActa } from './merma-acta';
import { ProductUnit, unitPresentation } from '../../../core/models/product.model';

/**
 * Baja de inventario por merma — el cierre de jornada de la bodega.
 *
 * ── Por qué es un acta y no un campo de stock ──
 *
 * Corregir el inventario ya se podía: se teclea otro número en Inventario y
 * listo. Lo que eso no deja es rastro de POR QUÉ bajó, y esa es justamente la
 * pregunta de una auditoría. Aquí cada baja sale con producto, cantidad,
 * motivo, quién la firmó y a qué hora; el acta se puede imprimir y archivar.
 *
 * ── La pantalla en dos mitades ──
 *
 * A la izquierda se arma el acta —igual que un ticket de caja: se marca el
 * producto, se dice cuánto y por qué—; a la derecha está lo que ya se dio de
 * baja hoy y el informe de qué se está dañando más. Se ven juntas a propósito:
 * el número de "esta semana se perdieron $X en pudrición" es lo que convierte
 * el trámite en una decisión de compras.
 *
 * ── El costo no viaja desde aquí ──
 *
 * El navegador manda solo qué y cuánto. El costo lo lee el Worker del catálogo
 * al registrar: el acta es la justificación contable de una pérdida que se
 * resta de la ganancia del cierre, y dejar que el navegador dijera cuánto
 * valía lo que se botó sería dejarle decidir cuánta ganancia se descuenta.
 */

/** Una línea del acta que se está armando, antes de mandarla. */
interface LineaBorrador {
  readonly product: ApiProduct;
  cantidad: number;
  motivo: MotivoMerma;
  observacion: string;
}

@Component({
  selector: 'app-mermas-manager',
  standalone: true,
  imports: [CopPipe, MermaActa],
  templateUrl: './mermas-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MermasManager {
  protected readonly admin = inject(AdminApiService);

  protected readonly MOTIVOS = Object.entries(MOTIVO_MERMA_LABELS) as [MotivoMerma, string][];
  protected readonly motivoLabel = (motivo: MotivoMerma): string => MOTIVO_MERMA_LABELS[motivo];

  protected readonly busqueda = signal('');
  protected readonly observaciones = signal('');
  protected readonly guardando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ultimaActa = signal<ApiMerma | null>(null);

  /** El borrador. Es un signal de array porque cada línea se edita en sitio. */
  protected readonly borrador = signal<readonly LineaBorrador[]>([]);

  constructor() {
    this.admin.loadProducts();
    this.admin.loadMermas();
    this.cargarReporte();
  }

  // ── Catálogo ──────────────────────────────────────────────────────────

  /**
   * Lo que se puede dar de baja: activo, con stock, y con inventario PROPIO.
   *
   * Una canasta o una madre de variantes tienen `stock_actual = 0` por
   * definición —su disponibilidad sale de sus componentes o de sus hijas—, así
   * que descontarles no quitaría nada de la bodega. El Worker las rechaza
   * igual; no ofrecerlas evita que alguien lo intente con el acta a medio
   * llenar.
   */
  private readonly dañables = computed(() =>
    this.admin
      .products()
      .filter((p) => p.activo !== 0 && !p.tieneVariantes && !p.esCanasta && p.stock > 0),
  );

  protected readonly resultados = computed(() => {
    const termino = this.busqueda().trim().toLowerCase();
    const yaPuestos = new Set(this.borrador().map((l) => l.product.id));
    const libres = this.dañables().filter((p) => !yaPuestos.has(p.id));

    if (termino === '') {
      return libres.slice(0, 8);
    }
    return libres
      .filter(
        (p) =>
          p.nombre.toLowerCase().includes(termino) ||
          (p.codigoBarras ?? '').toLowerCase() === termino,
      )
      .slice(0, 8);
  });

  protected presentacion(producto: ApiProduct): string {
    return unitPresentation(producto.cantidadUnidad, producto.unidad as ProductUnit);
  }

  // ── Armar el acta ─────────────────────────────────────────────────────

  protected agregar(producto: ApiProduct): void {
    if (this.borrador().some((l) => l.product.id === producto.id)) {
      return;
    }
    this.borrador.update((lineas) => [
      ...lineas,
      // 'pudricion' como valor inicial y no vacío: es el motivo más común en
      // una bodega de fruta, y un desplegable que arranca en blanco obliga a
      // tocarlo en cada línea aunque la respuesta casi siempre sea la misma.
      { product: producto, cantidad: 1, motivo: 'pudricion', observacion: '' },
    ]);
    this.busqueda.set('');
    this.error.set(null);
  }

  protected quitar(productId: string): void {
    this.borrador.update((lineas) => lineas.filter((l) => l.product.id !== productId));
  }

  /**
   * El tope es el stock: dar de baja más de lo que hay no es una merma, es un
   * descuadre de inventario, y tiene otro arreglo. El Worker lo rechaza
   * también; aquí se corta antes para no dejar escribir una cifra imposible.
   */
  protected setCantidad(productId: string, valor: string): void {
    const pedida = Number(valor) || 0;
    this.borrador.update((lineas) =>
      lineas.map((linea) =>
        linea.product.id === productId
          ? { ...linea, cantidad: Math.max(0, Math.min(pedida, linea.product.stock)) }
          : linea,
      ),
    );
  }

  protected setMotivo(productId: string, valor: string): void {
    this.borrador.update((lineas) =>
      lineas.map((linea) =>
        linea.product.id === productId ? { ...linea, motivo: valor as MotivoMerma } : linea,
      ),
    );
  }

  protected setObservacion(productId: string, valor: string): void {
    this.borrador.update((lineas) =>
      lineas.map((linea) =>
        linea.product.id === productId ? { ...linea, observacion: valor } : linea,
      ),
    );
  }

  protected paso(producto: ApiProduct): number {
    return producto.vendidoPorPeso ? 0.001 : 1;
  }

  /**
   * Lo que va a costar esta acta, estimado.
   *
   * Estimado y no definitivo: el Worker vuelve a leer el costo del catálogo al
   * registrar, que es el único valor que cuenta. Se muestra igual porque quien
   * firma tiene que ver el orden de magnitud ANTES de firmar — no es lo mismo
   * botar tres tomates que media nevera.
   */
  protected readonly totalCosto = computed(() =>
    this.borrador().reduce(
      (suma, l) => suma + Math.round((l.product.precioCosto ?? 0) * l.cantidad),
      0,
    ),
  );

  protected readonly totalVenta = computed(() =>
    this.borrador().reduce((suma, l) => suma + Math.round(l.product.precio * l.cantidad), 0),
  );

  /** Qué líneas están sin cantidad. Se nombran para no dejar buscar cuál es. */
  protected readonly sinCantidad = computed(() =>
    this.borrador()
      .filter((l) => l.cantidad <= 0)
      .map((l) => l.product.nombre),
  );

  protected readonly puedeGuardar = computed(
    () => this.borrador().length > 0 && this.sinCantidad().length === 0 && !this.guardando(),
  );

  protected registrar(): void {
    if (!this.puedeGuardar()) {
      return;
    }

    this.guardando.set(true);
    this.error.set(null);

    this.admin
      .createMerma({
        observaciones: this.observaciones().trim() || undefined,
        items: this.borrador().map((linea) => ({
          productId: linea.product.id,
          cantidad: linea.cantidad,
          motivo: linea.motivo,
          observacion: linea.observacion.trim() || undefined,
        })),
      })
      .subscribe({
        next: (acta) => {
          this.ultimaActa.set(acta);
          this.borrador.set([]);
          this.observaciones.set('');
          this.guardando.set(false);
          this.cargarReporte();
        },
        error: (err: ApiErrorBody) => {
          this.error.set(err.message);
          this.guardando.set(false);
        },
      });
  }

  // ── Historial ─────────────────────────────────────────────────────────

  protected borrando: string | null = null;

  protected deshacer(merma: ApiMerma): void {
    this.borrando = merma.id;
    this.error.set(null);

    this.admin.deleteMerma(merma.id).subscribe({
      next: () => {
        this.borrando = null;
        this.cargarReporte();
      },
      error: (err: ApiErrorBody) => {
        this.borrando = null;
        this.error.set(err.message);
      },
    });
  }

  // ── Informe ───────────────────────────────────────────────────────────

  protected readonly reporte = signal<ApiMermaReporte | null>(null);
  protected readonly desde = signal('');
  protected readonly hasta = signal('');

  protected cargarReporte(): void {
    this.admin
      .mermaReporte({ desde: this.desde() || undefined, hasta: this.hasta() || undefined })
      .subscribe({ next: (datos) => this.reporte.set(datos) });
  }

  // ── Acta imprimible ───────────────────────────────────────────────────

  /**
   * Imprime con el navegador, sin generar un PDF en el servidor.
   *
   * El mismo camino que el recibo de la caja: `window.print()` sobre un bloque
   * con `@media print`, y de ahí "Guardar como PDF" si hace falta el archivo.
   * Un generador de PDF en el Worker sería otra dependencia y otro formato que
   * mantener para producir exactamente el mismo papel.
   */
  protected imprimir(): void {
    window.print();
  }

  protected cerrarActa(): void {
    this.ultimaActa.set(null);
  }
}
