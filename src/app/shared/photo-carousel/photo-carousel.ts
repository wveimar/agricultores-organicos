import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

export interface CarouselPhoto {
  readonly url: string;
  readonly alt: string;
}

/**
 * Carrusel de fotos para la ficha de detalle de un producto.
 *
 * Sin librería externa: una imagen a la vez, con flechas y puntos. Se
 * intercambia el `src` en vez de deslizar varias imágenes a la vez —más
 * simple, y en un carrusel de 3–6 fotos la diferencia no se nota—.
 */
@Component({
  selector: 'app-photo-carousel',
  templateUrl: './photo-carousel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoCarousel {
  readonly photos = input.required<readonly CarouselPhoto[]>();

  protected readonly index = signal(0);

  protected readonly current = computed(() => this.photos()[this.index()]);
  protected readonly hasMultiple = computed(() => this.photos().length > 1);

  protected go(i: number): void {
    const total = this.photos().length;
    this.index.set(((i % total) + total) % total);
  }

  protected prev(): void {
    this.go(this.index() - 1);
  }

  protected next(): void {
    this.go(this.index() + 1);
  }
}
