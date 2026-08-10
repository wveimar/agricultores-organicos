/** Etiqueta destacada de una tarjeta. Un producto muestra como máximo una. */
export type ProductBadge = 'nuevo' | 'bestseller' | 'temporada' | 'ultimas-unidades';

/** Unidad de venta — se muestra junto al precio. */
export type ProductUnit = 'kg' | 'libra' | 'unidad' | 'manojo' | 'canasta' | 'bolsa' | 'frasco';

export interface Product {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** Frase corta de apoyo bajo el nombre. */
  readonly tagline: string;
  readonly categoryId: CategoryId;
  readonly price: number;
  /** Precio anterior tachado. Solo si el producto está en oferta. */
  readonly compareAtPrice?: number;
  /**
   * Lo que le pagamos a la finca por unidad. Es información interna: nunca se
   * muestra en la tienda pública, solo en el panel administrativo.
   */
  readonly costPrice: number;
  readonly unit: ProductUnit;
  /** Finca o región de origen — el sello de confianza de la tienda. */
  readonly origin: string;
  readonly rating: number;
  readonly reviewCount: number;
  readonly badge?: ProductBadge;
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

export type CategoryId =
  | 'verduras'
  | 'frutas'
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

export const UNIT_LABELS: Readonly<Record<ProductUnit, string>> = {
  kg: 'kg',
  libra: 'libra',
  unidad: 'unidad',
  manojo: 'manojo',
  canasta: 'canasta',
  bolsa: 'bolsa 500 g',
  frasco: 'frasco 350 g',
};
