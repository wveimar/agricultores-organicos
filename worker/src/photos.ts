import { Env } from './types';

/**
 * Galería de fotos de un producto (migración 0039), para el carrusel de la
 * ficha de detalle. Mismo motivo de existir como módulo aparte que
 * `sessions.ts`: `products.ts` (catálogo público) y `product-photos.ts`
 * (CRUD del panel) necesitan las dos la misma lectura.
 */

export interface PublicPhoto {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
}

/**
 * Las fotos de cada producto, para pintarlas en el carrusel de su ficha.
 *
 * Viaja en la misma respuesta del catálogo y no en un endpoint por ficha —
 * igual que las sesiones y el contenido de una canasta—: son unas pocas
 * filas, y pedirlas al abrir cada detalle serían tantas peticiones como
 * fichas se abran.
 */
export async function fotosDeProductos(
  env: Env,
  productIds: readonly string[],
): Promise<Map<string, PublicPhoto[]>> {
  if (productIds.length === 0) {
    return new Map();
  }

  const placeholders = productIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, product_id AS productId, url, alt
       FROM product_photos
      WHERE product_id IN (${placeholders})
      ORDER BY orden ASC, creado_en ASC`,
  )
    .bind(...productIds)
    .all<PublicPhoto & { productId: string }>();

  const porProducto = new Map<string, PublicPhoto[]>();
  for (const { productId, ...foto } of results) {
    const lista = porProducto.get(productId);
    if (lista) {
      lista.push(foto);
    } else {
      porProducto.set(productId, [foto]);
    }
  }
  return porProducto;
}
