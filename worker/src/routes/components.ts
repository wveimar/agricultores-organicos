import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { stockDeCanastas } from '../combos';

/**
 * La receta de una canasta: qué productos la llenan y cuántos de cada uno.
 *
 * ── Qué se puede y qué no ──
 *
 * - Un componente **no puede ser otra canasta**. Anidarlas obligaría a expandir
 *   en recursión, con ciclos y profundidad sin tope; una canasta lleva verduras,
 *   no otras canastas. El trigger `trg_components_un_solo_nivel` lo garantiza —
 *   aquí se comprueba antes solo para dar un mensaje que se entienda.
 * - Un componente **no puede ser madre de variantes**: su stock es 0 por
 *   definición, así que la canasta nunca se podría armar. Hay que elegir la
 *   presentación concreta que va dentro.
 * - Un producto que está dentro de alguna canasta **no se puede borrar** hasta
 *   sacarlo de todas (`ON DELETE RESTRICT`).
 */

interface ComponentRow {
  childId: string;
  nombre: string;
  unidad: string;
  cantidadUnidad: number;
  stock: number;
  activo: number;
  cantidadRequerida: number;
}

/** Lee la receta con lo necesario para pintarla: nombre, presentación y stock. */
async function loadRecipe(env: Env, parentId: string): Promise<ComponentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT pc.child_product_id   AS childId,
            p.nombre,
            p.unidad,
            p.cantidad_unidad     AS cantidadUnidad,
            p.stock_actual        AS stock,
            p.activo,
            pc.cantidad_requerida AS cantidadRequerida
       FROM product_components pc
       JOIN products p ON p.id = pc.child_product_id
      WHERE pc.parent_product_id = ?1
      ORDER BY p.nombre COLLATE NOCASE`,
  )
    .bind(parentId)
    .all<ComponentRow>();

  return results;
}

/**
 * Devuelve la receta y cuántas canastas salen con el inventario de ahora.
 *
 * `armables` es el número que decide si la canasta se puede vender: lo manda el
 * componente que primero se agote, no el que más sobra.
 */
async function respondWithRecipe(env: Env, parentId: string, status = 200): Promise<Response> {
  const componentes = await loadRecipe(env, parentId);
  const stock = await stockDeCanastas(env, [parentId]);

  return json(
    {
      parentId,
      componentes,
      // Sin receta no es una canasta: se vende con su propio stock, como
      // cualquier producto. Es `null` y no 0 para que la interfaz distinga
      // «no es canasta» de «es canasta y no se puede armar ninguna».
      armables: componentes.length === 0 ? null : (stock.get(parentId) ?? 0),
    },
    status,
  );
}

/** GET /api/admin/products/:id/componentes */
export async function get(env: Env, user: JwtPayload, parentId: string): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const existe = await env.DB.prepare(`SELECT 1 FROM products WHERE id = ?1`)
    .bind(parentId)
    .first();
  if (!existe) {
    throw ApiError.notFound('Ese producto no existe.');
  }

  return respondWithRecipe(env, parentId);
}

interface ComponentBody {
  childId?: unknown;
  cantidad?: unknown;
}

/**
 * Comprueba lo que el trigger va a exigir de todas formas, pero explicándolo.
 *
 * El trigger aborta con un código seco (`componente-es-canasta`); esto traduce
 * cada caso a una frase que dice qué hacer al respecto.
 */
async function validarComponente(env: Env, parentId: string, childId: string): Promise<void> {
  if (parentId === childId) {
    throw ApiError.badRequest(
      'componente-invalido',
      'Una canasta no puede llevarse a sí misma dentro.',
    );
  }

  const hijo = await env.DB.prepare(
    `SELECT p.nombre,
            EXISTS (SELECT 1 FROM products h WHERE h.parent_id = p.id)          AS agrupa_variantes,
            EXISTS (SELECT 1 FROM product_components c WHERE c.parent_product_id = p.id) AS es_canasta
       FROM products p WHERE p.id = ?1`,
  )
    .bind(childId)
    .first<{ nombre: string; agrupa_variantes: number; es_canasta: number }>();

  if (!hijo) {
    throw ApiError.badRequest('componente-invalido', 'Ese producto no existe.');
  }
  if (hijo.agrupa_variantes) {
    throw ApiError.badRequest(
      'componente-agrupa-variantes',
      `"${hijo.nombre}" se vende por variantes y no tiene inventario propio. Elige la presentación concreta que va dentro.`,
    );
  }
  if (hijo.es_canasta) {
    throw ApiError.badRequest(
      'componente-es-canasta',
      `"${hijo.nombre}" ya es una canasta. Una canasta no puede llevar otra dentro.`,
    );
  }

  const padreEsComponente = await env.DB.prepare(
    `SELECT 1 FROM product_components WHERE child_product_id = ?1`,
  )
    .bind(parentId)
    .first();

  if (padreEsComponente) {
    throw ApiError.badRequest(
      'canasta-es-componente',
      'Este producto ya forma parte de otra canasta, así que no puede tener componentes propios.',
    );
  }
}

/**
 * PUT /api/admin/products/:id/componentes — añade o cambia un componente.
 *
 * Es un PUT y no un POST porque repetirlo con la misma cantidad deja lo mismo:
 * el `ON CONFLICT` actualiza en vez de fallar, así que corregir un 2 por un 3
 * es la misma llamada que ponerlo la primera vez.
 */
export async function put(
  request: Request,
  env: Env,
  user: JwtPayload,
  parentId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<ComponentBody>(request);
  const childId = requireString(body.childId, 'childId', 64);
  const cantidad = requireInt(body.cantidad, 'cantidad', 1);

  await validarComponente(env, parentId, childId);

  await env.DB.prepare(
    `INSERT INTO product_components (parent_product_id, child_product_id, cantidad_requerida)
     VALUES (?1, ?2, ?3)
     ON CONFLICT (parent_product_id, child_product_id)
       DO UPDATE SET cantidad_requerida = ?3`,
  )
    .bind(parentId, childId, cantidad)
    .run();

  return respondWithRecipe(env, parentId);
}

/**
 * DELETE /api/admin/products/:id/componentes/:childId — saca un producto de la
 * receta.
 *
 * Quitar el último componente deja de ser canasta y vuelve a venderse con su
 * propio `stock_actual`, que lleva en 0 desde que se convirtió. La respuesta lo
 * dice para que la interfaz avise antes de que alguien lo descubra vendiendo.
 */
export async function remove(
  env: Env,
  user: JwtPayload,
  parentId: string,
  childId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { meta } = await env.DB.prepare(
    `DELETE FROM product_components WHERE parent_product_id = ?1 AND child_product_id = ?2`,
  )
    .bind(parentId, childId)
    .run();

  if (meta.changes === 0) {
    throw ApiError.notFound('Ese producto no estaba en la receta.');
  }

  return respondWithRecipe(env, parentId);
}
