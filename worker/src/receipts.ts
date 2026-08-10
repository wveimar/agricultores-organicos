import { ApiError } from './http';

/**
 * Comprobantes de consignación.
 *
 * La imagen se guarda en D1, en `orders.comprobante_url`, como data URL
 * (`data:image/jpeg;base64,...`). El cliente ya la recomprime a ~150–300 KB
 * antes de subirla (ver `shared/utils/image-file.ts`).
 *
 * Tener el comprobante en la misma fila que el pedido es lo que garantiza que
 * no puedan quedar desincronizados: se crean en la misma transacción y borrar
 * el pedido se lleva la imagen con él. A cambio hay una regla que **no** se
 * puede romper: la columna no se selecciona nunca en los listados. Solo la lee
 * `GET /api/admin/orders/:id/comprobante`, cuando el administrador abre ese
 * pedido concreto.
 */

/** Tipos que acepta el uploader del checkout. */
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Tope de la data URL guardada. D1 admite hasta 2.000.000 bytes por valor;
 * 1,5 MB deja margen para el resto de la fila sin acercarse al límite.
 *
 * Se **rechaza** lo que pase de ahí en vez de recortarlo: una data URL cortada
 * a la mitad sigue siendo una cadena válida para SQLite, pero es una imagen
 * corrupta que solo se descubre cuando el admin intenta verla, ya sin forma de
 * recuperarla.
 */
const MAX_DATA_URL_CHARS = 1_500_000;

const DATA_URL = /^data:([\w/+.-]+);base64,(.+)$/s;

/**
 * Valida la data URL que manda el checkout y la devuelve lista para guardar.
 *
 * Devuelve `null` si no se adjuntó comprobante: es opcional, el pedido se
 * confirma igual y el cliente puede mandarlo después por WhatsApp.
 */
export function validateDataUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw ApiError.badRequest('comprobante-invalido', 'El comprobante no tiene un formato válido.');
  }

  if (value.length > MAX_DATA_URL_CHARS) {
    throw ApiError.badRequest(
      'comprobante-grande',
      'El comprobante pesa demasiado. Vuelve a tomar la foto con menos resolución.',
    );
  }

  const match = DATA_URL.exec(value);
  if (!match) {
    throw ApiError.badRequest(
      'comprobante-invalido',
      'El comprobante debe ser una imagen codificada en base64.',
    );
  }

  if (!ACCEPTED_TYPES.has(match[1])) {
    throw ApiError.badRequest(
      'comprobante-tipo',
      `Formato no admitido (${match[1]}). Sube una imagen JPG, PNG o WEBP.`,
    );
  }

  return value;
}

export interface DecodedReceipt {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Convierte la data URL guardada en bytes, para servirla como imagen real.
 *
 * Devolver los bytes con su `content-type` en vez de la cadena base64 ahorra
 * un tercio del tráfico y deja que el navegador la cachee como cualquier otra
 * imagen.
 */
export function decodeDataUrl(dataUrl: string): DecodedReceipt {
  const match = DATA_URL.exec(dataUrl);
  if (!match) {
    throw new ApiError(500, 'comprobante-corrupto', 'El comprobante guardado no se puede leer.');
  }

  const [, contentType, base64] = match;

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ApiError(500, 'comprobante-corrupto', 'El comprobante guardado no se puede leer.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return { bytes, contentType };
}
