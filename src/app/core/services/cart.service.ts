import { Injectable, computed, signal } from '@angular/core';
import { CartItem, FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../models/cart.model';
import { Product, isInStock } from '../models/product.model';

@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly lines = signal<readonly CartItem[]>([]);

  readonly items = this.lines.asReadonly();
  readonly isOpen = signal(false);

  /** Se pone a true durante 400 ms para disparar el pulso del icono del header. */
  readonly justAdded = signal(false);

  readonly count = computed(() =>
    this.lines().reduce((total, line) => total + line.quantity, 0),
  );

  readonly subtotal = computed(() =>
    this.lines().reduce((total, line) => total + line.product.price * line.quantity, 0),
  );

  readonly isEmpty = computed(() => this.lines().length === 0);

  readonly shipping = computed(() => {
    if (this.isEmpty() || this.subtotal() >= FREE_SHIPPING_THRESHOLD) {
      return 0;
    }
    return SHIPPING_COST;
  });

  readonly total = computed(() => this.subtotal() + this.shipping());

  /** Cuánto falta para el envío gratis. 0 significa que ya se alcanzó. */
  readonly amountToFreeShipping = computed(() =>
    Math.max(0, FREE_SHIPPING_THRESHOLD - this.subtotal()),
  );

  /** Progreso 0–1 hacia el envío gratis, para la barra del drawer. */
  readonly freeShippingProgress = computed(() =>
    Math.min(1, this.subtotal() / FREE_SHIPPING_THRESHOLD),
  );

  add(product: Product, quantity = 1): void {
    if (!isInStock(product)) {
      return;
    }

    this.lines.update((lines) => {
      const existing = lines.find((line) => line.product.id === product.id);
      if (!existing) {
        return [...lines, { product, quantity }];
      }
      return lines.map((line) =>
        line.product.id === product.id ? { ...line, quantity: line.quantity + quantity } : line,
      );
    });

    this.pulse();
  }

  setQuantity(productId: string, quantity: number): void {
    if (quantity <= 0) {
      this.remove(productId);
      return;
    }
    this.lines.update((lines) =>
      lines.map((line) => (line.product.id === productId ? { ...line, quantity } : line)),
    );
  }

  remove(productId: string): void {
    this.lines.update((lines) => lines.filter((line) => line.product.id !== productId));
  }

  clear(): void {
    this.lines.set([]);
  }

  quantityOf(productId: string): number {
    return this.lines().find((line) => line.product.id === productId)?.quantity ?? 0;
  }

  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    this.isOpen.update((open) => !open);
  }

  private pulseTimer?: ReturnType<typeof setTimeout>;

  private pulse(): void {
    clearTimeout(this.pulseTimer);
    this.justAdded.set(true);
    this.pulseTimer = setTimeout(() => this.justAdded.set(false), 400);
  }
}
