import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartService } from '../../core/services/cart.service';
import { CatalogService } from '../../core/services/catalog.service';
import { CopPipe } from '../pipes/cop.pipe';
import { FREE_SHIPPING_THRESHOLD } from '../../core/models/cart.model';
import { formatSessionDate } from '../../core/models/product.model';
import {
  formatDay,
  isCutoffNear,
  nextCutoff,
  nextDispatch,
} from '../../core/models/ordering-window';

@Component({
  selector: 'app-cart-drawer',
  imports: [CopPipe, RouterLink],
  templateUrl: './cart-drawer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CartDrawer {
  protected readonly cart = inject(CartService);
  private readonly catalog = inject(CatalogService);
  protected readonly freeShippingThreshold = FREE_SHIPPING_THRESHOLD;

  /**
   * `/mercado/checkout` o `/turismo/checkout` (0040): el carrito vive dentro
   * de `PublicShell`, cuyo workspace fijo `CatalogService.activeGroup()` ya
   * conoce (`lockWorkspace()`) — no hace falta un `input()` propio, el mismo
   * dato ya está en el mismo servicio que decide qué hay en el carrito.
   */
  protected readonly checkoutPath = computed(() => `/${this.catalog.activeGroup()}/checkout`);

  /**
   * Se resuelven al construir el panel, no en cada detección de cambios: son
   * fechas fijas dentro de la sesión y recalcularlas por render sería trabajo
   * repetido para un dato que solo cambia una vez a la semana.
   */
  protected readonly cutoffDay = formatDay(nextCutoff());
  protected readonly dispatchDay = formatDay(nextDispatch());
  protected readonly cutoffNear = isCutoffNear();
  /** «viernes 14 mar · 9:00 a. m.»: fecha de la sesión reservada de una línea. */
  protected readonly fechaSesion = formatSessionDate;

  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  /** Elemento que abrió el panel, para devolverle el foco al cerrar. */
  private trigger: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.cart.isOpen();

      // Bloquea el scroll del fondo mientras el panel está abierto.
      document.body.style.overflow = open ? 'hidden' : '';

      if (open) {
        this.trigger = document.activeElement as HTMLElement | null;
        // El panel se monta en este mismo tick; el foco se mueve en el siguiente.
        queueMicrotask(() => this.closeButton()?.nativeElement.focus());
      } else {
        this.trigger?.focus();
        this.trigger = null;
      }
    });
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.cart.isOpen()) {
      this.cart.close();
    }
  }

  protected decrease(productId: string, quantity: number): void {
    this.cart.setQuantity(productId, quantity - 1);
  }

  protected increase(productId: string, quantity: number): void {
    this.cart.setQuantity(productId, quantity + 1);
  }
}
