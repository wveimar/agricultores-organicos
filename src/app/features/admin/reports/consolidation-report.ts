import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { CategoryFilterService } from '../../../core/services/category-filter.service';
import {
  ApiConsolidationOrder,
  ApiConsolidationProduct,
} from '../../../core/api/api-client';
import { ProductUnit, UNIT_LABELS } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { CategoryFilterComponent } from '../../../shared/components/category-filter/category-filter';

// El nombre legible de cada `categoria_id` sale de `adminApi.categoryLabels`, y
// el de cada grupo de `adminApi.adminGroupById()` (método `grupoLabel()` más
// abajo) — las dos leen su tabla en vivo. Aquí eran constantes armadas al
// cargar el módulo y se quedaban mudas ante una fila creada después.

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
  imports: [CopPipe, CategoryFilterComponent],
  templateUrl: './consolidation-report.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsolidationReport {
  protected readonly adminApi = inject(AdminApiService);
  protected readonly categoryFilter = inject(CategoryFilterService);

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

  /** Toggle para activar/desactivar el filtro de seleccionados. */
  protected readonly showOnlySelected = signal(false);

  /** Estado del botón de copiar: vuelve solo a `false` a los 2 s. */
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);

  constructor() {
    this.adminApi.loadConsolidation();
    this.adminApi.loadCategories();
    this.adminApi.loadAdminGroups();
  }

  protected readonly data = this.adminApi.consolidation;

  /**
   * Opciones del desplegable de categoría: solo las que de verdad tienen algo
   * que cosechar esta ventana, con su conteo real. Ofrecer "Frutas" cuando no
   * hay ni un producto de frutas en el consolidado sería un filtro que
   * siempre vacía la tabla.
   */
  protected readonly categoryOptions = computed(() => {
    const productos = this.data()?.productos ?? [];
    const counts = new Map<string, number>();

    for (const producto of productos) {
      counts.set(producto.categoriaId, (counts.get(producto.categoriaId) ?? 0) + 1);
    }

    // Cae al id crudo si falta: un informe puede traer una categoría borrada
    // después de la venta, y ese producto no debe desaparecer del consolidado.
    const etiqueta = this.adminApi.categoryLabels();
    const nombre = (id: string) => etiqueta[id] ?? id;

    return [
      { value: 'todos', label: 'Todas', count: productos.length },
      ...[...counts.entries()]
        .sort((a, b) => nombre(a[0]).localeCompare(nombre(b[0]), 'es'))
        .map(([categoriaId, count]) => ({
          value: categoriaId,
          label: nombre(categoriaId),
          count,
        })),
    ];
  });

  protected setCategory(value: string): void {
    this.categoryFilter.setAdminFilterValue(value);
  }

  /**
   * Productos visibles: filtrados por categoría (comparte selección con
   * Inventario, vía `CategoryFilterService`) y, encima, por lo que el
   * administrador haya marcado para un agricultor concreto.
   *
   * La selección se ve en las filas (fondo coloreado) pero no reduce la
   * lista a menos que el usuario active "Ver solo seleccionados": son dos
   * filtros independientes que se componen, no uno que reemplaza al otro.
   */
  protected readonly filteredProducts = computed(() => {
    const porCategoria = this.categoryFilter.consolidationFiltered();
    const selected = this.selectedProductIds();
    const filterActive = this.showOnlySelected();

    if (!filterActive || selected.size === 0) {
      return porCategoria;
    }

    return porCategoria.filter((p) => selected.has(p.productId));
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
      label: this.grupoLabel(grupo),
      items,
    }));
  });

  /** El nombre del grupo, leído en vivo de `admin_groups`. */
  protected grupoLabel(grupoId: string): string {
    return this.adminApi.adminGroupById(grupoId)?.nombre ?? grupoId;
  }

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

  /**
   * Canastas a armar, para quien empaca.
   *
   * Sus componentes ya están repartidos en `productos` como cantidades a
   * cosechar —una canasta no se cosecha, se cosecha lo que lleva—, pero al
   * sumarlo todo se pierde cuántas cajas hay que montar. Esta lista recupera
   * ese dato sin volver a contar el mismo tomate.
   */
  protected readonly canastas = computed(() => this.data()?.canastas ?? []);

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
   * Cuánto suma un producto en su unidad de medida real, sin formatear —para
   * poder sumar varios productos entre sí antes de decidir cómo se escribe el
   * total—. Los gramos se pasan a kilos por encima del kilo, que es como se
   * pesa en la finca; el resto se queda en su unidad de venta.
   */
  private cantidadBase(producto: ApiConsolidationProduct): { valor: number; unidad: ProductUnit } {
    const base = producto.cantidadTotal * producto.cantidadUnidad;
    const unidad = producto.unidad as ProductUnit;

    return unidad === 'gr' && base >= 1000 ? { valor: base / 1000, unidad: 'kg' } : { valor: base, unidad };
  }

  /**
   * Cuánto suma todo junto en la unidad de medida real.
   *
   * `cantidadTotal` cuenta presentaciones —12 bolsas—, no peso. El agricultor
   * necesita las dos cifras: cuántos paquetes armar y cuánto cosechar en
   * total.
   */
  protected equivalencia(producto: ApiConsolidationProduct): string {
    const { valor, unidad } = this.cantidadBase(producto);
    const etiqueta = UNIT_LABELS[unidad] ?? { singular: unidad, plural: unidad };
    return `${decimal(valor)} ${valor === 1 ? etiqueta.singular : etiqueta.plural}`;
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

  /**
   * Selecciona lo visible bajo el filtro de categoría actual, no todo el
   * consolidado: filtrar a "Mieles" y pulsar "Todas" debe marcar las mieles,
   * no colar de vuelta lo que el filtro acababa de ocultar.
   */
  protected selectAll(): void {
    const visibles = this.categoryFilter.consolidationFiltered();
    this.selectedProductIds.set(new Set(visibles.map((p) => p.productId)));
  }

  protected clearSelection(): void {
    this.selectedProductIds.set(new Set());
  }

  protected toggleFilter(): void {
    this.showOnlySelected.update((v) => !v);
  }

  // ──────────────────────────── Copiar para WhatsApp ────────────────────────────
  //
  // Es una tabla real, con bordes dibujados a punta de caracteres y envuelta
  // en ``` para que WhatsApp la muestre en fuente monoespaciada — sin eso, las
  // columnas se desalinean en cuanto el teléfono usa una fuente proporcional.
  // Cada categoría es su propio bloque ``` ```, no uno solo para todo el
  // mensaje: así una tabla larga no arrastra a la siguiente si el cliente de
  // WhatsApp recorta el bloque de código en algún punto intermedio.

  private static readonly COL = { producto: 16, presentacion: 12, empaques: 8, total: 10 } as const;

  private static readonly GROUP_EMOJI: Readonly<Record<string, string>> = {
    frutas: '🍎',
    verduras: '🥬',
    agroindustriales: '🧺',
  };

  private celda(texto: string, ancho: number, alinear: 'izq' | 'der' = 'izq'): string {
    const recortado = texto.length > ancho ? `${texto.slice(0, ancho - 1)}…` : texto;
    return alinear === 'der' ? recortado.padStart(ancho) : recortado.padEnd(ancho);
  }

  private fila(cols: readonly [string, string, string, string]): string {
    const { producto, presentacion, empaques, total } = ConsolidationReport.COL;
    return (
      `│ ${this.celda(cols[0], producto)} │ ${this.celda(cols[1], presentacion)} ` +
      `│ ${this.celda(cols[2], empaques, 'der')} │ ${this.celda(cols[3], total, 'der')} │`
    );
  }

  private borde(izq: string, medio: string, der: string): string {
    return izq + Object.values(ConsolidationReport.COL).map((a) => '─'.repeat(a + 2)).join(medio) + der;
  }

  /** «10 paq» si viene en paquetes de más de una unidad, «1 und» si es suelto. */
  private empaquesTexto(producto: ApiConsolidationProduct): string {
    return `${producto.cantidadTotal} ${this.tieneEquivalencia(producto) ? 'paq' : 'und'}`;
  }

  /**
   * Suma por categoría, agrupada por unidad real y no por su texto ya
   * pluralizado: sumar "1 unidad" con "3 unidades" con las etiquetas ya
   * escritas dejaría dos claves distintas para la misma unidad.
   */
  private totalesCategoria(items: readonly ApiConsolidationProduct[]): readonly string[] {
    const sumas = new Map<ProductUnit, number>();
    for (const producto of items) {
      const { valor, unidad } = this.cantidadBase(producto);
      sumas.set(unidad, (sumas.get(unidad) ?? 0) + valor);
    }
    return [...sumas.entries()].map(([unidad, valor]) => {
      const etiqueta = UNIT_LABELS[unidad] ?? { singular: unidad, plural: unidad };
      return `${decimal(valor)} ${valor === 1 ? etiqueta.singular : etiqueta.plural}`;
    });
  }

  private bloqueCategoria(grupo: string, label: string, items: readonly ApiConsolidationProduct[]): string {
    const emoji = ConsolidationReport.GROUP_EMOJI[grupo] ?? '📦';
    const raya = '━'.repeat(30);

    const totales = this.totalesCategoria(items);
    const filasTotal = totales.map((texto, i) =>
      this.fila([i === 0 ? 'TOTAL CATEGORÍA' : '', '', '', texto]),
    );

    return [
      raya,
      `${emoji} *${label.toUpperCase()}*`,
      raya,
      '```',
      this.borde('┌', '┬', '┐'),
      this.fila(['PRODUCTO', 'PRESENTACIÓN', 'EMPAQUES', 'TOTAL']),
      this.borde('├', '┼', '┤'),
      ...items.map((p) => this.fila([p.nombre, this.presentacion(p), this.empaquesTexto(p), this.equivalencia(p)])),
      this.borde('├', '┼', '┤'),
      ...filasTotal,
      this.borde('└', '┴', '┘'),
      '```',
    ].join('\n');
  }

  /** Líneas del resumen final: una por unidad presente, «kg» con su propia frase. */
  private resumenLineas(productos: readonly ApiConsolidationProduct[]): readonly string[] {
    const sumas = new Map<ProductUnit, number>();
    for (const producto of productos) {
      const { valor, unidad } = this.cantidadBase(producto);
      sumas.set(unidad, (sumas.get(unidad) ?? 0) + valor);
    }

    return [...sumas.entries()].map(([unidad, valor]) => {
      if (unidad === 'kg') {
        return `• Peso total aproximado: ${decimal(valor)} kg`;
      }
      const etiqueta = UNIT_LABELS[unidad] ?? { singular: unidad, plural: unidad };
      return `• Total en ${etiqueta.plural}: ${decimal(valor)}`;
    });
  }

  /**
   * Informe de cosecha para el WhatsApp de la finca: tabla por categoría con
   * producto, presentación, empaques a armar y total, más un resumen general.
   *
   * Si hay productos seleccionados, solo muestra esos. Si no hay selección,
   * muestra todos (para no dejar sin nada que copiar).
   */
  protected buildProducerText(): string {
    const data = this.data();
    if (!data) {
      return '';
    }

    const fecha = new Intl.DateTimeFormat('es-CO', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date());

    const periodo = data.ventana.soloJornadaAbierta
      ? 'Pedidos de la semana en curso'
      : `Del ${data.ventana.desde ?? 'inicio'} al ${data.ventana.hasta ?? 'hoy'}`;

    const grupos = this.grouped();
    const bloques = grupos.map(({ grupo, label, items }) => this.bloqueCategoria(grupo, label, items));
    const resumen = this.resumenLineas(grupos.flatMap((g) => g.items));

    return [
      '📋 *INFORME DE COSECHA CONSOLIDADO*',
      '🌾 *Agricultores Orgánicos*',
      `📅 Fecha: ${fecha}`,
      `🗓️ ${periodo}`,
      '',
      ...bloques,
      ...this.bloqueCanastas(),
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '📊 *RESUMEN GENERAL DE RECOLECCIÓN*',
      `• Total empaques a alistar: ${this.filteredTotals().unidades}`,
      ...resumen,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
  }

  /**
   * Canastas a armar, al final del informe y no entre las categorías.
   *
   * Lo de arriba es lo que hay que traer de la finca; esto es lo que hay que
   * montar con ello una vez está en la mesa. Son dos trabajos distintos y
   * mezclarlos invitaría a cosechar dos veces el mismo tomate.
   */
  private bloqueCanastas(): readonly string[] {
    const canastas = this.canastas();
    if (canastas.length === 0) {
      return [];
    }

    const raya = '━'.repeat(30);
    const total = canastas.reduce((suma, c) => suma + c.cantidadTotal, 0);

    return [
      raya,
      '🧺 *CANASTAS A ARMAR*',
      raya,
      '_Con los productos de arriba, ya incluidos en las cantidades._',
      '```',
      this.borde('┌', '┬', '┐'),
      this.fila(['CANASTA', 'PRESENTACIÓN', 'EMPAQUES', 'TOTAL']),
      this.borde('├', '┼', '┤'),
      ...canastas.map((c) =>
        this.fila([c.nombre, `${c.pedidos} pedido(s)`, `${c.cantidadTotal} und`, `${c.cantidadTotal}`]),
      ),
      this.borde('├', '┼', '┤'),
      this.fila(['TOTAL CANASTAS', '', '', `${total}`]),
      this.borde('└', '┴', '┘'),
      '```',
    ];
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
