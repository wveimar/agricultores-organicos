import { ApiError, json, readJson, requireInt } from '../http';
import { Env, JwtPayload, WholesaleRole, WHOLESALE_ROLES, isWholesaleRole } from '../types';
import { requireRole } from '../auth/middleware';
import { discountedPrice } from '../pricing';

/**
 * Tarifas de mayorista: qué producto lleva cuánto descuento en cada nivel.
 *
 * Quién puede tocarlas: `SUPER_ADMIN` únicamente. `requireRole` deja pasar a
 * `SUPER_ADMIN` por cualquier puerta, así que pedir aquí un rol más específico
 * no cambiaría nada; lo que importa es **no** abrirlo a `ADMIN_INVENTARIO`.
 * Quien lleva el inventario decide precios de catálogo; a quién se le cobra
 * menos y cuánto es una decisión comercial distinta, y una tarifa mal puesta
 * se cobra sola en cada pedido hasta que alguien la note.
 */

function parseRole(value: string): WholesaleRole {
  if (!isWholesaleRole(value)) {
    throw ApiError.badRequest(
      'nivel-invalido',
      `El nivel debe ser uno de: ${WHOLESALE_ROLES.join(', ')}.`,
    );
  }
  return value;
}

/**
 * GET /api/admin/wholesale/:role — el catálogo entero con el descuento de ese
 * nivel donde lo haya.
 *
 * Devuelve **todos** los productos activos, no solo los que tienen tarifa: la
 * pantalla es "elegir a cuáles ponerles descuento", y para eso hay que ver
 * también los que no lo tienen. El `LEFT JOIN` deja `porcentaje` en NULL para
 * esos, que es exactamente "sin trato especial".
 *
 * El precio resultante se calcula aquí y no en el navegador para que la cifra
 * que revisa quien negocia sea la misma que va a cobrar el servidor —misma
 * función, mismo redondeo—, y no una aproximación pintada aparte.
 */
export async function list(env: Env, user: JwtPayload, role: string): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');
  const nivel = parseRole(role);

  const { results } = await env.DB.prepare(
    `SELECT p.id                    AS productId,
            p.nombre,
            p.categoria_id          AS categoriaId,
            p.grupo_admin_id        AS grupoAdmin,
            p.unidad,
            p.cantidad_unidad       AS cantidadUnidad,
            p.precio,
            p.precio_costo          AS precioCosto,
            p.activo,
            d.porcentaje_descuento  AS porcentaje,
            d.actualizado_en        AS actualizadoEn
       FROM products p
       LEFT JOIN product_wholesale_discounts d
              ON d.product_id = p.id AND d.role = ?1
      ORDER BY p.nombre COLLATE NOCASE`,
  )
    .bind(nivel)
    .all<{ productId: string; precio: number; precioCosto: number; porcentaje: number | null }>();

  const products = results.map((row) => ({
    ...row,
    precioMayorista: row.porcentaje ? discountedPrice(row.precio, row.porcentaje) : row.precio,
  }));

  const conDescuento = products.filter((p) => p.porcentaje !== null);

  return json({
    role: nivel,
    products,
    resumen: {
      conDescuento: conDescuento.length,
      total: products.length,
      // Sirve para detectar de un vistazo una tarifa que vende por debajo del
      // costo: el margen medio ponderado no lo enseñaría.
      bajoCosto: conDescuento.filter((p) => p.precioMayorista < p.precioCosto).length,
    },
  });
}

interface SetDiscountBody {
  porcentaje?: unknown;
}

/**
 * PUT /api/admin/wholesale/:role/:productId — fija el descuento.
 *
 * `porcentaje = 0` borra la fila en vez de guardar un cero: "sin descuento" es
 * la ausencia de tarifa, no una tarifa que no descuenta. Así la tabla solo
 * contiene tratos reales y `loadDiscounts` no tiene que filtrar ceros en la
 * ruta caliente del checkout.
 */
export async function set(
  request: Request,
  env: Env,
  user: JwtPayload,
  role: string,
  productId: string,
): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');
  const nivel = parseRole(role);

  const body = await readJson<SetDiscountBody>(request);
  const porcentaje = requireInt(body.porcentaje, 'porcentaje', 0);

  if (porcentaje > 100) {
    throw ApiError.badRequest('porcentaje-invalido', 'El descuento no puede pasar del 100 %.');
  }

  const product = await env.DB.prepare(
    `SELECT id, nombre, precio, precio_costo AS precioCosto FROM products WHERE id = ?1`,
  )
    .bind(productId)
    .first<{ id: string; nombre: string; precio: number; precioCosto: number }>();

  if (!product) {
    throw ApiError.notFound('Ese producto no existe.');
  }

  if (porcentaje === 0) {
    await env.DB.prepare(
      `DELETE FROM product_wholesale_discounts WHERE product_id = ?1 AND role = ?2`,
    )
      .bind(productId, nivel)
      .run();

    return json({
      productId,
      role: nivel,
      porcentaje: null,
      precioMayorista: product.precio,
      bajoCosto: false,
    });
  }

  await env.DB.prepare(
    `INSERT INTO product_wholesale_discounts (product_id, role, porcentaje_descuento, actualizado_en)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT (product_id, role)
     DO UPDATE SET porcentaje_descuento = ?3, actualizado_en = datetime('now')`,
  )
    .bind(productId, nivel, porcentaje)
    .run();

  const precioMayorista = discountedPrice(product.precio, porcentaje);

  return json({
    productId,
    role: nivel,
    porcentaje,
    precioMayorista,
    // No se bloquea: vender bajo costo es una decisión comercial legítima
    // (liquidar un lote, entrar en una cuenta). Pero se avisa, porque casi
    // siempre es un cero de más al teclear el porcentaje.
    bajoCosto: precioMayorista < product.precioCosto,
  });
}

/**
 * PUT /api/admin/wholesale/:role — aplica el mismo descuento a varios
 * productos de una vez.
 *
 * Negociar con un mayorista es acordar "un 12 % en toda la verdura", no
 * producto por producto. Sin esto, dejar una tarifa lista serían cuarenta
 * peticiones y cuarenta oportunidades de que una se quede a medias.
 *
 * Todo entra en un solo `batch()`: o se aplica la tarifa completa o no se
 * aplica ninguna. Una tarifa aplicada a medias es peor que no aplicarla,
 * porque nadie sabría dónde se cortó.
 */
export async function setBulk(
  request: Request,
  env: Env,
  user: JwtPayload,
  role: string,
): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');
  const nivel = parseRole(role);

  const body = await readJson<{ productIds?: unknown; porcentaje?: unknown }>(request);
  const porcentaje = requireInt(body.porcentaje, 'porcentaje', 0);

  if (porcentaje > 100) {
    throw ApiError.badRequest('porcentaje-invalido', 'El descuento no puede pasar del 100 %.');
  }
  if (!Array.isArray(body.productIds) || body.productIds.length === 0) {
    throw ApiError.badRequest('sin-productos', 'No se indicó ningún producto.');
  }
  if (body.productIds.length > 500) {
    throw ApiError.badRequest('demasiados-productos', 'Máximo 500 productos por operación.');
  }

  const ids = body.productIds.map((id, i) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw ApiError.badRequest('producto-invalido', `productIds[${i}] no es un id válido.`);
    }
    return id;
  });

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results: existentes } = await env.DB.prepare(
    `SELECT id FROM products WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string }>();

  if (existentes.length !== ids.length) {
    const encontrados = new Set(existentes.map((p) => p.id));
    throw ApiError.badRequest(
      'producto-invalido',
      'Algún producto de la lista no existe.',
      { faltantes: ids.filter((id) => !encontrados.has(id)) },
    );
  }

  const statements =
    porcentaje === 0
      ? ids.map((id) =>
          env.DB.prepare(
            `DELETE FROM product_wholesale_discounts WHERE product_id = ?1 AND role = ?2`,
          ).bind(id, nivel),
        )
      : ids.map((id) =>
          env.DB.prepare(
            `INSERT INTO product_wholesale_discounts (product_id, role, porcentaje_descuento, actualizado_en)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT (product_id, role)
             DO UPDATE SET porcentaje_descuento = ?3, actualizado_en = datetime('now')`,
          ).bind(id, nivel, porcentaje),
        );

  await env.DB.batch(statements);

  return json({
    role: nivel,
    porcentaje: porcentaje === 0 ? null : porcentaje,
    aplicados: ids.length,
  });
}
