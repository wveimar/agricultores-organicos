/** Tipos aceptados como comprobante. */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** Tope del archivo original. Una foto de móvil ronda los 3–5 MB. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Lado mayor tras redimensionar. Un recibo sigue siendo legible a este tamaño. */
const MAX_SIDE = 1400;
const JPEG_QUALITY = 0.75;

export type FileError = 'tipo' | 'tamano' | 'ilegible';

export interface ProcessedImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** Bytes aproximados de la data URL resultante. */
  readonly encodedBytes: number;
}

export function validateFile(file: File): FileError | null {
  // Algunos navegadores dejan `type` vacío para HEIC: se cae al chequeo de tamaño.
  if (file.type && !ACCEPTED_TYPES.includes(file.type as (typeof ACCEPTED_TYPES)[number])) {
    return 'tipo';
  }
  if (file.size > MAX_FILE_BYTES) {
    return 'tamano';
  }
  return null;
}

/**
 * Redimensiona y recomprime la imagen antes de convertirla a data URL.
 *
 * Sin este paso, una foto de 4 MB se convertiría en ~5,3 MB de base64 y
 * reventaría la cuota de `localStorage` (~5 MB por origen) al primer pedido.
 * Aquí un recibo típico baja a 150–300 KB.
 */
export async function processReceipt(file: File): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(file);

  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('sin contexto 2d');
    }

    // Fondo blanco: si el PNG original es transparente, el JPEG lo pondría negro.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

    return {
      dataUrl,
      width,
      height,
      // base64 codifica 3 bytes en 4 caracteres.
      encodedBytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
    };
  } finally {
    bitmap.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
