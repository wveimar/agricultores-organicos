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

/**
 * Qué cuenta como "dinero ya recaudado, listo para el cierre de caja".
 *
 * Transferencia: el dinero ya está en el banco desde que se aprobó el pedido,
 * así que 'aprobado'/'enviado' alcanza — es la regla de siempre. Contra
 * entrega: el domiciliario puede tener el efectivo en el bolsillo sin que
 * haya llegado a la finca todavía, así que no cuenta hasta 'pago' **y**
 * liquidado — dos condiciones, no una (ver la migración 0015 para el porqué
 * de que sean dos pasos separados). Crédito: es fiado, así que no cuenta
 * hasta que el mayorista paga; entonces basta 'pago', porque paga por
 * transferencia y no hay efectivo de nadie que liquidar (migración 0017).
 *
 * De ahí sale la propiedad que hace cuadrar la cartera: mientras la deuda
 * vive, el pedido no encaja en ninguna rama, así que ningún cierre lo barre y
 * su closing_id sigue nulo. Al marcarse 'pago' pasa a encajar y lo recoge el
 * **siguiente** cierre — el dinero aparece en la jornada en que de verdad
 * entró, no en aquella en que salió la mercancía.
 *
 * Aparece en sales(), cashSummary() y closeCash() (esta última dos veces: lo
 * que se suma para el recibo y lo que se archiva con closing_id). Las cuatro
 * copias tienen que decir exactamente lo mismo: si el archivado de
 * closeCash() se queda con una versión distinta a la de sus propios totales,
 * un pedido liquidado se contaría en el recibo de un cierre pero nunca
 * recibiría closing_id, y volvería a contarse en cada cierre siguiente para
 * siempre. Todas las consultas que la usan alían `orders` como `o`.
 */
const RECAUDADO_WHERE = `(
         (o.metodo_pago = 'transferencia' AND o.estado IN ('aprobado', 'enviado'))
         OR (o.metodo_pago = 'contraentrega' AND o.estado = 'pago' AND o.efectivo_liquidado = 1)
         OR (o.metodo_pago = 'credito' AND o.estado = 'pago')
       ) AND o.closing_id IS NULL`;

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
        WHERE ${RECAUDADO_WHERE}
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
                        FROM order_items i JOIN orders o ON o.id = i.order_id
                       WHERE ${RECAUDADO_WHERE}), 0) AS unidades,
            COALESCE((SELECT SUM(i.precio_unitario * i.cantidad)
                        FROM order_items i JOIN orders o ON o.id = i.order_id
                       WHERE ${RECAUDADO_WHERE}), 0) AS ventaProducto,
            COALESCE((SELECT SUM(i.costo_unitario * i.cantidad)
                        FROM order_items i JOIN orders o ON o.id = i.order_id
                       WHERE ${RECAUDADO_WHERE}), 0) AS costoProducto
       FROM orders o
      WHERE ${RECAUDADO_WHERE}`,
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

  // Desglose real por método, con el mismo filtro que el resto del resumen:
  // un pedido contra entrega sin liquidar no aparece aquí tampoco, por la
  // misma razón que no aparece en el total.
  //
  // `subtotal` y no `total`: `total` lleva el envío dentro, y el envío no es
  // venta de esta finca — ver la nota de `totalRecaudado` abajo. Si esta
  // consulta sumara `total`, la lista por método no cuadraría con el KPI que
  // tiene justo encima.
  const { results: porMetodo } = await env.DB.prepare(
    `SELECT o.metodo_pago AS metodo, COUNT(DISTINCT o.id) AS pedidos, COALESCE(SUM(o.subtotal), 0) AS total
       FROM orders o
      WHERE ${RECAUDADO_WHERE}
      GROUP BY o.metodo_pago`,
  ).all<{ metodo: string; pedidos: number; total: number }>();

  return json({
    ...data,
    ganancia: data.ventaProducto - data.costoProducto,
    // Solo producto: el cobro del domicilio NO entra en ninguna cifra de
    // venta. Ese dinero pasa por la finca pero no se queda —va para quien
    // reparte—, así que sumarlo inflaba las ventas brutas con plata que
    // nunca fue ingreso. `enviosCobrados` se sigue devolviendo aparte, como
    // dato operativo para cuadrar con el domiciliario, pero no suma aquí.
    totalRecaudado: data.ventaProducto,
    porMetodo,
  });
}

/**
 * GET /api/admin/reports/cod-pendiente — efectivo contra entrega ya cobrado
 * por un domiciliario, esperando que un admin confirme que llegó a la finca.
 *
 * Separado de cashSummary() a propósito: ese resumen son números agregados,
 * esto es una lista de pedidos concretos con acción propia (liquidar() en
 * orders.ts). "Quién cobró" no está denormalizado en `orders` — sale de
 * `order_status_log` con el mismo índice que ya usa el resto del panel para
 * la traza (`idx_status_log_order`), de sobra para el volumen de esta tienda.
 *
 * ── `total` aquí es solo producto ──
 *
 * Como en el resto de los informes, el domicilio no cuenta como venta. Pero
 * el efectivo que el domiciliario trae en el bolsillo **sí** incluye el
 * domicilio, así que `envio` viaja aparte y la pantalla muestra las dos
 * cifras: sin eso, cuadrar lo que entrega contra lo que dice el panel daría
 * de menos por exactamente el valor de los domicilios de esa jornada.
 */
export async function codPending(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.referencia, o.cliente_nombre AS clienteNombre,
            o.subtotal AS total, o.envio,
            (SELECT actor_nombre FROM order_status_log
              WHERE order_id = o.id AND estado = 'pago'
              ORDER BY creado_en DESC LIMIT 1) AS cobradoPor,
            (SELECT creado_en FROM order_status_log
              WHERE order_id = o.id AND estado = 'pago'
              ORDER BY creado_en DESC LIMIT 1) AS cobradoEn
       FROM orders o
      WHERE o.estado = 'pago' AND o.metodo_pago = 'contraentrega' AND o.efectivo_liquidado = 0
      ORDER BY cobradoEn ASC`,
  ).all();

  return json({ pendientes: results });
}

/**
 * GET /api/admin/reports/cartera — lo que los mayoristas deben.
 *
 * Un pedido a crédito aprobado o enviado y todavía sin 'pago' es una deuda
 * viva. Los 'cancelado' quedan fuera solos: nadie debe por mercancía que no
 * salió.
 *
 * ── La antigüedad se calcula aquí, no en el front ──
 *
 * `diasVencido` sale de SQLite y no de `new Date()` en Angular porque el
 * navegador de quien mira puede estar en otra zona horaria o con el reloj
 * corrido, y entonces dos personas verían vencimientos distintos para la
 * misma factura. La base es una sola y su 'now' también.
 *
 * Negativo = aún no vence (faltan tantos días). Positivo = mora. `vence_en`
 * puede ser NULL en un crédito antiguo dado antes de la 0017: se ordena al
 * final en vez de tratarse como vencido hace medio siglo.
 *
 * El tramo ('corriente' / '30' / '60' / '90') se decide también aquí para que
 * el total por tramo y la fila individual no puedan discrepar nunca: son la
 * misma expresión evaluada una vez.
 */
export async function cartera(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  // `julianday` en vez de restar textos: son fechas ISO y la diferencia tiene
  // que ser en días reales, cruzando meses y años. Se trunca con CAST a
  // entero — un vencimiento a medio día no es «0,4 días de mora».
  const DIAS = `CAST(julianday('now', '${COLOMBIA_OFFSET}') - julianday(o.vence_en) AS INTEGER)`;

  const { results } = await env.DB.prepare(
    `SELECT o.id,
            o.referencia,
            o.cliente_nombre    AS clienteNombre,
            o.cliente_telefono  AS clienteTelefono,
            o.cliente_direccion AS clienteDireccion,
            -- Solo producto, como en el resto de los informes. Lo que el
            -- mayorista debe de verdad es total + envio, así que el envío
            -- viaja aparte y la pantalla lo suma al cobrar: sin él, la
            -- gestión de cobro pediría de menos el valor del domicilio.
            o.subtotal          AS total,
            o.envio,
            o.vence_en          AS venceEn,
            o.creado_en         AS creadoEn,
            o.estado,
            CASE WHEN o.vence_en IS NULL THEN NULL ELSE ${DIAS} END AS diasVencido,
            CASE
              WHEN o.vence_en IS NULL THEN 'corriente'
              WHEN ${DIAS} <= 0  THEN 'corriente'
              WHEN ${DIAS} <= 30 THEN '30'
              WHEN ${DIAS} <= 60 THEN '60'
              ELSE '90'
            END AS tramo
       FROM orders o
      WHERE o.metodo_pago = 'credito' AND o.estado IN ('aprobado', 'enviado')
      ORDER BY o.vence_en IS NULL, o.vence_en ASC`,
  ).all();

  return json({ deudores: results });
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
      WHERE ${RECAUDADO_WHERE}`,
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
      WHERE ${RECAUDADO_WHERE}`,
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
      // Se sigue congelando cuánto se cobró de domicilio: es el dato con el
      // que se cuadra después con quien repartió. Lo que ya no hace es sumar
      // al total — ver `envios_cobrados` en schema.sql y la migración 0019.
      totals.enviosCobrados,
      ventaProducto,
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
    // AS o: mismo predicado RECAUDADO_WHERE que las dos consultas de arriba,
    // sin alias las tres se irían silenciosamente en direcciones distintas
    // en cuanto una de ellas cambiara — ver el comentario largo junto a la
    // constante para la consecuencia exacta de que esto se desincronice.
    env.DB.prepare(
      `UPDATE orders AS o SET closing_id = ?1, comprobante_url = NULL
        WHERE ${RECAUDADO_WHERE}`,
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

  const [productosResult, pedidosResult, pendientesResult, canastasResult] = await env.DB.batch([
    // Consolidado para la finca.
    //
    // `producto_nombre` sale de `order_items` —copiado al vender, así que el
    // informe sigue nombrando lo que se pidió aunque el catálogo cambie— pero
    // la unidad hay que traerla de `products`: `order_items` no la guarda. Si
    // alguien cambia la presentación después del cierre, esa columna refleja
    // la nueva. Es el único dato del informe que no es histórico.
    env.DB.prepare(
      // Una canasta no se cosecha: se cosecha lo que lleva dentro. Así que
      // antes de agrupar, cada línea de canasta se abre en sus componentes y
      // se suma con lo que se haya vendido suelto de ese mismo producto — si
      // hay 3 canastas con 1 kg de papa y alguien pidió 2 kg aparte, al
      // agricultor le tiene que llegar «Papa: 5 kg», no dos renglones.
      //
      // Se abre con `order_item_components` (la receta congelada al vender) y
      // no con la de hoy: el informe cuenta lo que se prometió, aunque la
      // canasta haya cambiado desde entonces.
      `WITH lineas AS (
         SELECT oi.order_id, oi.product_id, oi.producto_nombre, oi.cantidad
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
          WHERE ${where}
            AND NOT EXISTS (SELECT 1 FROM order_item_components c
                             WHERE c.order_id = oi.order_id
                               AND c.parent_product_id = oi.product_id)
         UNION ALL
         SELECT oi.order_id,
                c.child_product_id,
                COALESCE(hijo.nombre, c.child_product_id),
                oi.cantidad * c.cantidad_requerida
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           JOIN order_item_components c
             ON c.order_id = oi.order_id AND c.parent_product_id = oi.product_id
           LEFT JOIN products hijo ON hijo.id = c.child_product_id
          WHERE ${where}
       )
       SELECT l.product_id                          AS productId,
              MAX(l.producto_nombre)                AS nombre,
              SUM(l.cantidad)                       AS cantidadTotal,
              COUNT(DISTINCT l.order_id)            AS pedidos,
              COALESCE(MAX(p.unidad), 'unidad')      AS unidad,
              COALESCE(MAX(p.cantidad_unidad), 1)    AS cantidadUnidad,
              COALESCE(MAX(p.grupo_admin), 'verduras') AS grupoAdmin,
              -- Categoría fina (lácteos, mieles, verduras...), no solo el grupo
              -- macro: es lo que deja filtrar el consolidado por línea de
              -- negocio real y no solo por "agroindustriales" en bloque.
              COALESCE(MAX(p.categoria_id), '')      AS categoriaId,
              COALESCE(MAX(p.origen), '')            AS origen
         FROM lineas l
         LEFT JOIN products p ON p.id = l.product_id
        GROUP BY l.product_id
        ORDER BY grupoAdmin ASC, nombre ASC`,
      // El mismo WHERE aparece en las dos mitades del UNION, y los parámetros
      // son posicionales anónimos, así que hay que enlazarlos dos veces.
    ).bind(...params, ...params),

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

    // Canastas a armar. La lista de arriba ya reparte sus componentes entre lo
    // que hay que cosechar, pero quien empaca necesita saber cuántas cajas
    // montar y con qué — y ese dato desaparece al sumarlo todo.
    env.DB.prepare(
      `SELECT oi.product_id               AS productId,
              MAX(oi.producto_nombre)     AS nombre,
              SUM(oi.cantidad)            AS cantidadTotal,
              COUNT(DISTINCT oi.order_id) AS pedidos
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE ${where}
          AND EXISTS (SELECT 1 FROM order_item_components c
                       WHERE c.order_id = oi.order_id
                         AND c.parent_product_id = oi.product_id)
        GROUP BY oi.product_id
        ORDER BY nombre ASC`,
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
    // Las canastas ya están repartidas en `productos` como componentes sueltos.
    // Esta lista es para armarlas, no para cosecharlas: sumar sus cantidades a
    // las de arriba contaría dos veces el mismo tomate.
    canastas: canastasResult.results,
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
