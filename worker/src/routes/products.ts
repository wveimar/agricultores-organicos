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

/** El panel además ve costo, umbral de reposición, clase ABC y disponibilidad. */
const ADMIN_COLUMNS = `
  ${PUBLIC_COLUMNS},
  precio_costo AS precioCosto,
  stock_seguridad AS stockSeguridad,
  categoria_abc AS categoriaAbc,
  activo,
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

/**
 * GET /api/admin/products — inventario completo, con costo y margen.
 *
 * A diferencia del catálogo público, aquí **sí** salen los productos con
 * `activo = 0`. Filtrarlos sería una puerta de un solo sentido: al marcar uno
 * como "sin oferta esta semana" desaparecería del panel y ya no habría forma
 * de volver a activarlo cuando el agricultor confirme que hay cosecha.
 */
export async function listAdmin(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${ADMIN_COLUMNS} FROM products ORDER BY nombre COLLATE NOCASE`,
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
  /** 1 = se ofrece esta semana · 0 = el agricultor no tiene cosecha. */
  activo?: unknown;
}

/**
 * PATCH /api/admin/products/:id — actualización parcial de precio, costo y stock.
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
  if (body.activo !== undefined) {
    // `requireInt` solo impone mínimo, y aquí el máximo importa: un 7 pasaría
    // la validación y reventaría contra el CHECK (activo IN (0,1)) de D1 como
    // un 500 en vez de un 400 con un mensaje útil.
    if (body.activo !== 0 && body.activo !== 1) {
      throw ApiError.badRequest('activo-invalido', 'El campo "activo" debe ser 0 o 1.');
    }
    push('activo', body.activo);
  }

  if (sets.length === 0) {
    throw ApiError.badRequest('sin-cambios', 'No enviaste ningún campo para actualizar.');
  }

  sets.push(`actualizado_en = datetime('now')`);
  bindings.push(productId);

  // Sin `AND activo = 1`: si se excluyera, reactivar un producto marcado como
  // sin oferta sería imposible — el propio UPDATE que lo reactiva no
  // encontraría la fila.
  const result = await env.DB.prepare(
    `UPDATE products SET ${sets.join(', ')} WHERE id = ?${bindings.length}`,
  )
    .bind(...bindings)
    .run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Ese producto no existe.');
  }

  const updated = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(productId)
    .first();

  return json({ product: updated });
}

interface UpdateFullBody {
  nombre?: unknown;
  slug?: unknown;
  tagline?: unknown;
  categoriaId?: unknown;
  grupoAdmin?: unknown;
  precio?: unknown;
  precioCosto?: unknown;
  unidad?: unknown;
  origen?: unknown;
  imagen?: unknown;
  imagenHover?: unknown;
  imagenAlt?: unknown;
}

/**
 * PUT /api/admin/products/:id — actualización completa del producto.
 *
 * Actualiza todos los datos del producto excepto id.
 */
export async function updateFull(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<UpdateFullBody>(request);

  const nombre = body.nombre as string | undefined;
  const slug = body.slug as string | undefined;
  const tagline = (body.tagline as string) ?? '';
  const categoriaId = body.categoriaId as string | undefined;
  const grupoAdmin = body.grupoAdmin as string | undefined;
  const precio = body.precio !== undefined ? requireInt(body.precio, 'precio', 0) : undefined;
  const precioCosto = body.precioCosto !== undefined ? requireInt(body.precioCosto, 'precioCosto', 0) : undefined;
  const unidad = body.unidad as string | undefined;
  const origen = body.origen as string | undefined;
  const imagen = body.imagen as string | undefined;
  const imagenHover = body.imagenHover as string | undefined;
  const imagenAlt = body.imagenAlt as string | undefined;

  if (!nombre || nombre.trim().length === 0) {
    throw ApiError.badRequest('nombre-requerido', 'El nombre es requerido.');
  }
  if (!categoriaId || categoriaId.trim().length === 0) {
    throw ApiError.badRequest('categoria-requerida', 'La categoría es requerida.');
  }
  if (!grupoAdmin || !['frutas', 'verduras', 'agroindustriales'].includes(grupoAdmin)) {
    throw ApiError.badRequest('grupo-invalido', 'El grupo debe ser frutas, verduras o agroindustriales.');
  }
  if (precio === undefined) {
    throw ApiError.badRequest('precio-requerido', 'El precio es requerido.');
  }
  if (precioCosto === undefined) {
    throw ApiError.badRequest('precio-costo-requerido', 'El precio de costo es requerido.');
  }
  if (!unidad || unidad.trim().length === 0) {
    throw ApiError.badRequest('unidad-requerida', 'La unidad es requerida.');
  }
  if (!origen || origen.trim().length === 0) {
    throw ApiError.badRequest('origen-requerido', 'El origen es requerido.');
  }
  if (!imagen || imagen.trim().length === 0) {
    throw ApiError.badRequest('imagen-requerida', 'La imagen es requerida.');
  }
  if (!imagenAlt || imagenAlt.trim().length === 0) {
    throw ApiError.badRequest('imagen-alt-requerida', 'El texto alternativo de la imagen es requerido.');
  }

  const updateSlug = slug ? slug : nombre
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  try {
    await env.DB.prepare(
      `UPDATE products SET
        slug = ?1, nombre = ?2, tagline = ?3, categoria_id = ?4, grupo_admin = ?5,
        precio = ?6, precio_costo = ?7, unidad = ?8, origen = ?9,
        imagen = ?10, imagen_hover = ?11, imagen_alt = ?12,
        actualizado_en = datetime('now')
       WHERE id = ?13`,
    )
      .bind(updateSlug, nombre, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, origen, imagen, imagenHover ?? null, imagenAlt, productId)
      .run();
  } catch (error) {
    if ((error as Error).message.includes('UNIQUE constraint failed: products.slug')) {
      throw ApiError.badRequest('slug-duplicado', 'Ya existe un producto con ese slug.');
    }
    throw error;
  }

  const updated = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(productId)
    .first();

  if (!updated) {
    throw ApiError.notFound('Ese producto no existe o está desactivado.');
  }

  return json({ product: updated });
}

interface CreateBody {
  nombre?: unknown;
  slug?: unknown;
  tagline?: unknown;
  categoriaId?: unknown;
  grupoAdmin?: unknown;
  precio?: unknown;
  precioCosto?: unknown;
  unidad?: unknown;
  origen?: unknown;
  imagen?: unknown;
  imagenHover?: unknown;
  imagenAlt?: unknown;
}

/**
 * POST /api/admin/products — crear un nuevo producto.
 *
 * Slug se genera a partir del nombre si no viene en el cuerpo.
 * Las imágenes son data URLs (base64 comprimidas).
 */
export async function create(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<CreateBody>(request);

  const nombre = body.nombre as string | undefined;
  let slug = body.slug as string | undefined;
  const tagline = (body.tagline as string) ?? '';
  const categoriaId = body.categoriaId as string | undefined;
  const grupoAdmin = body.grupoAdmin as string | undefined;
  const precio = body.precio !== undefined ? requireInt(body.precio, 'precio', 0) : undefined;
  const precioCosto = body.precioCosto !== undefined ? requireInt(body.precioCosto, 'precioCosto', 0) : 0;
  const unidad = body.unidad as string | undefined;
  const origen = body.origen as string | undefined;
  const imagen = body.imagen as string | undefined;
  const imagenHover = body.imagenHover as string | undefined;
  const imagenAlt = body.imagenAlt as string | undefined;

  if (!nombre || nombre.trim().length === 0) {
    throw ApiError.badRequest('nombre-requerido', 'El nombre es requerido.');
  }
  if (!categoriaId || categoriaId.trim().length === 0) {
    throw ApiError.badRequest('categoria-requerida', 'La categoría es requerida.');
  }
  if (!grupoAdmin || !['frutas', 'verduras', 'agroindustriales'].includes(grupoAdmin)) {
    throw ApiError.badRequest('grupo-invalido', 'El grupo debe ser frutas, verduras o agroindustriales.');
  }
  if (precio === undefined) {
    throw ApiError.badRequest('precio-requerido', 'El precio es requerido.');
  }
  if (!unidad || unidad.trim().length === 0) {
    throw ApiError.badRequest('unidad-requerida', 'La unidad es requerida.');
  }
  if (!origen || origen.trim().length === 0) {
    throw ApiError.badRequest('origen-requerido', 'El origen es requerido.');
  }
  if (!imagen || imagen.trim().length === 0) {
    throw ApiError.badRequest('imagen-requerida', 'La imagen es requerida.');
  }
  if (!imagenAlt || imagenAlt.trim().length === 0) {
    throw ApiError.badRequest('imagen-alt-requerida', 'El texto alternativo de la imagen es requerido.');
  }

  if (!slug) {
    slug = nombre
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO products (
        id, slug, nombre, tagline, categoria_id, grupo_admin,
        precio, precio_costo, unidad, origen,
        imagen, imagen_hover, imagen_alt
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
      .bind(id, slug, nombre, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, origen, imagen, imagenHover ?? null, imagenAlt)
      .run();
  } catch (error) {
    if ((error as Error).message.includes('UNIQUE constraint failed: products.slug')) {
      throw ApiError.badRequest('slug-duplicado', 'Ya existe un producto con ese slug.');
    }
    throw error;
  }

  const product = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ product }, 201);
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
