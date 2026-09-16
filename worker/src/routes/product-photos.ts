import { ApiError, json, readJson, requireInt, requireString, optionalString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Galería de fotos de un producto (migración 0039): el carrusel de su ficha
 * de detalle. Mismo patrón que `sessions.ts` — rutas anidadas bajo
 * `/api/admin/products/:id/...`, un solo rol, cada respuesta devuelve la
 * lista completa actualizada.
 */

/**
 * Una URL https o un data URL de imagen. Misma regla que las imágenes
 * principales del producto (`checkImageSource` en `products.ts`) — no se
 * comparte función porque cada archivo la necesita con un mensaje propio y
 * no compensa una tercera dependencia para una comprobación de dos líneas.
 */
function checkUrl(value: string): void {
  const ok = value.startsWith('https://') || /^data:image\/(jpeg|png|webp);base64,/.test(value);
  if (!ok) {
    throw ApiError.badRequest(
      'imagen-invalida',
      value.startsWith('http://')
        ? 'El enlace debe ser https. Con http el navegador bloquea la imagen.'
        : 'El enlace no es válido. Pega una URL https o sube el archivo.',
    );
  }
}

async function existeProducto(env: Env, productId: string): Promise<string> {
  const producto = await env.DB.prepare(`SELECT nombre FROM products WHERE id = ?1`)
    .bind(productId)
    .first<{ nombre: string }>();
  if (!producto) {
    throw ApiError.notFound('Ese producto no existe.');
  }
  return producto.nombre;
}

async function listar(env: Env, productId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, product_id AS productId, url, alt, orden
       FROM product_photos
      WHERE product_id = ?1
      ORDER BY orden ASC, creado_en ASC`,
  )
    .bind(productId)
    .all();

  return results;
}

/** GET /api/admin/products/:id/fotos */
export async function list(env: Env, user: JwtPayload, productId: string): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await existeProducto(env, productId);

  return json({ fotos: await listar(env, productId) });
}

interface PhotoBody {
  url?: unknown;
  alt?: unknown;
  orden?: unknown;
}

/** POST /api/admin/products/:id/fotos — añade una foto al final de la galería. */
export async function create(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await existeProducto(env, productId);

  const body = await readJson<PhotoBody>(request);
  const url = requireString(body.url, 'url', 2_000_000);
  checkUrl(url);
  const alt = optionalString(body.alt, 'alt', 200) ?? '';
  const orden = body.orden === undefined ? 100 : requireInt(body.orden, 'orden', 0);

  await env.DB.prepare(
    `INSERT INTO product_photos (id, product_id, url, alt, orden) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(crypto.randomUUID(), productId, url, alt, orden)
    .run();

  return json({ fotos: await listar(env, productId) }, 201);
}

/** PATCH /api/admin/products/:id/fotos/:photoId — cambia el texto alternativo o el orden. */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
  photoId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await existeProducto(env, productId);

  const body = await readJson<PhotoBody>(request);
  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (body.alt !== undefined) {
    bindings.push(optionalString(body.alt, 'alt', 200) ?? '');
    sets.push(`alt = ?${bindings.length}`);
  }
  if (body.orden !== undefined) {
    bindings.push(requireInt(body.orden, 'orden', 0));
    sets.push(`orden = ?${bindings.length}`);
  }

  if (sets.length === 0) {
    throw ApiError.badRequest('sin-cambios', 'No enviaste ningún campo para actualizar.');
  }

  bindings.push(photoId, productId);
  const result = await env.DB.prepare(
    `UPDATE product_photos SET ${sets.join(', ')} WHERE id = ?${bindings.length - 1} AND product_id = ?${bindings.length}`,
  )
    .bind(...bindings)
    .run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Esa foto no existe.');
  }

  return json({ fotos: await listar(env, productId) });
}

/** DELETE /api/admin/products/:id/fotos/:photoId */
export async function remove(
  env: Env,
  user: JwtPayload,
  productId: string,
  photoId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await existeProducto(env, productId);

  const { meta } = await env.DB.prepare(
    `DELETE FROM product_photos WHERE id = ?1 AND product_id = ?2`,
  )
    .bind(photoId, productId)
    .run();

  if (meta.changes === 0) {
    throw ApiError.notFound('Esa foto no existe.');
  }

  return json({ fotos: await listar(env, productId) });
}
