import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CatalogService } from '../../../core/services/catalog.service';
import { ProductCard } from '../product-card/product-card';

/**
 * Sección "Más vendidos" de la portada.
 *
 * Qué aparece aquí lo decide el panel de inventario con un interruptor por
 * producto, no un cálculo sobre las ventas. Es deliberado: la lista sirve para
 * empujar lo que interesa vender esta semana, y eso no siempre coincide con lo
 * que más se vendió el mes pasado.
 *
 * Si no hay ninguno marcado, la sección no se pinta. Un encabezado sobre una
 * fila vacía se lee como un fallo de la página.
 */
@Component({
  selector: 'app-featured-products',
  imports: [ProductCard],
  templateUrl: './featured-products.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeaturedProducts {
  private readonly catalog = inject(CatalogService);

  protected readonly featured = this.catalog.featured;

  /**
   * Cuatro como mucho: es lo que entra en una fila del ancho completo, y una
   * sección de "más vendidos" con veinte productos deja de destacar nada.
   */
  protected readonly visibles = computed(() => this.featured().slice(0, 4));

  protected readonly hayMas = computed(() => this.featured().length > 4);
}
