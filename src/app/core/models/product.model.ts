/** Etiqueta destacada de una tarjeta. Un producto muestra como máximo una. */
export type ProductBadge = 'nuevo' | 'bestseller' | 'temporada' | 'ultimas-unidades';

/** Unidad de venta — se muestra junto al precio, precedida de la cantidad. */
export type ProductUnit =
  | 'gr'
  | 'kg'
  | 'libra'
  | 'unidad'
  | 'manojo'
  | 'mililitro'
  | 'canasta'
  | 'bolsa'
  | 'frasco';

export interface Product {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** Frase corta de apoyo bajo el nombre. */
  readonly tagline: string;
  readonly categoryId: CategoryId;
  /**
   * Lo que paga **este** cliente. Ya lleva aplicado el descuento de mayorista
   * si la sesión tiene uno, así que carrito, checkout y totales suman con este
   * campo sin saber nada de niveles ni porcentajes.
   */
  readonly price: number;
  /**
   * Precio de catálogo, antes del descuento de mayorista. Solo se define
   * cuando hay descuento — es lo que se pinta tachado al lado del precio real.
   *
   * Distinto de `compareAtPrice`, que es una oferta pública visible para todo
   * el mundo: este solo lo ve la cuenta que tiene la tarifa.
   */
  readonly listPrice?: number;
  /** Porcentaje aplicado, para el sello «−12 %». Solo con descuento activo. */
  readonly wholesaleDiscount?: number;
  /** Precio anterior tachado. Solo si el producto está en oferta. */
  readonly compareAtPrice?: number;
  /**
   * Lo que le pagamos a la finca por unidad. Es información interna: nunca se
   * muestra en la tienda pública, solo en el panel administrativo.
   */
  readonly costPrice: number;
  readonly unit: ProductUnit;
  /**
   * Cuánto lleva la presentación que se vende: 500 con `unit: 'gr'`, 5 con
   * `unit: 'unidad'`. `price` es lo que se cobra por esa presentación entera,
   * no por unidad de medida.
   */
  readonly quantity: number;
  /** Finca o región de origen — el sello de confianza de la tienda. */
  readonly origin: string;
  readonly rating: number;
  readonly reviewCount: number;
  readonly badge?: ProductBadge;
  /**
   * Marcado como "más vendido" desde el panel. Es una decisión comercial
   * deliberada y **no** se deriva del stock ni de las ventas reales: un
   * producto agotado puede seguir destacado, y uno con mucha rotación puede
   * no estarlo.
   */
  readonly featured: boolean;
  /**
   * Unidades disponibles. Es la **única** fuente de verdad sobre disponibilidad:
   * la tienda pública deriva de aquí si algo está agotado (`stock === 0`) en vez
   * de guardar un booleano aparte que pudiera desincronizarse del inventario.
   */
  readonly stock: number;
  /**
   * Umbral de reposición. Por debajo de él el panel avisa, pero el producto
   * sigue vendiéndose: es una alerta de compras, no un bloqueo de venta.
   */
  readonly safetyStock: number;
  readonly image: string;
  /** Segunda foto para el cross-fade al hacer hover. Opcional a propósito:
   *  solo se define cuando existe una toma alternativa real del producto. */
  readonly imageHover?: string;
  /** Texto alternativo real y descriptivo, nunca vacío (doc/plan.md §7). */
  readonly imageAlt: string;
  /**
   * Id del producto sombrilla cuando este es una variante — la Miel de 500 gr
   * apunta a la ficha "Miel de Abejas". `undefined` en todo lo demás.
   *
   * La vitrina no pinta tarjeta para las variantes: aparecen dentro del modal
   * de su madre. El carrito y el pedido, en cambio, solo ven variantes, porque
   * el inventario y el precio viven en ellas.
   */
  readonly parentId?: string;
  /**
   * Solo en las madres: cómo se llama lo que distingue a sus variantes
   * —«presentación» para la miel, «sabor» para la kambucha—. Es un dato y no
   * una deducción: mirar si los precios coinciden acierta en estos dos casos y
   * falla en cuanto haya dos tamaños al mismo precio.
   */
  readonly variantLabel?: string;
  /**
   * Qué lleva dentro, si es una canasta, un combo o un mix.
   *
   * Su presencia es lo que distingue una canasta de un producto normal — de ahí
   * que sea opcional y no un array que a veces está vacío.
   *
   * El `stock` de una canasta no es un número que nadie escriba: lo calcula el
   * servidor con el componente que primero se agote. Llega aquí ya resuelto, y
   * por eso el carrito y el checkout la tratan como a cualquier otro producto
   * sin saber que las canastas existen.
   */
  readonly contains?: readonly ProductComponent[];
}

/** Un producto dentro de una canasta, tal como se le enseña al cliente. */
export interface ProductComponent {
  readonly name: string;
  /** Cuántas presentaciones entran en UNA canasta. */
  readonly quantity: number;
  readonly unit: ProductUnit;
  /** Cuánto lleva cada presentación: 500 con `unit: 'gr'`. */
  readonly unitQuantity: number;
}

/**
 * Plural de la palabra que nombra la variante: «3 presentaciones», «3 sabores».
 *
 * `variantLabel` es texto libre que se escribe en el panel, así que la copia
 * no puede llevar el plural escrito a mano. Las tres reglas del castellano
 * bastan para lo que cabe ahí —una palabra corriente en singular— y ante
 * cualquier duda devuelve algo legible, nunca un «sabors».
 */
export function pluralizeVariantLabel(label: string, count: number): string {
  if (count === 1) {
    return label;
  }
  // «presentación» → «presentaciones»: el plural se lleva la tilde por delante.
  if (/ón$/i.test(label)) {
    return `${label.slice(0, -2)}ones`;
  }
  if (/s$/i.test(label)) {
    return label;
  }
  return /[aeiouáéíóú]$/i.test(label) ? `${label}s` : `${label}es`;
}

/** Lo que la tarjeta de una madre necesita saber de sus variantes. */
export interface VariantSummary {
  readonly count: number;
  /** Unidades sumadas de todas las variantes: si es 0, la madre está agotada. */
  readonly stock: number;
  /** El más barato y el más caro **entre los que quedan**. */
  readonly fromPrice: number;
  readonly toPrice: number;
  /**
   * `true` cuando todas valen igual (los sabores). Entonces la ficha muestra
   * un precio a secas y no un «Desde», que sobre tres botellas al mismo precio
   * solo confunde.
   */
  readonly samePrice: boolean;
}

/**
 * Resume las variantes de un producto, o `null` si no tiene.
 *
 * El rango se calcula sobre lo que **queda en bodega**: con el tarro de 300 gr
 * agotado, anunciar «Desde $16.000» manda al cliente a un precio que no puede
 * pagar. Si no queda ninguna, se usan todas para no dejar la ficha sin cifra
 * mientras el velo de "Agotado" la cubre.
 */
export function summarizeVariants(variants: readonly Product[]): VariantSummary | null {
  if (variants.length === 0) {
    return null;
  }

  const stock = variants.reduce((total, variant) => total + variant.stock, 0);
  const disponibles = variants.filter(isInStock);
  const precios = (disponibles.length > 0 ? disponibles : variants).map((v) => v.price);

  const fromPrice = Math.min(...precios);
  const toPrice = Math.max(...precios);

  return {
    count: variants.length,
    stock,
    fromPrice,
    toPrice,
    samePrice: fromPrice === toPrice,
  };
}

/**
 * Identificador de categoría. Ya no es una unión cerrada.
 *
 * Fue una hasta que las categorías pasaron a la tabla `categories` (migración
 * 0013): una fila creada desde el panel no puede aparecer en un tipo compilado,
 * así que la lista válida la decide la base de datos y `CatalogService` la
 * carga junto al catálogo.
 *
 * Lo que la unión intentaba proteger —que nadie archive un producto en una
 * categoría inexistente— ahora lo protege el propio dato: el campo del panel es
 * un desplegable poblado desde la tabla, y borrar una categoría con productos
 * dentro lo rechaza el Worker. Lo que la unión nunca llegó a proteger, por
 * cierto: 'fermentos' se coló igual, con cuatro kambuchas invisibles detrás.
 */
export type CategoryId = string;

export interface Category {
  readonly id: CategoryId | 'todos';
  readonly name: string;
  /** Se usa como subtítulo cuando la categoría está activa. */
  readonly description: string;
  /**
   * Silueta del chip en la vitrina. Es una **clave** —'hoja', 'panal'…—, no un
   * dibujo: el repertorio vive en `CategoryIcon` y esto solo dice cuál toca.
   *
   * Viaja con la categoría por lo mismo que `adminGroup`: un mapa compilado
   * `id → ícono` cubriría las diez sembradas y ninguna de las que se creen
   * desde el panel. Vacío o desconocido cae en la silueta por defecto.
   */
  readonly icon: string;
  /**
   * Agrupación macro del panel de compras. Viaja con la categoría porque
   * `ADMIN_GROUP_OF` era un mapa compilado y no podía cubrir filas nuevas.
   * Opcional: 'todos' es un filtro de la vitrina, no una estantería.
   */
  readonly adminGroup?: AdminGroup;
}

/** Disponibilidad derivada de `stock` frente a `safetyStock`. */
export type StockLevel = 'agotado' | 'critico' | 'ok';

export function stockLevelOf(product: Product): StockLevel {
  if (product.stock <= 0) {
    return 'agotado';
  }
  return product.stock <= product.safetyStock ? 'critico' : 'ok';
}

export function isInStock(product: Product): boolean {
  return product.stock > 0;
}

/** Ganancia por unidad al precio de venta actual. Puede ser negativa. */
export function marginOf(product: Product): number {
  return product.price - product.costPrice;
}

/** Margen como fracción del precio (0.3 = 30 %). 0 si el precio es 0. */
export function marginPercentOf(product: Product): number {
  return product.price > 0 ? marginOf(product) / product.price : 0;
}

/**
 * Agrupación macro que usa el panel de inventario. El catálogo público tiene
 * seis categorías de cara al cliente; compras razona con estas tres.
 */
export type AdminGroup = 'frutas' | 'verduras' | 'agroindustriales';

// `ADMIN_GROUP_OF` vivía aquí: un `Record<CategoryId, AdminGroup>` que había
// que ampliar a mano con cada categoría nueva. Ahora el grupo es la columna
// `grupo_admin` de la tabla `categories` y llega en `Category.adminGroup`, que
// es lo único que puede cubrir una categoría creada desde el panel.

export const ADMIN_GROUP_LABELS: ReadonlyArray<{ value: AdminGroup | 'todos'; label: string }> = [
  { value: 'todos', label: 'Todo el inventario' },
  { value: 'frutas', label: 'Frutas' },
  { value: 'verduras', label: 'Verduras' },
  { value: 'agroindustriales', label: 'Agroindustriales' },
];

export type SortOption = 'destacados' | 'precio-asc' | 'precio-desc' | 'mejor-valorados';

export const SORT_LABELS: ReadonlyArray<{ value: SortOption; label: string }> = [
  { value: 'destacados', label: 'Destacados' },
  { value: 'precio-asc', label: 'Precio: menor a mayor' },
  { value: 'precio-desc', label: 'Precio: mayor a menor' },
  { value: 'mejor-valorados', label: 'Mejor valorados' },
];

export const BADGE_LABELS: Readonly<Record<ProductBadge, string>> = {
  nuevo: 'Nuevo',
  bestseller: 'Bestseller',
  temporada: 'De temporada',
  'ultimas-unidades': 'Últimas unidades',
};

/**
 * Singular y plural de cada unidad.
 *
 * Antes esto era una sola cadena, y dos entradas llevaban el tamaño escrito
 * dentro: "bolsa 500 g", "frasco 350 g". Ese peso ahora vive en
 * `quantity`, que sí se puede filtrar, comparar y cambiar desde el panel.
 *
 * Las abreviaturas no pluralizan —«500 gr», no «500 grs»—; los sustantivos sí.
 */
export const UNIT_LABELS: Readonly<Record<ProductUnit, { singular: string; plural: string }>> = {
  gr: { singular: 'gr', plural: 'gr' },
  kg: { singular: 'kg', plural: 'kg' },
  libra: { singular: 'libra', plural: 'libras' },
  unidad: { singular: 'unidad', plural: 'unidades' },
  manojo: { singular: 'manojo', plural: 'manojos' },
  mililitro: { singular: 'mililitro', plural: 'mililitros' },
  canasta: { singular: 'canasta', plural: 'canastas' },
  bolsa: { singular: 'bolsa', plural: 'bolsas' },
  frasco: { singular: 'frasco', plural: 'frascos' },
};

/**
 * Cómo se nombra lo que se lleva el cliente por el precio marcado.
 *
 * Con cantidad 1 se calla el número —«/ kg», no «/ 1 kg»—, que es como estaba
 * escrito el catálogo entero antes de existir este campo y como se sigue
 * hablando: nadie dice "un kilo de tomate" señalando el precio.
 */
/**
 * Todas las unidades, para el selector del panel.
 *
 * Derivadas de `UNIT_LABELS` en vez de escritas aparte: añadir una unidad es
 * tocar un solo sitio y no puede quedar una sin etiqueta.
 */
export const ALL_UNITS = Object.keys(UNIT_LABELS) as readonly ProductUnit[];

export function unitPresentation(quantity: number, unit: ProductUnit): string {
  const etiqueta = UNIT_LABELS[unit] ?? { singular: unit, plural: unit };
  return quantity === 1 ? etiqueta.singular : `${quantity} ${etiqueta.plural}`;
}

/**
 * Cuánto de un componente entra en UNA canasta: «2 × 500 gr», «1 unidad».
 *
 * Se enseñan las dos cifras y no su producto —«1 kg»— porque son cosas
 * distintas: dos bolsas de medio kilo no es lo mismo que una de un kilo, y
 * quien recibe la canasta abre lo que le llega, no el total.
 *
 * Vive aquí y no en cada componente porque lo pintan cuatro pantallas —la
 * tarjeta, el detalle de la canasta, el resumen del checkout y la confirmación
 * de compra— y la regla de arriba tiene que ser la misma en todas.
 */
export function componentPortion(component: ProductComponent): string {
  const presentacion = unitPresentation(component.unitQuantity, component.unit);
  return component.quantity === 1 ? presentacion : `${component.quantity} × ${presentacion}`;
}
