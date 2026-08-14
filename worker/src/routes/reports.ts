import { ApiError, json } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Regla de domicilio vigente, duplicada aquí a propósito.
 *
 * La fuente para cobrar es `src/app/core/models/cart.model.ts`: el navegador
 * calcula el envío y lo manda en `POST /api/orders`, que hoy lo acepta tal
 * cual. Esta copia **no** cobra nada; sirve para auditar: el consolidado
 * recalcula lo que debió cobrarse y señala los pedidos donde no coincide.
 *
 * Si la tarifa cambia, hay que cambiarla en los dos sitios. Por eso la regla
 * viaja en la respuesta (`regla`) y se pinta en pantalla: si alguien mueve una
 * y olvida la otra, el informe empieza a marcar descuadres en masa y se nota
 * el mismo día en vez de al cuadrar la caja.
 */
export const FREE_SHIPPING_THRESHOLD = 70_000;
export const SHIPPING_COST = 5_000;

/**
 * Colombia no aplica horario de verano, así que el desfase es constante.
 *
 * `creado_en` se guarda en UTC. Un pedido hecho el jueves a las 8 p. m. en
 * Colombia queda grabado como viernes 01:00 UTC, así que filtrar por la fecha
 * cruda lo pondría en la semana siguiente — justo el pedido que sí alcanzó el
 * cierre. Todas las comparaciones de fecha de este informe se hacen sobre la
 * hora local para que "del 10 al 14" signifique lo que el administrador cree.
 */
const COLOMBIA_OFFSET = '-5 hours';

/** `YYYY-MM-DD` y nada más: lo que entra va directo a `datetime()` de SQLite. */
function optionalDate(value: string | null, field: string): string | null {
  if (value === null || value === '') {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw ApiError.badRequest(
      'fecha-invalida',
      `El parámetro "${field}" debe tener el formato AAAA-MM-DD.`,
    );
  }
  return value;
}

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
    //
    // El mismo UPDATE purga la imagen del comprobante. Cerrar la caja **es**
    // el momento en que esa imagen deja de servir: ya se verificó la
    // consignación y la plata está cuadrada. Guardarla para siempre convierte
    // D1 en un almacén de fotos — a 210 KB por comprobante y ~400 pedidos al
    // mes, los 500 MB del plan gratis se agotan en medio año.
    //
    // Se conserva `comprobante_nombre`: la traza de que hubo comprobante y de
    // cómo se llamaba no ocupa nada, y es lo que permite distinguir después
    // "nunca lo mandó" de "lo mandó y se purgó al cerrar".
    env.DB.prepare(
      `UPDATE orders SET closing_id = ?1, comprobante_url = NULL
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

/**
 * GET /api/admin/reports/closings/:id/pedidos — qué pedidos componen un cierre.
 *
 * No hace falta ninguna tabla puente ni un array JSON con las referencias: la
 * relación ya está modelada en `orders.closing_id`, que es una FK a esta misma
 * tabla y tiene su propio índice (`idx_orders_closing`). Materializar la lista
 * en otro sitio sería guardar dos veces el mismo hecho, con el riesgo de que
 * las dos copias acaben diciendo cosas distintas.
 *
 * Se devuelve también el importe y las unidades de cada pedido, que es lo que
 * convierte el listado en algo auditable: se puede sumar a mano y comprobar
 * que cuadra con los totales congelados en el cierre.
 */
export async function closingOrders(
  env: Env,
  user: JwtPayload,
  closingId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const closing = await env.DB.prepare(
    `SELECT id FROM cash_closings WHERE id = ?1`,
  )
    .bind(closingId)
    .first<{ id: string }>();

  if (!closing) {
    throw ApiError.notFound('Ese cierre no existe.');
  }

  const { results } = await env.DB.prepare(
    `SELECT o.id,
            o.referencia,
            o.cliente_nombre AS clienteNombre,
            o.estado,
            o.envio,
            o.creado_en      AS creadoEn,
            o.aprobado_en    AS aprobadoEn,
            COALESCE(SUM(i.cantidad), 0)                     AS unidades,
            COALESCE(SUM(i.precio_unitario * i.cantidad), 0) AS ventaProducto,
            COALESCE(SUM(i.costo_unitario  * i.cantidad), 0) AS costoProducto
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.closing_id = ?1
      GROUP BY o.id
      ORDER BY o.creado_en ASC`,
  )
    .bind(closingId)
    .all();

  return json({ orders: results });
}

interface ConsolidationOrderRow {
  id: string;
  referencia: string;
  clienteNombre: string;
  clienteTelefono: string;
  clienteDireccion: string;
  estado: string;
  subtotal: number;
  envio: number;
  total: number;
  unidades: number;
  creadoEn: string;
}

/**
 * GET /api/admin/reports/consolidation — qué cosechar y a quién llevarlo.
 *
 * Los pedidos cierran el jueves al mediodía, el informe se arma el viernes y
 * se despacha el domingo. Esta es la hoja que se le manda al agricultor: no
 * pedido por pedido, sino "45 kg de tomate en total".
 *
 * ### Qué se cuenta
 *
 * `estado IN ('aprobado','enviado')`, exactamente el mismo conjunto que
 * `cashSummary` y `closeCash`. No es un detalle: es lo que hace que el
 * "recaudado por domicilios" de este informe cuadre con `envios_cobrados` del
 * cierre de caja. Un pedido en `verificacion` todavía no tiene la
 * consignación comprobada, y cosechar contra él es cosechar contra una
 * promesa — por eso van aparte, en `pendientes`, como aviso.
 *
 * ### Ventana
 *
 * Sin fechas, se toma la jornada abierta (`closing_id IS NULL`): lo que se
 * cosecha para el próximo domingo. Con `desde`/`hasta`, el rango *es* la
 * definición de la ventana y entran también los pedidos ya archivados en un
 * cierre, que es lo que permite releer una semana pasada. La respuesta
 * describe en `ventana` cuál de los dos modos se aplicó.
 */
export async function consolidation(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const url = new URL(request.url);
  const desde = optionalDate(url.searchParams.get('desde'), 'desde');
  const hasta = optionalDate(url.searchParams.get('hasta'), 'hasta');

  if (desde && hasta && desde > hasta) {
    throw ApiError.badRequest('rango-invalido', 'La fecha inicial es posterior a la final.');
  }

  // El WHERE se arma con fragmentos fijos y valores enlazados: lo que viene de
  // la URL nunca se concatena en el SQL.
  const filtros: string[] = [`o.estado IN ('aprobado', 'enviado')`];
  const params: string[] = [];

  if (desde) {
    filtros.push(`datetime(o.creado_en, '${COLOMBIA_OFFSET}') >= datetime(?)`);
    params.push(desde);
  }
  if (hasta) {
    // `< día siguiente` y no `<= hasta`: con `<=` se caerían todos los pedidos
    // del propio día `hasta` salvo los de las 00:00:00 en punto.
    filtros.push(`datetime(o.creado_en, '${COLOMBIA_OFFSET}') < datetime(?, '+1 day')`);
    params.push(hasta);
  }

  const soloJornadaAbierta = !desde && !hasta;
  if (soloJornadaAbierta) {
    filtros.push('o.closing_id IS NULL');
  }

  const where = filtros.join(' AND ');

  const [productosResult, pedidosResult, pendientesResult] = await env.DB.batch([
    // Consolidado para la finca.
    //
    // `producto_nombre` sale de `order_items` —copiado al vender, así que el
    // informe sigue nombrando lo que se pidió aunque el catálogo cambie— pero
    // la unidad hay que traerla de `products`: `order_items` no la guarda. Si
    // alguien cambia la presentación después del cierre, esa columna refleja
    // la nueva. Es el único dato del informe que no es histórico.
    env.DB.prepare(
      `SELECT oi.product_id                          AS productId,
              MAX(oi.producto_nombre)                AS nombre,
              SUM(oi.cantidad)                       AS cantidadTotal,
              COUNT(DISTINCT oi.order_id)            AS pedidos,
              COALESCE(MAX(p.unidad), 'unidad')      AS unidad,
              COALESCE(MAX(p.cantidad_unidad), 1)    AS cantidadUnidad,
              COALESCE(MAX(p.grupo_admin), 'verduras') AS grupoAdmin,
              COALESCE(MAX(p.origen), '')            AS origen
         FROM order_items oi
         JOIN orders o    ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE ${where}
        GROUP BY oi.product_id
        ORDER BY grupoAdmin ASC, nombre ASC`,
    ).bind(...params),

    // Hoja de ruta: a quién se le lleva y qué se le cobró de domicilio.
    env.DB.prepare(
      `SELECT o.id,
              o.referencia,
              o.cliente_nombre     AS clienteNombre,
              o.cliente_telefono   AS clienteTelefono,
              o.cliente_direccion  AS clienteDireccion,
              o.estado,
              o.subtotal,
              o.envio,
              o.total,
              COALESCE(SUM(i.cantidad), 0) AS unidades,
              o.creado_en          AS creadoEn
         FROM orders o
         LEFT JOIN order_items i ON i.order_id = o.id
        WHERE ${where}
        GROUP BY o.id
        ORDER BY o.creado_en ASC`,
    ).bind(...params),

    // Lo que todavía no está aprobado dentro de la misma ventana. No entra en
    // el consolidado, pero el agricultor necesita saber que existe: si se
    // aprueban el viernes por la mañana, la cosecha cambia.
    env.DB.prepare(
      `SELECT COUNT(*) AS pedidos,
              COALESCE(SUM(o.subtotal), 0) AS subtotal
         FROM orders o
        WHERE o.estado IN ('verificacion', 'pendiente')
          ${desde ? `AND datetime(o.creado_en, '${COLOMBIA_OFFSET}') >= datetime(?)` : ''}
          ${hasta ? `AND datetime(o.creado_en, '${COLOMBIA_OFFSET}') < datetime(?, '+1 day')` : ''}`,
    ).bind(...params),
  ]);

  const pedidos = pedidosResult.results as unknown as ConsolidationOrderRow[];

  // El cobro esperado se recalcula aquí, no se lee de la base: el objetivo es
  // precisamente detectar cuándo lo guardado no corresponde a la regla.
  const detalle = pedidos.map((pedido) => {
    const envioEsperado = pedido.subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;
    return {
      ...pedido,
      cobroEnvio: pedido.envio > 0,
      envioEsperado,
      envioCorrecto: pedido.envio === envioEsperado,
      diferenciaEnvio: pedido.envio - envioEsperado,
    };
  });

  const conEnvio = detalle.filter((p) => p.cobroEnvio);
  const descuadres = detalle.filter((p) => !p.envioCorrecto);

  const pendientes = pendientesResult.results[0] as unknown as {
    pedidos: number;
    subtotal: number;
  };

  return json({
    ventana: {
      desde,
      hasta,
      soloJornadaAbierta,
      estados: ['aprobado', 'enviado'],
    },
    regla: {
      umbralEnvioGratis: FREE_SHIPPING_THRESHOLD,
      costoEnvio: SHIPPING_COST,
    },
    productos: productosResult.results,
    pedidos: detalle,
    domicilios: {
      pedidos: detalle.length,
      conCobro: conEnvio.length,
      sinCobro: detalle.length - conEnvio.length,
      totalRecaudado: conEnvio.reduce((suma, p) => suma + p.envio, 0),
      // Cuánto se dejó de cobrar (o se cobró de más) frente a la regla.
      diferencia: descuadres.reduce((suma, p) => suma + p.diferenciaEnvio, 0),
      descuadres: descuadres.length,
    },
    totales: {
      pedidos: detalle.length,
      referencias: productosResult.results.length,
      unidades: detalle.reduce((suma, p) => suma + p.unidades, 0),
      ventaProducto: detalle.reduce((suma, p) => suma + p.subtotal, 0),
    },
    pendientes: {
      pedidos: pendientes?.pedidos ?? 0,
      subtotal: pendientes?.subtotal ?? 0,
    },
  });
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
