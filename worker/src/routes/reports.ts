import { ApiError, json } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * GET /api/admin/reports/sales — resumen de ventas por producto.
 *
 * Una sola consulta agregada con funciones de ventana: la clasificación ABC se
 * calcula en la base, no trayendo todas las líneas al Worker para sumarlas en
 * JavaScript. Con SQLite esto se resuelve en un escaneo del índice de
 * order_items y evita mover datos innecesarios por la red.
 *
 * Solo cuenta lo verificado contra el banco (aprobado/enviado) y lo que aún no
 * entró en un cierre: es exactamente la base del cierre de caja.
 */
export async function sales(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `WITH ventas AS (
       SELECT oi.product_id                              AS productId,
              MAX(oi.producto_nombre)                    AS nombre,
              SUM(oi.cantidad)                           AS unidades,
              SUM(oi.precio_unitario * oi.cantidad)      AS ingresos,
              SUM(oi.costo_unitario  * oi.cantidad)      AS costo,
              COUNT(DISTINCT oi.order_id)                AS pedidos
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.estado IN ('aprobado', 'enviado')
          AND o.closing_id IS NULL
        GROUP BY oi.product_id
     ),
     acumulado AS (
       SELECT v.*,
              SUM(v.ingresos) OVER () AS totalIngresos,
              COALESCE(
                SUM(v.ingresos) OVER (
                  ORDER BY v.ingresos DESC, v.productId
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ), 0
              ) AS previo
         FROM ventas v
     )
     SELECT a.productId,
            a.nombre,
            a.unidades,
            a.ingresos,
            a.costo,
            (a.ingresos - a.costo)                       AS ganancia,
            a.pedidos,
            p.origen,
            p.grupo_admin                                AS grupoAdmin,
            p.stock_actual                               AS stockRestante,
            p.imagen,
            p.imagen_alt                                 AS imagenAlt,
            -- Se clasifica con el acumulado PREVIO: el producto que cruza el
            -- 80 % sigue siendo A. Con el acumulado ya sumado, uno que por sí
            -- solo pasara del 80 % caería en B y la clase A quedaría vacía.
            CASE
              WHEN a.totalIngresos = 0            THEN 'C'
              WHEN a.previo < a.totalIngresos * 0.80 THEN 'A'
              WHEN a.previo < a.totalIngresos * 0.95 THEN 'B'
              ELSE 'C'
            END                                          AS categoriaAbc,
            CASE WHEN a.totalIngresos = 0 THEN 0.0
                 ELSE CAST(a.ingresos AS REAL) / a.totalIngresos
            END                                          AS participacion
       FROM acumulado a
       LEFT JOIN products p ON p.id = a.productId
      ORDER BY a.ingresos DESC`,
  ).all();

  interface SalesTotals {
    unidades: number;
    ingresos: number;
    costo: number;
  }

  const totals = results.reduce<SalesTotals>(
    (acc, row) => {
      const r = row as unknown as SalesTotals;
      acc.unidades += r.unidades;
      acc.ingresos += r.ingresos;
      acc.costo += r.costo;
      return acc;
    },
    { unidades: 0, ingresos: 0, costo: 0 },
  );

  return json({
    products: results,
    totals: { ...totals, ganancia: totals.ingresos - totals.costo },
  });
}

/**
 * GET /api/admin/reports/cash — estado de la jornada abierta.
 * Una sola consulta agregada; nada de traer los pedidos para sumarlos aquí.
 */
export async function cashSummary(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const summary = await env.DB.prepare(
    `SELECT COUNT(DISTINCT o.id)                                  AS pedidos,
            COALESCE(SUM(o.envio), 0)                             AS enviosCobrados,
            COALESCE((SELECT SUM(i.cantidad)
                        FROM order_items i JOIN orders x ON x.id = i.order_id
                       WHERE x.estado IN ('aprobado','enviado') AND x.closing_id IS NULL), 0) AS unidades,
            COALESCE((SELECT SUM(i.precio_unitario * i.cantidad)
                        FROM order_items i JOIN orders x ON x.id = i.order_id
                       WHERE x.estado IN ('aprobado','enviado') AND x.closing_id IS NULL), 0) AS ventaProducto,
            COALESCE((SELECT SUM(i.costo_unitario * i.cantidad)
                        FROM order_items i JOIN orders x ON x.id = i.order_id
                       WHERE x.estado IN ('aprobado','enviado') AND x.closing_id IS NULL), 0) AS costoProducto
       FROM orders o
      WHERE o.estado IN ('aprobado','enviado') AND o.closing_id IS NULL`,
  ).first<{
    pedidos: number;
    enviosCobrados: number;
    unidades: number;
    ventaProducto: number;
    costoProducto: number;
  }>();

  const data = summary ?? {
    pedidos: 0,
    enviosCobrados: 0,
    unidades: 0,
    ventaProducto: 0,
    costoProducto: 0,
  };

  return json({
    ...data,
    ganancia: data.ventaProducto - data.costoProducto,
    totalRecaudado: data.ventaProducto + data.enviosCobrados,
    // Solo existe consignación: el checkout es manual. Se devuelve como lista
    // para que sumar efectivo o datáfono no cambie la forma de la respuesta.
    porMetodo: [
      {
        metodo: 'consignacion',
        pedidos: data.pedidos,
        total: data.ventaProducto + data.enviosCobrados,
      },
    ],
  });
}

/**
 * POST /api/admin/reports/cash/close — cierra la jornada.
 *
 * Las cifras se congelan en `cash_closings` y los pedidos quedan marcados con
 * `closing_id` en la **misma transacción**. Si se hicieran en dos pasos y el
 * segundo fallara, quedarían pedidos cerrados sin cierre o un cierre sin
 * pedidos, y las dos cosas descuadran la caja.
 */
export async function closeCash(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const totals = await env.DB.prepare(
    `SELECT COUNT(DISTINCT o.id)              AS pedidos,
            COALESCE(SUM(o.envio), 0)         AS enviosCobrados
       FROM orders o
      WHERE o.estado IN ('aprobado','enviado') AND o.closing_id IS NULL`,
  ).first<{ pedidos: number; enviosCobrados: number }>();

  if (!totals || totals.pedidos === 0) {
    throw ApiError.badRequest(
      'sin-ventas',
      'No hay pedidos aprobados pendientes de cerrar.',
    );
  }

  const productTotals = await env.DB.prepare(
    `SELECT COALESCE(SUM(i.cantidad), 0)                       AS unidades,
            COALESCE(SUM(i.precio_unitario * i.cantidad), 0)   AS ventaProducto,
            COALESCE(SUM(i.costo_unitario  * i.cantidad), 0)   AS costoProducto
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE o.estado IN ('aprobado','enviado') AND o.closing_id IS NULL`,
  ).first<{ unidades: number; ventaProducto: number; costoProducto: number }>();

  const unidades = productTotals?.unidades ?? 0;
  const ventaProducto = productTotals?.ventaProducto ?? 0;
  const costoProducto = productTotals?.costoProducto ?? 0;
  const closingId = crypto.randomUUID();

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cash_closings (
         id, referencia, cerrado_por, cerrado_por_nombre, cerrado_en,
         pedidos_count, unidades_count, venta_producto, costo_producto,
         ganancia, envios_cobrados, total_recaudado
       ) VALUES (
         ?1,
         'CIERRE-' || printf('%04d',
           (SELECT COALESCE(MAX(CAST(substr(referencia, 8) AS INTEGER)), 0) + 1 FROM cash_closings)),
         ?2, ?3, datetime('now'), ?4, ?5, ?6, ?7, ?8, ?9, ?10
       )`,
    ).bind(
      closingId,
      user.sub,
      user.nombre,
      totals.pedidos,
      unidades,
      ventaProducto,
      costoProducto,
      ventaProducto - costoProducto,
      totals.enviosCobrados,
      ventaProducto + totals.enviosCobrados,
    ),
    // Marca exactamente el mismo conjunto que se acaba de sumar. Al ir en el
    // mismo batch, ningún pedido puede colarse entre el cálculo y el archivado.
    env.DB.prepare(
      `UPDATE orders SET closing_id = ?1
        WHERE estado IN ('aprobado','enviado') AND closing_id IS NULL`,
    ).bind(closingId),
  ]);

  const closing = await env.DB.prepare(
    `SELECT id, referencia, cerrado_en AS cerradoEn, cerrado_por_nombre AS cerradoPor,
            pedidos_count AS pedidos, unidades_count AS unidades,
            venta_producto AS ventaProducto, costo_producto AS costoProducto,
            ganancia, envios_cobrados AS enviosCobrados, total_recaudado AS totalRecaudado
       FROM cash_closings WHERE id = ?1`,
  )
    .bind(closingId)
    .first();

  return json({ closing, pedidosArchivados: results[1].meta.changes }, 201);
}

/** GET /api/admin/reports/closings — historial de cierres. */
export async function closings(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT id, referencia, cerrado_en AS cerradoEn, cerrado_por_nombre AS cerradoPor,
            pedidos_count AS pedidos, unidades_count AS unidades,
            venta_producto AS ventaProducto, costo_producto AS costoProducto,
            ganancia, envios_cobrados AS enviosCobrados, total_recaudado AS totalRecaudado
       FROM cash_closings
      ORDER BY cerrado_en DESC
      LIMIT 50`,
  ).all();

  return json({ closings: results });
}
