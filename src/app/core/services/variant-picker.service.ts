import { Injectable, computed, signal } from '@angular/core';
import { Product } from '../models/product.model';

/**
 * Qué producto tiene abierto el modal de variantes.
 *
 * ── Por qué un servicio y no un modal dentro de cada tarjeta ──
 *
 * Porque entonces habría un modal por tarjeta —cuarenta capas flotantes
 * dormidas en la rejilla— y cada uno viviría dentro de un `<article>` con
 * `group-hover` y transformaciones. Un `position: fixed` dentro de un ancestro
 * transformado deja de medirse contra la ventana y se ancla al ancestro: el
 * "modal a pantalla completa" acabaría recortado dentro de una tarjeta, y solo
 * en algunos navegadores.
 *
 * Es el mismo reparto que ya usa el carrito: el estado vive en un servicio y
 * la capa flotante se pinta una sola vez en `public-shell`, fuera de todo.
 */
@Injectable({ providedIn: 'root' })
export class VariantPicker {
  /** La madre cuyas variantes se están eligiendo, o `null` si está cerrado. */
  private readonly current = signal<Product | null>(null);

  readonly parent = this.current.asReadonly();
  readonly isOpen = computed(() => this.current() !== null);

  open(parent: Product): void {
    this.current.set(parent);
  }

  close(): void {
    this.current.set(null);
  }
}
