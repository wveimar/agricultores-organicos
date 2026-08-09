import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Hero } from '../hero/hero';
import { CategoryFilter } from '../category-filter/category-filter';
import { ProductGrid } from '../product-grid/product-grid';
import { RevealDirective } from '../../../shared/directives/reveal.directive';
import { STORY_IMAGE } from '../../../core/data/mock-catalog';

@Component({
  selector: 'app-shop-page',
  imports: [Hero, CategoryFilter, ProductGrid, RevealDirective],
  templateUrl: './shop-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShopPage {
  protected readonly storyImage = STORY_IMAGE;

  protected readonly guarantees = [
    {
      title: 'Cosechado hoy',
      body: 'Se recoge por la mañana y sale hacia tu casa el mismo día.',
    },
    {
      title: 'Precio justo en origen',
      body: 'El 72 % de lo que pagas se queda en la finca que lo cultivó.',
    },
    {
      title: 'Sin plástico',
      body: 'Empacamos en papel y canastas retornables que recogemos gratis.',
    },
    {
      title: 'Si no te gusta, no lo pagas',
      body: 'Nos lo dices y te devolvemos el valor de ese producto.',
    },
  ];
}
