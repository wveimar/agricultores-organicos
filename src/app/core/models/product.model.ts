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
  readonly unit: ProductUnit;
  /** Finca o región de origen — el sello de confianza de la tienda. */
  readonly origin: string;
  readonly rating: number;
  readonly reviewCount: number;
  readonly badge?: ProductBadge;
  readonly inStock: boolean;
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
