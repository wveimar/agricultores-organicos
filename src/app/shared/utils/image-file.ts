/** Tipos aceptados como comprobante. */
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

/** Tope del archivo original. Una foto de móvil ronda los 3–5 MB. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface ImagePreset {
  /** Lado mayor tras redimensionar. */
  readonly maxSide: number;
  readonly quality: number;
}

/**
 * Comprobante de consignación.
 *
 * Antes eran 1400 px con calidad 0.75, que daban ~210 KB por comprobante ya en
 * base64. Como cada uno vive en D1 hasta el cierre de caja, a ~400 pedidos al
 * mes eso llenaba en medio año los 500 MB del plan gratis. A 900 px y 0.60 un
 * comprobante baja a ~85 KB —medido sobre una foto real, 2,5× menos— y el
 * banco, el titular y el monto se siguen leyendo sin esfuerzo, que es todo lo
 * que hay que verificar.
 */
export const RECEIPT_PRESET: ImagePreset = { maxSide: 900, quality: 0.6 };

/**
 * Foto de producto. Aguanta más peso que un comprobante porque es la vitrina:
 * se ve grande en la ficha y no se borra al cerrar la caja.
 */
export const PRODUCT_PRESET: ImagePreset = { maxSide: 1200, quality: 0.72 };

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
 * Sin este paso, una foto de 4 MB se convertiría en ~5,3 MB de base64: por
 * encima del límite de 2 MB por fila de D1, y suficiente para reventar la
 * cuota de `localStorage` (~5 MB por origen) al primer pedido. Aquí un recibo
 * típico baja a 60–100 KB.
 */
export async function processImage(
  file: File,
  preset: ImagePreset = RECEIPT_PRESET,
): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(file);

  try {
    const scale = Math.min(1, preset.maxSide / Math.max(bitmap.width, bitmap.height));
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

    const dataUrl = canvas.toDataURL('image/jpeg', preset.quality);

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

/** Atajo para el comprobante, que es el uso más frecuente. */
export function processReceipt(file: File): Promise<ProcessedImage> {
  return processImage(file, RECEIPT_PRESET);
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
