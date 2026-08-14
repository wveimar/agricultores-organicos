import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import {
  ApiConsolidationOrder,
  ApiConsolidationProduct,
} from '../../../core/api/api-client';
import { ADMIN_GROUP_LABELS, ProductUnit, UNIT_LABELS } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Etiqueta de cada grupo, para los encabezados del consolidado. */
const GROUP_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  ADMIN_GROUP_LABELS.filter((g) => g.value !== 'todos').map((g) => [g.value, g.label]),
);

function money(value: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(value);
}

function decimal(value: number): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(value);
}

/** Fecha de hoy en Colombia, en `AAAA-MM-DD` para los `<input type="date">`. */
function todayInColombia(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utc - 5 * 3_600_000).toISOString().slice(0, 10);
}

@Component({
  selector: 'app-consolidation-report',
  imports: [CopPipe],
  templateUrl: './consolidation-report.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsolidationReport {
  protected readonly adminApi = inject(AdminApiService);

  protected readonly today = todayInColombia();

  /**
   * Rango en edición. Vive aparte de lo cargado a propósito: escribir una
   * fecha no debe repintar la tabla a medias mientras se teclea la otra. La
   * consulta sale al pulsar «Aplicar».
   */
  protected readonly desde = signal('');
  protected readonly hasta = signal('');

  /** Productos seleccionados para filtrar por agricultor. */
  protected readonly selectedProductIds = signal<Set<string>>(new Set());

  /** Estado del botón de copiar: vuelve solo a `false` a los 2 s. */
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);

  constructor() {
    this.adminApi.loadConsolidation();
  }

  protected readonly data = this.adminApi.consolidation;

  /**
   * Productos visibles después del filtro de selección.
   * Si no hay nada seleccionado, muestra todos (comportamiento por defecto).
   * Si hay selecciones, solo muestra los marcados.
   */
  protected readonly filteredProducts = computed(() => {
    const todos = this.data()?.productos ?? [];
    const selected = this.selectedProductIds();

    if (selected.size === 0) {
      return todos;
    }

    return todos.filter((p) => selected.has(p.productId));
  });

  /** Agrupa el consolidado filtrado por frutas / verduras / agroindustriales. */
  protected readonly grouped = computed(() => {
    const productos = this.filteredProducts();
    const groups = new Map<string, ApiConsolidationProduct[]>();

    for (const producto of productos) {
      const list = groups.get(producto.grupoAdmin);
      if (list) {
        list.push(producto);
      } else {
        groups.set(producto.grupoAdmin, [producto]);
      }
    }

    return [...groups.entries()].map(([grupo, items]) => ({
      grupo,
      label: GROUP_LABEL[grupo] ?? grupo,
      items,
    }));
  });

  /** Cuántos productos están seleccionados. */
  protected readonly selectedCount = computed(() => this.selectedProductIds().size);

  /** Totales recalculados del consolidado filtrado. */
  protected readonly filteredTotals = computed(() => {
    const filtered = this.filteredProducts();

    if (filtered.length === 0) {
      return {
        productos: 0,
        unidades: 0,
      };
    }

    return {
      productos: filtered.length,
      unidades: filtered.reduce((sum, p) => sum + p.cantidadTotal, 0),
    };
  });

  /** Pedidos con domicilio cobrado primero: son los que hay que revisar. */
  protected readonly pedidos = computed<readonly ApiConsolidationOrder[]>(
    () => this.data()?.pedidos ?? [],
  );

  protected readonly hayDescuadres = computed(
    () => (this.data()?.domicilios.descuadres ?? 0) > 0,
  );

  protected readonly rangoActivo = computed(() => {
    const ventana = this.data()?.ventana;
    return ventana ? !ventana.soloJornadaAbierta : false;
  });

  // ──────────────────────────────── Filtros ────────────────────────────────

  protected setDesde(value: string): void {
    this.desde.set(value);
  }

  protected setHasta(value: string): void {
    this.hasta.set(value);
  }

  protected aplicar(): void {
    this.adminApi.loadConsolidation({
      ...(this.desde() ? { desde: this.desde() } : {}),
      ...(this.hasta() ? { hasta: this.hasta() } : {}),
    });
  }

  /** Vuelve a lo que se cosecha para el próximo domingo. */
  protected verJornadaAbierta(): void {
    this.desde.set('');
    this.hasta.set('');
    this.adminApi.loadConsolidation();
  }

  // ────────────────────────── Presentación de cantidades ──────────────────────────

  /**
   * Cómo se vende cada presentación: «500 gr», «kg», «5 unidades».
   *
   * Es lo que el agricultor tiene que preparar por pieza, distinto del total.
   */
  protected presentacion(producto: ApiConsolidationProduct): string {
    const unidad = producto.unidad as ProductUnit;
    const etiqueta = UNIT_LABELS[unidad] ?? { singular: unidad, plural: unidad };
    return producto.cantidadUnidad === 1
      ? etiqueta.singular
      : `${producto.cantidadUnidad} ${etiqueta.plural}`;
  }

  /**
   * Cuánto suma todo junto en la unidad de medida real.
   *
   * `cantidadTotal` cuenta presentaciones —12 bolsas—, no peso. El agricultor
   * necesita las dos cifras: cuántos paquetes armar y cuánto cosechar en
   * total. Los gramos se pasan a kilos por encima del kilo, que es como se
   * pesa en la finca.
   */
  protected equivalencia(producto: ApiConsolidationProduct): string {
    const base = producto.cantidadTotal * producto.cantidadUnidad;
    const unidad = producto.unidad as ProductUnit;

    if (unidad === 'gr' && base >= 1000) {
      return `${decimal(base / 1000)} kg`;
    }

    const etiqueta = UNIT_LABELS[unidad] ?? { singular: unidad, plural: unidad };
    return `${decimal(base)} ${base === 1 ? etiqueta.singular : etiqueta.plural}`;
  }

  /** `true` cuando la presentación no es unitaria y la equivalencia aporta algo. */
  protected tieneEquivalencia(producto: ApiConsolidationProduct): boolean {
    return producto.cantidadUnidad > 1;
  }

  // ─────────────────────────── Selección de productos ────────────────────────────

  protected toggleProduct(productId: string): void {
    this.selectedProductIds.update((selected) => {
      const newSet = new Set(selected);
      if (newSet.has(productId)) {
        newSet.delete(productId);
      } else {
        newSet.add(productId);
      }
      return newSet;
    });
  }

  protected isSelected(productId: string): boolean {
    return this.selectedProductIds().has(productId);
  }

  protected selectAll(): void {
    const todos = this.data()?.productos ?? [];
    this.selectedProductIds.set(new Set(todos.map((p) => p.productId)));
  }

  protected clearSelection(): void {
    this.selectedProductIds.set(new Set());
  }

  // ──────────────────────────── Copiar para WhatsApp ────────────────────────────

  /**
   * Texto plano, sin tablas ni markdown: WhatsApp no las renderiza y en un
   * teléfono en la bodega lo que se lee es una lista corta con la cifra al
   * final de cada línea.
   *
   * Si hay productos seleccionados, solo muestra esos. Si no hay selección,
   * muestra todos (para no dejar sin nada que copiar).
   */
  protected buildProducerText(): string {
    const data = this.data();
    if (!data) {
      return '';
    }

    const cabecera = data.ventana.soloJornadaAbierta
      ? 'Pedidos de la semana en curso'
      : `Pedidos del ${data.ventana.desde ?? 'inicio'} al ${data.ventana.hasta ?? 'hoy'}`;

    const bloques = this.grouped().map(({ label, items }) =>
      [
        '',
        `*${label.toUpperCase()}*`,
        ...items.map((producto) => {
          const cantidad = `${producto.cantidadTotal} × ${this.presentacion(producto)}`;
          const total = this.tieneEquivalencia(producto)
            ? ` (${this.equivalencia(producto)})`
            : '';
          return `• ${producto.nombre}: ${cantidad}${total}`;
        }),
      ].join('\n'),
    );

    const filtered = this.filteredTotals();
    const aviso =
      data.pendientes.pedidos > 0
        ? [
            '',
            `Nota: hay ${data.pendientes.pedidos} pedido(s) sin confirmar pago.`,
            'Si se aprueban, esta lista aumenta.',
          ].join('\n')
        : '';

    return [
      '*AGRICULTORES ORGÁNICOS*',
      'Consolidado de cosecha',
      cabecera,
      ...bloques,
      '',
      `Total: ${filtered.productos} productos · ${filtered.unidades} unidades`,
      aviso,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * `navigator.clipboard` necesita contexto seguro (HTTPS o localhost). Si
   * falla —o si el navegador de la bodega no lo trae—, se muestra el texto en
   * un cuadro seleccionable en vez de dejar al usuario sin salida.
   */
  protected copyProducerList(): void {
    const texto = this.buildProducerText();
    if (!texto) {
      return;
    }

    this.copyFailed.set(false);

    const clipboard = navigator.clipboard;
    if (!clipboard) {
      this.copyFailed.set(true);
      return;
    }

    clipboard.writeText(texto).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      },
      () => this.copyFailed.set(true),
    );
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('es-CO', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** Explica un descuadre en una línea, para la celda de la tabla. */
  protected descuadreLabel(pedido: ApiConsolidationOrder): string {
    return pedido.diferenciaEnvio < 0
      ? `Faltó cobrar ${money(-pedido.diferenciaEnvio)}`
      : `Se cobró ${money(pedido.diferenciaEnvio)} de más`;
  }
}
