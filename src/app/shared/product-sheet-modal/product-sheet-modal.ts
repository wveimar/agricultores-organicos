import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CartService } from '../../core/services/cart.service';
import { CatalogService } from '../../core/services/catalog.service';
import { ProductSheet } from '../../core/services/product-sheet.service';
import {
  Product,
  componentPortion,
  isInStock,
  unitPresentation,
} from '../../core/models/product.model';
import { CopPipe } from '../pipes/cop.pipe';

/** Una fila del selector: la variante y todo lo que hay que pintar de ella. */
export interface VariantChoice {
  readonly product: Product;
  /** Lo que la distingue: «500 gr», «Jamaica». Sin repetir el nombre de la madre. */
  readonly label: string;
  /** La presentación, cuando aporta algo que `label` no dice ya. */
  readonly detail: string | null;
  readonly available: boolean;
  readonly inCart: number;
  /** Ya tiene en la canasta todas las unidades que quedan. */
  readonly atLimit: boolean;
  /** Quedan pocas: se avisa para que elegir esa opción sea una decisión informada. */
  readonly lowStock: boolean;
  /**
   * Si la línea de debajo del nombre tiene algo que decir.
   *
   * En la miel no lo tiene nunca: el nombre de cada variante ya *es* su
   * presentación («500 gr»), así que `detail` queda en `null`, y si además hay
   * existencias de sobra tampoco hay aviso de stock. Sin esta bandera esa línea
   * se pintaba igual, vacía, y se comía ~22 px por fila.
   */
  readonly hasNote: boolean;
}

/**
 * A partir de cuántas unidades se avisa de que queda poco.
 *
 * Es un número fijo y no `safetyStock`: ese umbral solo llega en las respuestas
 * de `/api/admin/*`, así que en la tienda pública vale 0 y la advertencia no
 * saltaría nunca. Aquí interesa lo que el cliente percibe como "se acaba", no
 * el punto de reposición del agricultor.
 */
const POCAS_UNIDADES = 5;

/**
 * Hoja de detalle de un producto, antes de añadirlo.
 *
 * Cubre los dos casos en que tocar una tarjeta no puede añadir nada a ciegas:
 *
 * - **Madre con variantes**: hay que elegir cuál de los tres tarros se
 *   descuenta, así que la hoja pinta radios y el botón añade el elegido.
 * - **Canasta**: se añade ella misma, pero antes conviene poder ver qué lleva
 *   dentro. La hoja pinta la receta en solo lectura y el botón añade la
 *   canasta entera.
 *
 * Cuál de los dos manda lo decide `mode()`, no quien abre la hoja: la tarjeta
 * solo dice "enseña este producto".
 *
 * Se pinta una sola vez en `public-shell`, no una por tarjeta: ver el porqué
 * en `ProductSheet`. Todo sale del catálogo que ya está en memoria — abrirla
 * no dispara ninguna petición.
 */
@Component({
  selector: 'app-product-sheet-modal',
  imports: [CopPipe],
  templateUrl: './product-sheet-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductSheetModal {
  private readonly cart = inject(CartService);
  private readonly catalog = inject(CatalogService);
  protected readonly sheet = inject(ProductSheet);

  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  /** Elemento que abrió el modal, para devolverle el foco al cerrar. */
  private trigger: HTMLElement | null = null;

  protected readonly selectedId = signal<string | null>(null);

  /**
   * Qué pinta la hoja. Las variantes mandan sobre la receta: si una madre
   * llegara a tener las dos cosas, sin elegir variante no hay nada concreto
   * que añadir, así que esa decisión va primero.
   */
  protected readonly mode = computed<'variantes' | 'canasta' | null>(() => {
    const product = this.sheet.product();
    if (!product) {
      return null;
    }
    if (this.catalog.getProductVariants(product.id).length > 0) {
      return 'variantes';
    }
    return (product.contains?.length ?? 0) > 0 ? 'canasta' : null;
  });

  /** Lo que lleva dentro, en modo canasta. */
  protected readonly contenido = computed(() => this.sheet.product()?.contains ?? []);

  /** «2 × 500 gr». Misma regla que la tarjeta y el checkout. */
  protected readonly porcion = componentPortion;

  /**
   * Cómo se llama lo que se elige. Sin dato en la madre, «opción»: neutro y
   * siempre cierto, que es mejor que adivinar «presentación» y equivocarse.
   */
  protected readonly what = computed(() => this.sheet.product()?.variantLabel ?? 'opción');

  protected readonly choices = computed<readonly VariantChoice[]>(() => {
    const parent = this.sheet.product();
    if (!parent) {
      return [];
    }

    return this.catalog.getProductVariants(parent.id).map((product) => {
      const label = distinguishing(product.name, parent.name);
      const presentation = unitPresentation(product.quantity, product.unit);

      // En la miel el nombre ya *es* la presentación («500 gr»): repetirla
      // debajo sería ruido. En la kambucha, en cambio, «350 mililitros» es
      // justo lo que no se puede deducir de «Jamaica».
      const detail = presentation === label ? null : presentation;
      const available = isInStock(product);
      const inCart = this.cart.quantityOf(product.id);
      const atLimit = this.cart.atStockLimit(product.id);
      const lowStock = product.stock > 0 && product.stock <= POCAS_UNIDADES;

      return {
        product,
        label,
        detail,
        available,
        inCart,
        atLimit,
        lowStock,
        // Las mismas condiciones que la plantilla pinta en esa línea. Si
        // ninguna se cumple, la línea no existe en vez de existir vacía.
        hasNote: detail !== null || !available || atLimit || inCart > 0 || lowStock,
      };
    });
  });

  protected readonly selected = computed<VariantChoice | null>(() => {
    const id = this.selectedId();
    return this.choices().find((choice) => choice.product.id === id) ?? null;
  });

  /**
   * Nada que añadir: ninguna variante con existencias, o la canasta sin stock.
   *
   * El de la canasta no es un número que nadie escriba: el servidor lo calcula
   * con el componente que primero se agote, así que «no queda» aquí significa
   * «falta algo de lo que lleva dentro».
   */
  protected readonly soldOut = computed(() => {
    if (this.mode() === 'canasta') {
      const product = this.sheet.product();
      return product !== null && !isInStock(product);
    }
    const opciones = this.choices();
    return opciones.length > 0 && opciones.every((choice) => !choice.available);
  });

  protected readonly canAdd = computed(() => {
    if (this.mode() === 'canasta') {
      const product = this.sheet.product();
      return product !== null && isInStock(product) && !this.cart.atStockLimit(product.id);
    }
    const choice = this.selected();
    return choice !== null && choice.available && !choice.atLimit;
  });

  /** Cuántas de esta canasta van ya en el carrito, para avisarlo en el pie. */
  protected readonly basketInCart = computed(() => {
    const product = this.sheet.product();
    return product ? this.cart.quantityOf(product.id) : 0;
  });

  constructor() {
    effect(() => {
      const product = this.sheet.product();

      // El fondo no debe poder desplazarse detrás de la hoja abierta.
      document.body.style.overflow = product ? 'hidden' : '';

      if (!product) {
        this.trigger?.focus();
        this.trigger = null;
        return;
      }

      this.trigger = document.activeElement as HTMLElement | null;

      // La preselección se calcula al abrir y no como `computed`: a partir de
      // ahí manda lo que elija la persona, y una señal derivada le movería la
      // selección sola en cuanto el catálogo se recargara. En una canasta no
      // hay nada que preseleccionar: `choices()` viene vacío y esto no hace
      // nada, que es justo lo que toca.
      untracked(() => {
        const opciones = this.choices();
        const primera = opciones.find((choice) => choice.available && !choice.atLimit);
        this.selectedId.set((primera ?? opciones[0])?.product.id ?? null);
      });

      // El modal se monta en este mismo tick; el foco se mueve en el siguiente.
      queueMicrotask(() => this.closeButton()?.nativeElement.focus());
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.sheet.isOpen()) {
      this.sheet.close();
    }
  }

  protected select(productId: string): void {
    this.selectedId.set(productId);
  }

  /**
   * Añade lo que corresponda: la variante elegida, o la canasta entera.
   *
   * `canAdd()` ya distingue los dos casos, así que aquí solo hay que decidir
   * *qué* producto se añade — el carrito no sabe que las canastas existen: para
   * él es un producto más, y el servidor se encarga de expandir su receta.
   */
  protected confirm(): void {
    if (!this.canAdd()) {
      return;
    }

    const producto = this.mode() === 'canasta' ? this.sheet.product() : this.selected()?.product;
    if (!producto) {
      return;
    }

    this.cart.add(producto);
    this.sheet.close();
  }
}

/**
 * Le quita al nombre de la variante el nombre de su madre.
 *
 * «Miel de Abejas · 500 gr» → «500 gr»; «Kambucha · Jamaica» → «Jamaica». En
 * un modal titulado "Miel de Abejas", repetir esas tres palabras en cada una
 * de las tres filas no informa de nada y empuja fuera lo único que distingue a
 * una opción de otra.
 *
 * Si el nombre no empieza por el de la madre —porque se escribió de otra
 * forma— se devuelve entero: preferible a recortar por adivinanza.
 */
function distinguishing(name: string, parentName: string): string {
  if (!name.toLowerCase().startsWith(parentName.toLowerCase())) {
    return name;
  }
  // Se comen los separadores que se suelen escribir entre el nombre y la
  // variante: «·», «-», «–», «:» y los espacios alrededor.
  const rest = name.slice(parentName.length).replace(/^[\s·\-–—:|]+/, '');
  return rest || name;
}
