import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { PaymentProof } from '../../../core/models/order.model';
import {
  ACCEPTED_TYPES,
  FileError,
  formatBytes,
  processReceipt,
  validateFile,
} from '../../../shared/utils/image-file';

const ERROR_MESSAGES: Readonly<Record<FileError, string>> = {
  tipo: 'Sube una imagen (JPG, PNG o WEBP). Si tienes un PDF, hazle una captura.',
  tamano: 'La imagen pesa más de 8 MB. Intenta con una foto de menor resolución.',
  ilegible: 'No pudimos leer esa imagen. Prueba con otra o vuelve a tomar la foto.',
};

@Component({
  selector: 'app-proof-uploader',
  templateUrl: './proof-uploader.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProofUploader {
  readonly proofChange = output<PaymentProof | null>();

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly accept = ACCEPTED_TYPES.join(',');
  protected readonly isDragging = signal(false);
  protected readonly processing = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly proof = signal<PaymentProof | null>(null);
  protected readonly sizeLabel = signal('');

  protected openPicker(): void {
    this.fileInput().nativeElement.click();
  }

  protected onSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void this.handle(file);
    }
    // Permite volver a elegir el mismo archivo tras borrarlo.
    input.value = '';
  }

  // ── Drag & drop ──
  // `preventDefault` en dragover es lo que impide que el navegador abra la
  // imagen en una pestaña nueva en vez de entregárnosla.

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) {
      void this.handle(file);
    }
  }

  protected remove(): void {
    this.proof.set(null);
    this.error.set(null);
    this.sizeLabel.set('');
    this.proofChange.emit(null);
  }

  private async handle(file: File): Promise<void> {
    this.error.set(null);

    const invalid = validateFile(file);
    if (invalid) {
      this.error.set(ERROR_MESSAGES[invalid]);
      return;
    }

    this.processing.set(true);

    try {
      const image = await processReceipt(file);
      const proof: PaymentProof = {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'image/jpeg',
        dataUrl: image.dataUrl,
        uploadedAt: new Date().toISOString(),
      };

      this.proof.set(proof);
      this.sizeLabel.set(`${formatBytes(file.size)} → ${formatBytes(image.encodedBytes)}`);
      this.proofChange.emit(proof);
    } catch {
      this.error.set(ERROR_MESSAGES.ilegible);
      this.proofChange.emit(null);
    } finally {
      this.processing.set(false);
    }
  }
}
