import { Injectable, computed, inject, signal } from '@angular/core';
import { CatalogService } from './catalog.service';
import { AdminApiService } from './admin-api.service';
import { CategoryId, Product } from '../models/product.model';
import { ApiConsolidationProduct, ApiProduct } from '../api/api-client';

/**
 * Filtro de categoría compartido entre vitrina, inventario y consolidado.
 *
 * ── Por qué la vitrina no tiene su propia señal de categoría aquí ──
 *
 * `CatalogService.activeCategory`/`visible` ya son la fuente de verdad de la
 * tienda pública, y `visible` no solo filtra por categoría: también ordena
 * (`sort`) y busca por texto. Duplicar ese filtro aquí con una señal aparte
 * dejaría dos categorías activas a la vez —una en cada servicio— y la más
 * fácil de sincronizar mal. Por eso `storeCategory`/`storeFiltered` son un
 * simple reenvío a `CatalogService`: un solo dato, leído desde dos sitios.
 *
 * Inventario y consolidado sí necesitan estado propio: hasta ahora no tenían
 * ningún filtro por categoría, así que aquí no hay nada que duplicar.
 */
@Injectable({ providedIn: 'root' })
export class CategoryFilterService {
  private readonly catalog = inject(CatalogService);
  private readonly adminApi = inject(AdminApiService);

  /** Categoría activa de la vitrina. Reenvía a `CatalogService`: no hay una segunda fuente de verdad. */
  readonly storeCategory = this.catalog.activeCategory;
  readonly storeFiltered = this.catalog.visible;
  readonly storeCounts = this.catalog.counts;

  readonly adminFilterValue = signal<string>('todos');

  /**
   * Búsqueda por texto, separada por vista. Un solo `query` compartido
   * arrastraría lo escrito en Inventario hasta Reportes al cambiar de
   * pantalla, porque este servicio es `providedIn: 'root'` y sobrevive a la
   * navegación.
   */
  readonly adminQuery = signal('');

  /**
   * ¿Este valor de filtro es un id de GRUPO, o de categoría fina?
   *
   * `adminFilterValue` guarda uno u otro según desde dónde se elija, y las dos
   * clases de id comparten el mismo espacio de texto. Antes se distinguían
   * comparando contra los tres literales fijos ('frutas'/'verduras'/
   * 'agroindustriales'); desde que los grupos son filas editables (migración
   * 0025) hay que preguntarle a la lista viva — si no, un grupo nuevo con otro
   * id se clasificaría como categoría y el filtro nunca encontraría nada.
   */
  private esIdDeGrupo(value: string): boolean {
    return this.adminApi.adminGroups().some((g) => g.id === value);
  }

  readonly adminFiltered = computed<readonly ApiProduct[]>(() => {
    const products = this.adminApi.products();
    const value = this.adminFilterValue();
    const term = this.adminQuery().trim().toLowerCase();
    const esGrupo = this.esIdDeGrupo(value);

    return products.filter((product) => {
      if (value !== 'todos') {
        if (esGrupo) {
          if (product.grupoAdmin !== value) {
            return false;
          }
        } else {
          if (product.categoriaId !== value) {
            return false;
          }
        }
      }
      if (!term) {
        return true;
      }
      return (
        product.nombre.toLowerCase().includes(term) ||
        product.origen.toLowerCase().includes(term)
      );
    });
  });

  readonly consolidationFiltered = computed<readonly ApiConsolidationProduct[]>(() => {
    const products = this.adminApi.consolidation()?.productos ?? [];
    const value = this.adminFilterValue();

    if (value === 'todos') {
      return products;
    }

    if (this.esIdDeGrupo(value)) {
      return products.filter((p) => p.grupoAdmin === value);
    }

    return products.filter((p) => p.categoriaId === value);
  });

  /**
   * Cuenta por `categoriaId` fina, no por `grupoAdmin`: es lo que necesita el
   * desplegable de Inventario para mostrar "Lácteos (5)" y "Mieles (3)" por
   * separado en vez de un único "Agroindustriales (8)".
   */
  readonly adminCounts = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.adminApi.products().length };
    for (const product of this.adminApi.products()) {
      totals[product.categoriaId] = (totals[product.categoriaId] ?? 0) + 1;
      totals[product.grupoAdmin] = (totals[product.grupoAdmin] ?? 0) + 1;
    }
    return totals;
  });

  setStoreCategory(category: CategoryId | 'todos'): void {
    this.catalog.selectCategory(category);
  }

  setAdminFilterValue(value: string): void {
    this.adminFilterValue.set(value);
  }

  setAdminQuery(term: string): void {
    this.adminQuery.set(term);
  }

  clearAdminFilters(): void {
    this.adminFilterValue.set('todos');
    this.adminQuery.set('');
  }
}
