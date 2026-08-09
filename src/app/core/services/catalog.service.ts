import { Injectable, computed, signal } from '@angular/core';
import { CATEGORIES, PRODUCTS } from '../data/mock-catalog';
import { Category, CategoryId, Product, SortOption } from '../models/product.model';

/** Peso de cada etiqueta en el orden "Destacados". */
const BADGE_WEIGHT: Record<string, number> = {
  bestseller: 0,
  nuevo: 1,
  temporada: 2,
  'ultimas-unidades': 3,
};

@Injectable({ providedIn: 'root' })
export class CatalogService {
  readonly categories: readonly Category[] = CATEGORIES;

  /** Fuente de datos. Al conectar un backend, esto pasa a ser un resource(). */
  private readonly all = signal<readonly Product[]>(PRODUCTS);

  readonly activeCategory = signal<CategoryId | 'todos'>('todos');
  readonly sort = signal<SortOption>('destacados');
  readonly query = signal('');

  /**
   * Rejilla visible. Todo el filtrado ocurre en el cliente sobre un `computed`:
   * cambiar de categoría no navega ni recarga, solo recalcula la señal.
   */
  readonly visible = computed<readonly Product[]>(() => {
    const category = this.activeCategory();
    const term = this.query().trim().toLowerCase();

    const filtered = this.all().filter((product) => {
      if (category !== 'todos' && product.categoryId !== category) {
        return false;
      }
      if (!term) {
        return true;
      }
      return (
        product.name.toLowerCase().includes(term) ||
        product.tagline.toLowerCase().includes(term) ||
        product.origin.toLowerCase().includes(term)
      );
    });

    return this.applySort(filtered, this.sort());
  });

  /** Nº de productos por categoría, para el contador de cada chip. */
  readonly counts = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.all().length };
    for (const product of this.all()) {
      totals[product.categoryId] = (totals[product.categoryId] ?? 0) + 1;
    }
    return totals;
  });

  /** Descripción de la categoría activa, usada como subtítulo de la rejilla. */
  readonly activeCategoryMeta = computed<Category>(
    () =>
      this.categories.find((category) => category.id === this.activeCategory()) ??
      this.categories[0],
  );

  readonly hasResults = computed(() => this.visible().length > 0);

  selectCategory(id: CategoryId | 'todos'): void {
    this.activeCategory.set(id);
  }

  setSort(option: SortOption): void {
    this.sort.set(option);
  }

  setQuery(term: string): void {
    this.query.set(term);
  }

  clearFilters(): void {
    this.activeCategory.set('todos');
    this.query.set('');
    this.sort.set('destacados');
  }

  private applySort(products: Product[], option: SortOption): Product[] {
    // `filter` ya devolvió un array nuevo, así que ordenar en sitio es seguro.
    switch (option) {
      case 'precio-asc':
        return products.sort((a, b) => a.price - b.price);
      case 'precio-desc':
        return products.sort((a, b) => b.price - a.price);
      case 'mejor-valorados':
        return products.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
      case 'destacados':
      default:
        return products.sort((a, b) => {
          const weightA = a.badge ? BADGE_WEIGHT[a.badge] : 90;
          const weightB = b.badge ? BADGE_WEIGHT[b.badge] : 90;
          // Lo agotado siempre cae al final, tenga la etiqueta que tenga.
          const stockA = a.inStock ? 0 : 1;
          const stockB = b.inStock ? 0 : 1;
          return stockA - stockB || weightA - weightB || b.reviewCount - a.reviewCount;
        });
    }
  }
}
