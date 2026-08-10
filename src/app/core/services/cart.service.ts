import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { CartItem, FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../models/cart.model';
import { Product, isInStock } from '../models/product.model';
import { CatalogService } from './catalog.service';
import { KV_KEYS, KvStore } from './kv-store.service';

/** Lo único que se guarda del carrito: el resto se resuelve del catálogo. */
interface StoredLine {
  readonly productId: string;
  readonly quantity: number;
}

@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly kv = inject(KvStore);
  private readonly catalog = inject(CatalogService);

  private readonly lines = signal<readonly CartItem[]>([]);
  private hydrated = false;

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

  constructor() {
    /**
     * Un solo `effect`, y el orden importa. Con dos efectos separados (uno
     * que hidrata, otro que persiste) el de persistencia corría primero en su
     * primera ejecución —`lines` seguía en `[]`— y sobrescribía el carrito
     * guardado en `localStorage` con un array vacío *antes* de que el
     * catálogo terminara de cargar. Cuando el efecto de hidratación por fin
     * intentaba leerlo, ya no quedaba nada que leer: el carrito aparecía
     * vacío en el checkout aunque el usuario sí hubiera añadido productos.
     *
     * Aquí, mientras el catálogo no haya cargado, el efecto no lee `lines()`
     * y por tanto no depende de esa señal — no se reprograma con cada
     * `add()`/`remove()` hasta que la rama de hidratación caiga al bloque de
     * persistencia y la lea por primera vez, dejándola como dependencia real.
     */
    effect(() => {
      if (!this.hydrated) {
        if (this.catalog.loading()) {
          return;
        }
        this.hydrated = true;
        this.lines.set(this.hydrate());
        // Sin `return` aquí a propósito: sigue hacia abajo en esta misma
        // ejecución para leer `lines()` y persistir el carrito ya hidratado.
      }

      const stored: StoredLine[] = this.lines().map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
      }));
      this.kv.put(KV_KEYS.cart, stored);
    });
  }

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

  /**
   * Rehidrata contra el catálogo ya cargado en vez de guardar el producto
   * entero. Si algo se retiró del catálogo o se agotó mientras el carrito
   * esperaba, la línea desaparece sola: es preferible a dejar al cliente
   * llegar al checkout con algo que ya no se puede vender.
   */
  private hydrate(): readonly CartItem[] {
    const stored = this.kv.get<StoredLine[]>(KV_KEYS.cart);
    if (!stored?.length) {
      return [];
    }

    const items: CartItem[] = [];
    for (const line of stored) {
      const product = this.catalog.productById(line.productId);
      if (!product || !isInStock(product)) {
        continue;
      }
      const quantity = Math.min(Math.max(1, Math.round(line.quantity)), product.stock);
      items.push({ product, quantity });
    }
    return items;
  }

  private pulseTimer?: ReturnType<typeof setTimeout>;

  private pulse(): void {
    clearTimeout(this.pulseTimer);
    this.justAdded.set(true);
    this.pulseTimer = setTimeout(() => this.justAdded.set(false), 400);
  }
}
