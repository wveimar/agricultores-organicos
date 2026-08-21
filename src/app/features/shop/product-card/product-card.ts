import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CartService } from '../../../core/services/cart.service';
import { CatalogService } from '../../../core/services/catalog.service';
import { ProductSheet } from '../../../core/services/product-sheet.service';
import {
  BADGE_LABELS,
  Product,
  componentPortion,
  isInStock,
  pluralizeVariantLabel,
  summarizeVariants,
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
  private readonly catalog = inject(CatalogService);
  private readonly sheet = inject(ProductSheet);

  /**
   * Resumen de las variantes, o `null` si este producto se vende solo.
   *
   * Cuando existe, manda sobre casi toda la ficha: el stock de la tarjeta es
   * la suma del de sus variantes (la fila madre tiene 0, porque no hay ningún
   * tarro que se llame "Miel de Abejas" a secas) y el precio es el de la más
   * barata que quede.
   */
  protected readonly variants = computed(() =>
    summarizeVariants(this.catalog.getProductVariants(this.product().id)),
  );

  /** «presentación», «sabor»… o «opción» si la madre no lo dice. */
  protected readonly variantWord = computed(() => this.product().variantLabel ?? 'opción');

  /** «3 presentaciones», «3 sabores». */
  protected readonly variantCountLabel = computed(() => {
    const count = this.variants()?.count ?? 0;
    return `${count} ${pluralizeVariantLabel(this.variantWord(), count)}`;
  });

  /** "500 gr", "5 unidades", o solo "kg" cuando la cantidad es 1. */
  protected readonly unitLabel = computed(() =>
    unitPresentation(this.product().quantity, this.product().unit),
  );

  /** «2 × 500 gr». La regla vive en el modelo: la pintan cuatro pantallas. */
  protected readonly porcion = componentPortion;

  /**
   * «5 productos»: en móvil sustituye a la lista completa de la canasta.
   *
   * La lista entera son ~120 px de alto, que en una tarjeta de 150 px de ancho
   * es más que la foto. Pero ocultarla sin más dejaría la canasta idéntica a un
   * producto suelto, y lo que se compra de una canasta es justo lo que lleva
   * dentro. El recuento conserva esa señal por una línea, y al ser un botón
   * abre la hoja con el detalle: en móvil es la única forma de verlo.
   */
  protected readonly contentsLabel = computed(() => {
    const contenido = this.product().contains;
    if (!contenido || contenido.length === 0) {
      return null;
    }
    return `${contenido.length} ${contenido.length === 1 ? 'producto' : 'productos'}`;
  });

  /** Abre la hoja con la receta. Solo se ofrece en móvil: ver la plantilla. */
  protected verContenido(): void {
    this.sheet.open(this.product());
  }
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
  protected readonly available = computed(() => {
    const grupo = this.variants();
    return grupo ? grupo.stock > 0 : isInStock(this.product());
  });

  /** Lo que se cobra: el propio, o el de la variante más barata disponible. */
  protected readonly price = computed(
    () => this.variants()?.fromPrice ?? this.product().price,
  );

  /**
   * `true` cuando las variantes no cuestan lo mismo y hay que decir «Desde».
   * Con los tres sabores de kambucha a un mismo precio se calla, porque ahí un
   * "desde" sugeriría que alguno cuesta más.
   */
  protected readonly priceFrom = computed(() => {
    const grupo = this.variants();
    return grupo !== null && !grupo.samePrice;
  });

  /**
   * Si lo que se muestra lleva tarifa de mayorista.
   *
   * En una ficha con variantes la pregunta no es por la fila madre —que no se
   * vende y podría tener su propio descuento configurado por descuido— sino
   * por las hijas, que son las que se cobran. `price()` ya viene descontado
   * porque el servidor aplica la tarifa fila a fila.
   */
  protected readonly wholesale = computed(() => {
    const hijas = this.catalog.getProductVariants(this.product().id);
    return hijas.length > 0
      ? hijas.some((variant) => variant.listPrice !== undefined)
      : this.product().listPrice !== undefined;
  });

  /** Unidades ya en la canasta sumando todas las variantes de esta ficha. */
  private readonly inCartVariants = computed(() =>
    this.catalog
      .getProductVariants(this.product().id)
      .reduce((total, variant) => total + this.cart.quantityOf(variant.id), 0),
  );

  protected readonly discountPercent = computed(() => {
    const { price, compareAtPrice } = this.product();
    if (!compareAtPrice || compareAtPrice <= price) {
      return null;
    }
    return Math.round((1 - price / compareAtPrice) * 100);
  });

  /** Unidades ya añadidas, para mostrarlo en el botón. */
  protected readonly inCart = computed(() =>
    this.variants() ? this.inCartVariants() : this.cart.quantityOf(this.product().id),
  );

  /** Texto del botón. Con variantes no se añade nada: se abre la elección. */
  protected readonly actionLabel = computed(() => {
    const grupo = this.variants();

    if (grupo) {
      return this.inCart() > 0
        ? `Elegir otra · ${this.inCart()} en la canasta`
        : `Elegir entre ${grupo.count}`;
    }

    return this.inCart() > 0 ? `Añadir otro · ${this.inCart()} en el carrito` : 'Añadir';
  });

  /**
   * Nombre accesible del botón, para las dos versiones —el rectangular de
   * escritorio y el redondo de móvil—.
   *
   * `actionLabel()` no sirve aquí: en una rejilla de veinte tarjetas, veinte
   * botones llamados «Añadir» son indistinguibles al navegar por lista de
   * enlaces. Este siempre nombra el producto. En móvil, además, el botón es
   * solo un icono, así que esto es lo único que lo describe.
   */
  protected readonly addAriaLabel = computed(() => {
    const base = this.variants()
      ? `Elegir ${this.variantWord()} de ${this.product().name}`
      : `Añadir ${this.product().name} al carrito`;

    if (this.inCart() === 0) {
      return base;
    }
    return `${base} · ${this.inCart()} en ${this.variants() ? 'la canasta' : 'el carrito'}`;
  });

  /**
   * Un producto con variantes no se puede añadir de un clic: no se sabría cuál
   * de los tres tarros descontar. El botón abre el modal, y el que añade de
   * verdad es él, con el id de la variante concreta. El Worker rechaza la
   * madre por si alguien llama a la API sin pasar por aquí.
   */
  protected add(): void {
    if (this.variants()) {
      this.sheet.open(this.product());
      return;
    }
    this.cart.add(this.product());
  }
}
