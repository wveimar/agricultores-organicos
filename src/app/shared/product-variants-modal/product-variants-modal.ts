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
import { VariantPicker } from '../../core/services/variant-picker.service';
import { Product, isInStock, unitPresentation } from '../../core/models/product.model';
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
 * Elegir presentación o sabor antes de añadir a la canasta.
 *
 * Se pinta una sola vez en `public-shell`, no una por tarjeta: ver el porqué
 * en `VariantPicker`. Lo que muestra sale de `VariantPicker.parent()`, y las
 * variantes del catálogo que ya está en memoria — abrir el modal no dispara
 * ninguna petición.
 */
@Component({
  selector: 'app-product-variants-modal',
  imports: [CopPipe],
  templateUrl: './product-variants-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductVariantsModal {
  private readonly cart = inject(CartService);
  private readonly catalog = inject(CatalogService);
  protected readonly picker = inject(VariantPicker);

  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  /** Elemento que abrió el modal, para devolverle el foco al cerrar. */
  private trigger: HTMLElement | null = null;

  protected readonly selectedId = signal<string | null>(null);

  /**
   * Cómo se llama lo que se elige. Sin dato en la madre, «opción»: neutro y
   * siempre cierto, que es mejor que adivinar «presentación» y equivocarse.
   */
  protected readonly what = computed(() => this.picker.parent()?.variantLabel ?? 'opción');

  protected readonly choices = computed<readonly VariantChoice[]>(() => {
    const parent = this.picker.parent();
    if (!parent) {
      return [];
    }

    return this.catalog.getProductVariants(parent.id).map((product) => {
      const label = distinguishing(product.name, parent.name);
      const presentation = unitPresentation(product.quantity, product.unit);

      return {
        product,
        label,
        // En la miel el nombre ya *es* la presentación («500 gr»): repetirla
        // debajo sería ruido. En la kambucha, en cambio, «350 mililitros» es
        // justo lo que no se puede deducir de «Jamaica».
        detail: presentation === label ? null : presentation,
        available: isInStock(product),
        inCart: this.cart.quantityOf(product.id),
        atLimit: this.cart.atStockLimit(product.id),
        lowStock: product.stock > 0 && product.stock <= POCAS_UNIDADES,
      };
    });
  });

  protected readonly selected = computed<VariantChoice | null>(() => {
    const id = this.selectedId();
    return this.choices().find((choice) => choice.product.id === id) ?? null;
  });

  /** Ninguna variante con existencias: la madre está agotada por completo. */
  protected readonly soldOut = computed(() => {
    const opciones = this.choices();
    return opciones.length > 0 && opciones.every((choice) => !choice.available);
  });

  protected readonly canAdd = computed(() => {
    const choice = this.selected();
    return choice !== null && choice.available && !choice.atLimit;
  });

  constructor() {
    effect(() => {
      const parent = this.picker.parent();

      // El fondo no debe poder desplazarse detrás de la hoja abierta.
      document.body.style.overflow = parent ? 'hidden' : '';

      if (!parent) {
        this.trigger?.focus();
        this.trigger = null;
        return;
      }

      this.trigger = document.activeElement as HTMLElement | null;

      // La preselección se calcula al abrir y no como `computed`: a partir de
      // ahí manda lo que elija la persona, y una señal derivada le movería la
      // selección sola en cuanto el catálogo se recargara.
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
    if (this.picker.isOpen()) {
      this.picker.close();
    }
  }

  protected select(productId: string): void {
    this.selectedId.set(productId);
  }

  protected confirm(): void {
    const choice = this.selected();
    if (!choice || !this.canAdd()) {
      return;
    }
    this.cart.add(choice.product);
    this.picker.close();
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
