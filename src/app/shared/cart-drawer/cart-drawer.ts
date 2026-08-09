import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { CartService } from '../../core/services/cart.service';
import { CopPipe } from '../pipes/cop.pipe';
import { FREE_SHIPPING_THRESHOLD } from '../../core/models/cart.model';

@Component({
  selector: 'app-cart-drawer',
  imports: [CopPipe],
  templateUrl: './cart-drawer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CartDrawer {
  protected readonly cart = inject(CartService);
  protected readonly freeShippingThreshold = FREE_SHIPPING_THRESHOLD;

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
