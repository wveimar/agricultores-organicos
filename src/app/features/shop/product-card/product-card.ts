import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CartService } from '../../../core/services/cart.service';
import {
  BADGE_LABELS,
  Product,
  isInStock,
  unitPresentation,
} from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Color de fondo de cada etiqueta. Ver doc/plan.md §2. */
const BADGE_CLASSES: Record<string, string> = {
  nuevo: 'bg-sage-light text-moss-deep',
  bestseller: 'bg-clay text-bone',
  temporada: 'bg-honey text-moss-deep',
  'ultimas-unidades': 'bg-berry text-bone',
};

@Component({
  selector: 'app-product-card',
  imports: [CopPipe],
  templateUrl: './product-card.html',
  // El host es el hijo directo de la rejilla y es quien recibe el `stretch`.
  // Sin este `flex flex-col`, el <article> se ajusta a su contenido y el
  // `mt-auto` del precio no tiene espacio sobrante que empujar: los precios
  // de una misma fila quedan a alturas distintas.
  host: { class: 'flex flex-col' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductCard {
  readonly product = input.required<Product>();

  /** Posición en la rejilla: las 4 primeras imágenes no se difieren (LCP). */
  readonly index = input<number>(99);

  private readonly cart = inject(CartService);

  /** "500 gr", "5 unidades", o solo "kg" cuando la cantidad es 1. */
  protected readonly unitLabel = computed(() =>
    unitPresentation(this.product().quantity, this.product().unit),
  );
  protected readonly badgeLabel = computed(() => {
    const badge = this.product().badge;
    return badge ? BADGE_LABELS[badge] : null;
  });
  protected readonly badgeClass = computed(() => {
    const badge = this.product().badge;
    return badge ? BADGE_CLASSES[badge] : '';
  });

  protected readonly isPriority = computed(() => this.index() < 4);

  /** Disponibilidad derivada del inventario, no de un booleano guardado aparte. */
  protected readonly available = computed(() => isInStock(this.product()));

  protected readonly discountPercent = computed(() => {
    const { price, compareAtPrice } = this.product();
    if (!compareAtPrice || compareAtPrice <= price) {
      return null;
    }
    return Math.round((1 - price / compareAtPrice) * 100);
  });

  /** Unidades ya añadidas, para mostrarlo en el botón. */
  protected readonly inCart = computed(() => this.cart.quantityOf(this.product().id));

  protected add(): void {
    this.cart.add(this.product());
  }
}
