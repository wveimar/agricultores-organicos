import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ApiClient, ApiErrorBody, ApiProductPhoto } from '../../../../core/api/api-client';
import { ImageField } from '../image-field/image-field';

/**
 * Galería de fotos de un producto (migración 0039): el carrusel de su ficha
 * de detalle pública (`TourDetailPage`) — sobre todo para un tour, donde una
 * sola imagen no alcanza a mostrar el sitio, el recorrido y el grupo.
 *
 * Mismo patrón que `SessionsEditor`: recibe el id del producto ya creado
 * (una foto no existe sin su producto), llama directo a `ApiClient` para
 * este sub-recurso, y cada respuesta trae la lista completa actualizada.
 */
@Component({
  selector: 'app-photo-gallery-editor',
  imports: [ReactiveFormsModule, ImageField],
  templateUrl: './photo-gallery-editor.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhotoGalleryEditor {
  private readonly api = inject(ApiClient);

  readonly productId = input.required<string>();

  protected readonly photos = signal<readonly ApiProductPhoto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);

  /** Formulario de alta: mismo campo de imagen (enlace o archivo) que usa el producto. */
  protected readonly nuevaFotoUrl = new FormControl('', { nonNullable: true });
  protected readonly nuevaFotoAlt = signal('');
  protected readonly adding = signal(false);

  constructor() {
    queueMicrotask(() => this.load());
  }

  private load(): void {
    this.loading.set(true);
    this.api.listProductPhotos(this.productId()).subscribe({
      next: (fotos) => {
        this.photos.set(fotos);
        this.loading.set(false);
      },
      error: (err: ApiErrorBody) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected add(): void {
    const url = this.nuevaFotoUrl.value.trim();
    if (!url) {
      return;
    }

    this.adding.set(true);
    this.error.set(null);

    this.api
      .createProductPhoto(this.productId(), {
        url,
        alt: this.nuevaFotoAlt().trim() || undefined,
      })
      .subscribe({
        next: (fotos) => {
          this.photos.set(fotos);
          this.adding.set(false);
          this.nuevaFotoUrl.setValue('');
          this.nuevaFotoAlt.set('');
        },
        error: (err: ApiErrorBody) => {
          this.adding.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected remove(photo: ApiProductPhoto): void {
    this.busyId.set(photo.id);
    this.error.set(null);

    this.api.deleteProductPhoto(this.productId(), photo.id).subscribe({
      next: (fotos) => {
        this.photos.set(fotos);
        this.busyId.set(null);
      },
      error: (err: ApiErrorBody) => {
        this.busyId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected updateAlt(photo: ApiProductPhoto, event: Event): void {
    const alt = (event.target as HTMLInputElement).value;
    if (alt === photo.alt) {
      return;
    }

    this.busyId.set(photo.id);
    this.error.set(null);

    this.api.updateProductPhoto(this.productId(), photo.id, { alt }).subscribe({
      next: (fotos) => {
        this.photos.set(fotos);
        this.busyId.set(null);
      },
      error: (err: ApiErrorBody) => {
        this.busyId.set(null);
        this.error.set(err.message);
      },
    });
  }

  /**
   * Sube o baja una foto un puesto.
   *
   * `ApiProductPhoto` no expone `orden` al panel (solo `id`/`url`/`alt`), así
   * que un intercambio de únicamente las dos posiciones tocadas —usando su
   * índice como `orden` nuevo— se desincroniza en cuanto conviven fotos con
   * `orden` "viejo" (p. ej. una siembra por lotes de 10 en 10) y fotos
   * nuevas (que nacen en 100 por defecto en el Worker): el índice de una
   * posición no tiene por qué caer entre los `orden` reales de sus vecinas.
   * La forma robusta es renumerar la lista entera 0..n-1 en el orden que
   * queda tras el intercambio — ver `renumerar()`.
   */
  protected mover(photo: ApiProductPhoto, direccion: -1 | 1): void {
    const lista = [...this.photos()];
    const index = lista.findIndex((p) => p.id === photo.id);
    const vecinoIndex = index + direccion;
    if (index === -1 || vecinoIndex < 0 || vecinoIndex >= lista.length) {
      return;
    }
    [lista[index], lista[vecinoIndex]] = [lista[vecinoIndex], lista[index]];

    this.busyId.set(photo.id);
    this.error.set(null);
    this.renumerar(lista, 0);
  }

  /**
   * `PATCH orden = i` para cada foto de `lista`, en cadena y no en paralelo:
   * cada respuesta trae la lista completa ya reordenada, y encadenar es lo
   * que evita que dos `PATCH` en paralelo lleguen en cualquier orden y uno
   * pise el resultado del otro a medio camino.
   */
  private renumerar(lista: readonly ApiProductPhoto[], i: number): void {
    if (i >= lista.length) {
      this.busyId.set(null);
      return;
    }
    this.api.updateProductPhoto(this.productId(), lista[i].id, { orden: i }).subscribe({
      next: (fotos) => {
        if (i === lista.length - 1) {
          this.photos.set(fotos);
          this.busyId.set(null);
        } else {
          this.renumerar(lista, i + 1);
        }
      },
      error: (err: ApiErrorBody) => {
        this.busyId.set(null);
        this.error.set(err.message);
      },
    });
  }
}
