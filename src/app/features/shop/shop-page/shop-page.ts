import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Hero } from '../hero/hero';
import { CategoryFilter } from '../category-filter/category-filter';
import { ProductGrid } from '../product-grid/product-grid';
import { FeaturedProducts } from '../featured-products/featured-products';
import { RevealDirective } from '../../../shared/directives/reveal.directive';
import { STORY_IMAGE } from '../../../core/data/mock-catalog';

@Component({
  selector: 'app-shop-page',
  imports: [Hero, CategoryFilter, ProductGrid, FeaturedProducts, RevealDirective],
  templateUrl: './shop-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShopPage {
  protected readonly storyImage = STORY_IMAGE;

  /**
   * Cuatro promesas cortas, y las cuatro tienen que ser ciertas.
   *
   * La primera decía "Cosechado hoy · sale hacia tu casa el mismo día", que
   * dejó de ser verdad al pasar al acopio semanal: los pedidos se cierran el
   * jueves al mediodía y los despachos salen el domingo. Prometer entrega el
   * mismo día era comprometer a la operación con algo que no puede cumplir.
   * La versión de ahora cuenta el ciclo real y usa la espera como argumento:
   * no se cosecha hasta saber qué se pidió.
   *
   * Las fechas concretas del ciclo salen de `ordering-window.ts` y se muestran
   * en el carrito y el checkout; aquí basta la regla, que no cambia.
   */
  protected readonly guarantees = [
 {
    title: 'Se cosecha para tu pedido',
    body: 'Pides hasta el jueves al mediodía y el domingo sale de la finca a tu casa. Nada espera en bodega.',
  },
  {
    title: 'Precio justo en origen',
    body: 'El 72 % de lo que pagas se queda en la finca que lo cultivó, beneficiando directamente a nuestros campesinos.',
  },
  {
    title: 'Empaque consciente',
    body: 'Puedes elegir nuestra canastilla retornable o recibir tu pedido en bolsa. Así reducimos el consumo de plástico.',
  },
  {
    title: 'Del campo a tu casa',
    body: 'Productos frescos, saludables y de calidad, provenientes de la economía campesina y sin intermediarios.',
  },
  ];
}
