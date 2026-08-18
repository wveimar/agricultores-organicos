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
}

/**
 * Unión **cerrada** a propósito: la vitrina filtra comparando
 * `product.categoryId !== category` contra `CATEGORIES`, así que un producto
 * sembrado con una categoría que no esté aquí solo aparece en "Todo el huerto"
 * y desaparece bajo cualquier chip. Añadir una sección son tres pasos —esta
 * unión, `CATEGORIES` y `ADMIN_GROUP_OF`— y saltarse alguno no da error de
 * compilación, solo productos que nadie encuentra.
 */
export type CategoryId =
  | 'verduras'
  | 'frutas'
  | 'lacteos'
  | 'mieles'
  | 'listos'
  | 'granos'
  | 'despensa'
  | 'canastas';

export interface Category {
  readonly id: CategoryId | 'todos';
  readonly name: string;
  /** Se usa como subtítulo cuando la categoría está activa. */
  readonly description: string;
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

export const ADMIN_GROUP_OF: Readonly<Record<CategoryId, AdminGroup>> = {
  frutas: 'frutas',
  verduras: 'verduras',
  lacteos: 'agroindustriales',
  mieles: 'agroindustriales',
  listos: 'agroindustriales',
  granos: 'agroindustriales',
  despensa: 'agroindustriales',
  canastas: 'agroindustriales',
};

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
