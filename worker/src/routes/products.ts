import { ApiError, json, readJson, requireInt } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/** Columnas que ve el público. `precio_costo` queda deliberadamente fuera. */
const PUBLIC_COLUMNS = `
  id, slug, nombre, tagline, categoria_id AS categoriaId, grupo_admin AS grupoAdmin,
  precio, precio_anterior AS precioAnterior, unidad, origen, rating,
  review_count AS reviewCount, badge, stock_actual AS stock,
  imagen, imagen_hover AS imagenHover, imagen_alt AS imagenAlt
`;

/** El panel además ve costo, umbral de reposición y clase ABC. */
const ADMIN_COLUMNS = `
  ${PUBLIC_COLUMNS},
  precio_costo AS precioCosto,
  stock_seguridad AS stockSeguridad,
  categoria_abc AS categoriaAbc,
  (precio - precio_costo) AS margenUnitario
`;

/**
 * GET /api/products — catálogo público.
 *
 * Una sola consulta indexada, sin JOIN ni N+1. Filtros opcionales por
 * categoría y grupo.
 */
export async function listPublic(env: Env, url: URL): Promise<Response> {
  const categoria = url.searchParams.get('categoria');
  const grupo = url.searchParams.get('grupo');

  let sql = `SELECT ${PUBLIC_COLUMNS} FROM products WHERE activo = 1`;
  const bindings: unknown[] = [];

  if (categoria) {
    bindings.push(categoria);
    sql += ` AND categoria_id = ?${bindings.length}`;
  }
  if (grupo) {
    bindings.push(grupo);
    sql += ` AND grupo_admin = ?${bindings.length}`;
  }

  sql += ' ORDER BY nombre COLLATE NOCASE';

  const { results } = await env.DB.prepare(sql).bind(...bindings).all();
  return json({ products: results });
}

/** GET /api/admin/products — inventario completo, con costo y margen. */
export async function listAdmin(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${ADMIN_COLUMNS} FROM products WHERE activo = 1 ORDER BY nombre COLLATE NOCASE`,
  ).all();

  return json({ products: results });
}

/**
 * GET /api/admin/products/alerts — lo que hay que reponer.
 * Se resuelve contra idx_products_stock sin escanear la tabla.
 */
export async function listAlerts(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${ADMIN_COLUMNS} FROM products
      WHERE activo = 1 AND stock_actual <= stock_seguridad
      ORDER BY stock_actual ASC`,
  ).all();

  return json({ products: results });
}

interface UpdateBody {
  precio?: unknown;
  precioCosto?: unknown;
  stock?: unknown;
  stockSeguridad?: unknown;
}

/**
 * PATCH /api/admin/products/:id — precio, costo y niveles de stock.
 *
 * Solo actualiza los campos que vengan en el cuerpo, para que dos pestañas
 * editando cosas distintas no se pisen mutuamente.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<UpdateBody>(request);
  const sets: string[] = [];
  const bindings: unknown[] = [];

  const push = (column: string, value: number) => {
    bindings.push(value);
    sets.push(`${column} = ?${bindings.length}`);
  };

  if (body.precio !== undefined) push('precio', requireInt(body.precio, 'precio', 0));
  if (body.precioCosto !== undefined) push('precio_costo', requireInt(body.precioCosto, 'precioCosto', 0));
  if (body.stock !== undefined) push('stock_actual', requireInt(body.stock, 'stock', 0));
  if (body.stockSeguridad !== undefined) {
    push('stock_seguridad', requireInt(body.stockSeguridad, 'stockSeguridad', 0));
  }

  if (sets.length === 0) {
    throw ApiError.badRequest('sin-cambios', 'No enviaste ningún campo para actualizar.');
  }

  sets.push(`actualizado_en = datetime('now')`);
  bindings.push(productId);

  const result = await env.DB.prepare(
    `UPDATE products SET ${sets.join(', ')} WHERE id = ?${bindings.length} AND activo = 1`,
  )
    .bind(...bindings)
    .run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Ese producto no existe o está desactivado.');
  }

  const updated = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(productId)
    .first();

  return json({ product: updated });
}

/**
 * POST /api/admin/products/recalcular-abc
 *
 * Refresca la columna `categoria_abc` a partir de las ventas reales.
 *
 * La clasificación se calcula con el acumulado **anterior** a cada producto:
 * el que cruza el 80 % sigue siendo clase A. Si se mirara el acumulado ya
 * sumado, un producto que por sí solo pasara del 80 % caería en B y la clase A
 * quedaría vacía.
 */
export async function recalcAbc(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const result = await env.DB.prepare(
    `WITH ventas AS (
       SELECT oi.product_id AS pid,
              SUM(oi.precio_unitario * oi.cantidad) AS ingreso
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.estado IN ('aprobado', 'enviado')
        GROUP BY oi.product_id
     ),
     acumulado AS (
       SELECT pid,
              ingreso,
              SUM(ingreso) OVER () AS total,
              COALESCE(
                SUM(ingreso) OVER (
                  ORDER BY ingreso DESC, pid
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ), 0
              ) AS previo
         FROM ventas
     )
     UPDATE products
        SET categoria_abc = (
              SELECT CASE
                       WHEN a.total = 0 THEN 'C'
                       WHEN a.previo < a.total * 0.80 THEN 'A'
                       WHEN a.previo < a.total * 0.95 THEN 'B'
                       ELSE 'C'
                     END
                FROM acumulado a WHERE a.pid = products.id
            )
      WHERE id IN (SELECT pid FROM acumulado)`,
  ).run();

  return json({ actualizados: result.meta.changes });
}
