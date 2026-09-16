import { ApiError, json, readJson, requireInt, requireString, optionalString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Sesiones de un producto-servicio (migración 0038): el panel administra
 * aquí las salidas/citas que la tienda ofrece para reservar. Mismo patrón
 * que `components.ts` para la receta de una canasta — rutas anidadas bajo
 * `/api/admin/products/:id/...`, un solo rol (`ADMIN_INVENTARIO`), y cada
 * respuesta devuelve la lista completa actualizada para que el panel no
 * tenga que recomponerla a mano.
 */

interface ProductoServicio {
  nombre: string;
  tipo: string;
}

async function requireServicio(env: Env, productId: string): Promise<ProductoServicio> {
  const producto = await env.DB.prepare(`SELECT nombre, tipo FROM products WHERE id = ?1`)
    .bind(productId)
    .first<ProductoServicio>();

  if (!producto) {
    throw ApiError.notFound('Ese producto no existe.');
  }
  if (producto.tipo !== 'servicio') {
    throw ApiError.badRequest(
      'producto-no-es-servicio',
      `"${producto.nombre}" es un producto físico. Las sesiones son solo para productos de tipo "servicio".`,
    );
  }
  return producto;
}

async function listar(env: Env, productId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, product_id AS productId, inicio, fin, ubicacion,
            cupo_total AS cupoTotal, cupo_reservado AS cupoReservado, activo
       FROM product_sessions
      WHERE product_id = ?1
      ORDER BY inicio ASC`,
  )
    .bind(productId)
    .all();

  return results;
}

/** GET /api/admin/products/:id/sesiones */
export async function list(env: Env, user: JwtPayload, productId: string): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await requireServicio(env, productId);

  return json({ sesiones: await listar(env, productId) });
}

interface SessionBody {
  inicio?: unknown;
  fin?: unknown;
  ubicacion?: unknown;
  cupoTotal?: unknown;
}

/** POST /api/admin/products/:id/sesiones — abre una nueva salida/cita. */
export async function create(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await requireServicio(env, productId);

  const body = await readJson<SessionBody>(request);
  const inicio = requireString(body.inicio, 'inicio', 40);
  const fin = optionalString(body.fin, 'fin', 40);
  const ubicacion = optionalString(body.ubicacion, 'ubicacion', 200);
  const cupoTotal = requireInt(body.cupoTotal, 'cupoTotal', 1);

  await env.DB.prepare(
    `INSERT INTO product_sessions (id, product_id, inicio, fin, ubicacion, cupo_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(crypto.randomUUID(), productId, inicio, fin, ubicacion, cupoTotal)
    .run();

  return json({ sesiones: await listar(env, productId) }, 201);
}

/**
 * PATCH /api/admin/products/:id/sesiones/:sessionId — edita cupo, fechas o
 * la activa/desactiva. No se puede bajar el cupo por debajo de lo ya
 * reservado: eso dejaría reservas confirmadas sin cupo que las respalde.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
  sessionId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await requireServicio(env, productId);

  const existente = await env.DB.prepare(
    `SELECT cupo_reservado FROM product_sessions WHERE id = ?1 AND product_id = ?2`,
  )
    .bind(sessionId, productId)
    .first<{ cupo_reservado: number }>();

  if (!existente) {
    throw ApiError.notFound('Esa sesión no existe.');
  }

  const body = await readJson<SessionBody & { activo?: unknown }>(request);
  const sets: string[] = [];
  const bindings: unknown[] = [];
  const push = (column: string, value: unknown) => {
    bindings.push(value);
    sets.push(`${column} = ?${bindings.length}`);
  };

  if (body.inicio !== undefined) push('inicio', requireString(body.inicio, 'inicio', 40));
  if (body.fin !== undefined) push('fin', optionalString(body.fin, 'fin', 40));
  if (body.ubicacion !== undefined) push('ubicacion', optionalString(body.ubicacion, 'ubicacion', 200));
  if (body.cupoTotal !== undefined) {
    const cupoTotal = requireInt(body.cupoTotal, 'cupoTotal', 1);
    if (cupoTotal < existente.cupo_reservado) {
      throw ApiError.badRequest(
        'cupo-insuficiente',
        `No se puede bajar el cupo a ${cupoTotal}: ya hay ${existente.cupo_reservado} personas reservadas.`,
      );
    }
    push('cupo_total', cupoTotal);
  }
  if (body.activo !== undefined) {
    if (body.activo !== 0 && body.activo !== 1) {
      throw ApiError.badRequest('activo-invalido', 'El campo "activo" debe ser 0 o 1.');
    }
    push('activo', body.activo);
  }

  if (sets.length === 0) {
    throw ApiError.badRequest('sin-cambios', 'No enviaste ningún campo para actualizar.');
  }

  bindings.push(sessionId);
  await env.DB.prepare(`UPDATE product_sessions SET ${sets.join(', ')} WHERE id = ?${bindings.length}`)
    .bind(...bindings)
    .run();

  return json({ sesiones: await listar(env, productId) });
}

/**
 * DELETE /api/admin/products/:id/sesiones/:sessionId — solo si nadie la ha
 * reservado todavía. Con reservas encima se desactiva (PATCH activo=0), no
 * se borra: `order_items.session_id` es RESTRICT justo por esto.
 */
export async function remove(
  env: Env,
  user: JwtPayload,
  productId: string,
  sessionId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');
  await requireServicio(env, productId);

  const { meta } = await env.DB.prepare(
    `DELETE FROM product_sessions WHERE id = ?1 AND product_id = ?2 AND cupo_reservado = 0`,
  )
    .bind(sessionId, productId)
    .run();

  if (meta.changes === 0) {
    const existe = await env.DB.prepare(
      `SELECT 1 FROM product_sessions WHERE id = ?1 AND product_id = ?2`,
    )
      .bind(sessionId, productId)
      .first();

    throw existe
      ? ApiError.conflict(
          'sesion-con-reservas',
          'Esta sesión ya tiene reservas. Desactívala en vez de borrarla.',
        )
      : ApiError.notFound('Esa sesión no existe.');
  }

  return json({ sesiones: await listar(env, productId) });
}
