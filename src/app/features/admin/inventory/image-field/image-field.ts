import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import {
  MAX_FILE_BYTES,
  PRODUCT_PRESET,
  formatBytes,
  processImage,
  validateFile,
} from '../../../../shared/utils/image-file';

type Mode = 'enlace' | 'archivo';

/**
 * Campo de imagen con dos formas de rellenarlo: pegar un enlace o subir un
 * archivo.
 *
 * El enlace no es una comodidad, es la opción barata: una URL ocupa ~60 bytes
 * en D1 y la sirve el CDN de quien la aloja, mientras que una foto subida se
 * guarda como data URL y suma ~140 KB **a cada respuesta del catálogo**, que
 * las manda todas juntas. Con 60 productos eso es la diferencia entre 37 KB y
 * 16 MB por visita a la tienda. Por eso el enlace es el modo por defecto.
 *
 * Vive aquí y no en `shared/` porque solo lo usan las pantallas de producto
 * del panel; las cuatro instancias (principal y hover, en crear y en editar)
 * son la razón de que sea un componente y no dos bloques copiados.
 */
@Component({
  selector: 'app-image-field',
  imports: [ReactiveFormsModule],
  templateUrl: './image-field.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageField {
  readonly control = input.required<FormControl<string>>();
  readonly label = input.required<string>();
  readonly fieldId = input.required<string>();
  readonly hint = input('');

  protected readonly error = signal<string | null>(null);
  protected readonly processing = signal(false);

  /**
   * El modo arranca mirando lo que ya hay: al editar un producto con foto de
   * Unsplash se abre en "Enlace" y con la URL a la vista. Antes el formulario
   * solo mostraba un `input type=file`, así que la imagen actual era
   * invisible y no había forma de corregir la URL sin volver a subir algo.
   */
  private readonly manualMode = signal<Mode | null>(null);

  protected readonly mode = computed<Mode>(
    () => this.manualMode() ?? (this.isDataUrl() ? 'archivo' : 'enlace'),
  );

  protected readonly value = computed(() => this.control().value ?? '');

  protected readonly isDataUrl = computed(() => this.value().startsWith('data:'));

  /** Peso real de lo que se va a guardar, para que la decisión sea informada. */
  protected readonly weight = computed(() => {
    const value = this.value();
    if (!value) {
      return null;
    }
    return this.isDataUrl()
      ? formatBytes(Math.round((value.length - value.indexOf(',') - 1) * 0.75))
      : `${value.length} B`;
  });

  protected setMode(mode: Mode): void {
    this.manualMode.set(mode);
    this.error.set(null);
  }

  protected clear(): void {
    this.control().setValue('');
    this.control().markAsDirty();
    this.error.set(null);
  }

  protected onUrl(event: Event): void {
    this.control().setValue((event.target as HTMLInputElement).value.trim());
    this.control().markAsDirty();
  }

  /**
   * La foto se redimensiona antes de guardarla: una foto de móvil son ~4 MB,
   * que en base64 pasan de los 2 MB que D1 admite por fila.
   */
  protected async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    const invalid = validateFile(file);
    if (invalid) {
      this.error.set(
        invalid === 'tipo'
          ? 'Ese formato no sirve. Usa JPG, PNG o WEBP.'
          : `La imagen supera los ${formatBytes(MAX_FILE_BYTES)}.`,
      );
      input.value = '';
      return;
    }

    this.error.set(null);
    this.processing.set(true);

    try {
      const { dataUrl } = await processImage(file, PRODUCT_PRESET);
      this.control().setValue(dataUrl);
      this.control().markAsDirty();
    } catch {
      this.error.set('No se pudo leer esa imagen. Prueba con otra.');
      input.value = '';
    } finally {
      this.processing.set(false);
    }
  }

  /** La vista previa falla sola si la URL no apunta a una imagen. */
  protected onPreviewError(): void {
    this.error.set('Ese enlace no carga como imagen. Revisa que sea directo al archivo.');
  }

  protected onPreviewLoad(): void {
    this.error.set(null);
  }
}
