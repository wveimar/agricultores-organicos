import { ApiError, json, readJson, requireNumber, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Baja de inventario por merma — el cierre de jornada de la bodega.
 *
 * Lo que se deshidrató, se pudrió, se venció o se rompió sale del inventario
 * con un acta detrás: qué producto, cuánto, por qué motivo, quién lo dio de
 * baja y a qué hora. Antes esto se hacía tecleando un número nuevo en el campo
 * `stock` de Inventario, que deja el inventario cuadrado pero sin explicar
 * nada — y "¿por qué bajó?" es justamente lo que pregunta una auditoría.
 *
 * ── La forma es la de una compra, al revés ──
 *
 * Cabecera + líneas + un solo `batch()` que mueve el stock. Es literalmente el
 * espejo de `purchases.ts`: allí el documento SUBE inventario y aquí lo BAJA.
 * Por eso las guardas son las mismas (canastas y madres de variantes no tienen
 * inventario propio) y las validaciones se hacen antes de tocar nada.
 *
 * ── Dónde encaja en las cuentas ──
 *
 * La merma SÍ resta de `ganancia`, al contrario que la compra a la finca. El
 * costo de una compra se recupera al vender —se congela en
 * `order_items.costo_unitario` y el cierre lo resta como `costo_producto`—,
 * pero lo que se bota nunca pasa por una venta: si no se restara aquí, ese
 * dinero no lo descontaría nadie y la jornada mostraría un margen que no
 * existe. Ver `closeCash()` en reports.ts, que adopta las mermas huérfanas
 * igual que ya hacía con los gastos.
 *
 * Se valora al COSTO y no al precio de venta: la pérdida real es la plata que
 * salió hacia la finca, no la que se habría facturado. El valor de venta se
 * guarda aparte (`total_venta`) porque dimensiona el problema en el informe,
 * pero no entra en ninguna cuenta.
 */

/** Los motivos del descarte. Lista cerrada: es por donde agrupa el informe. */
const MOTIVOS = ['deshidratacion', 'pudricion', 'vencimiento', 'rotura', 'otro'] as const;
type Motivo = (typeof MOTIVOS)[number];

function leerMotivo(valor: unknown, campo: string): Motivo {
  if (typeof valor === 'string' && (MOTIVOS as readonly string[]).includes(valor)) {
    return valor as Motivo;
  }
  throw ApiError.badRequest(
    'motivo-invalido',
    `El campo "${campo}" debe ser uno de: ${MOTIVOS.join(', ')}.`,
  );
}

/** Una línea del acta, ya validada, antes de resolverla contra el catálogo. */
interface ItemEntrada {
  productId: string;
  cantidad: number;
  motivo: Motivo;
  observacion: string | null;
}

/** Fila de producto con lo necesario para decidir si puede perder stock. */
interface ProductoDestino {
  id: string;
  nombre: string;
  unidad: string;
  precio: number;
  precio_costo: number;
  stock_actual: number;
  vendido_por_peso: number;
  /** >0 si es una canasta: su stock se deriva de los componentes. */
  es_canasta: number;
  /** >0 si es madre de variantes: el inventario vive en las hijas. */
  es_madre: number;
}

/**
 * Valida el detalle que llega del navegador.
 *
 * Ni el costo ni el subtotal se aceptan de fuera: se leen del catálogo al
 * registrar. Un acta de merma es la justificación contable de una pérdida, y
 * dejar que el navegador diga cuánto valía lo que se botó sería dejar que
 * cualquiera decida cuánta ganancia se resta de la jornada.
 */
function leerItems(raw: unknown): readonly ItemEntrada[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest('sin-items', 'El acta tiene que llevar al menos un producto.');
  }
  if (raw.length > 100) {
    throw ApiError.badRequest('demasiadas-lineas', 'Un acta admite como mucho 100 líneas.');
  }

  const items: ItemEntrada[] = [];
  const vistos = new Set<string>();

  for (const [i, crudo] of raw.entries()) {
    const fila = (crudo ?? {}) as Record<string, unknown>;
    const productId = requireString(fila['productId'], `items[${i}].productId`, 64);

    // El UNIQUE(merma_id, product_id) de la base cierra el mismo agujero, pero
    // aquí se puede explicar qué hacer en vez de devolver un error del motor.
    if (vistos.has(productId)) {
      throw ApiError.badRequest(
        'producto-repetido',
        'Un mismo producto no puede aparecer dos veces en el acta. Suma las cantidades en una sola línea, o registra dos actas si los motivos son distintos.',
      );
    }
    vistos.add(productId);

    // `requireNumber` y no `requireInt`: un producto por peso se bota en
    // fracciones ("0.4 kg de tomate"). Que la fracción sea válida PARA ESTE
    // producto se comprueba abajo, con el catálogo ya cargado.
    const cantidad = requireNumber(fila['cantidad'], `items[${i}].cantidad`, 0.001);
    const motivo = leerMotivo(fila['motivo'], `items[${i}].motivo`);

    const observacionCruda = fila['observacion'];
    const observacion =
      observacionCruda === undefined || observacionCruda === null || observacionCruda === ''
        ? null
        : requireString(observacionCruda, `items[${i}].observacion`, 300);

    items.push({ productId, cantidad, motivo, observacion });
  }

  return items;
}

/**
 * Trae los productos del detalle y comprueba que todos puedan perder stock.
 *
 * Las tres guardas, en orden de lo que le importa a quien está en la bodega:
 *
 * · Una canasta o una madre de variantes tienen `stock_actual = 0` por
 *   definición (ver combos.ts): descontarles ahí no quitaría nada del
 *   inventario real y además reventaría contra el CHECK. Mismo corte que hace
 *   `purchases.ts` al sumar.
 * · Una fracción solo vale si el producto se vende por peso (migración 0033).
 * · Y no se puede dar de baja más de lo que hay: el CHECK `stock_actual >= 0`
 *   lo impediría igual, pero aquí se puede decir cuánto queda de qué.
 */
async function cargarDestinos(
  env: Env,
  items: readonly ItemEntrada[],
): Promise<Map<string, ProductoDestino>> {
  const ids = items.map((i) => i.productId);
  const marcadores = ids.map((_, i) => `?${i + 1}`).join(', ');

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.nombre, p.unidad, p.precio, p.precio_costo, p.stock_actual,
            p.vendido_por_peso,
            (SELECT COUNT(*) FROM product_components pc
              WHERE pc.parent_product_id = p.id) AS es_canasta,
            (SELECT COUNT(*) FROM products h
              WHERE h.parent_id = p.id)          AS es_madre
       FROM products p
      WHERE p.id IN (${marcadores})`,
  )
    .bind(...ids)
    .all<ProductoDestino>();

  const porId = new Map(results.map((p) => [p.id, p]));

  for (const item of items) {
    const producto = porId.get(item.productId);
    if (!producto) {
      throw ApiError.badRequest(
        'producto-inexistente',
        'Uno de los productos del acta ya no está en el catálogo.',
      );
    }
    if (producto.es_canasta > 0) {
      throw ApiError.badRequest(
        'canasta-sin-stock',
        `"${producto.nombre}" es una canasta: no tiene inventario propio. Da de baja los productos que lleva dentro.`,
      );
    }
    if (producto.es_madre > 0) {
      throw ApiError.badRequest(
        'madre-sin-stock',
        `"${producto.nombre}" agrupa variantes y no tiene inventario propio. Da de baja la presentación concreta.`,
      );
    }
    if (!producto.vendido_por_peso && !Number.isInteger(item.cantidad)) {
      throw ApiError.badRequest(
        'cantidad-no-entera',
        `"${producto.nombre}" no se vende por peso: la cantidad tiene que ser un número entero.`,
      );
    }
    if (producto.stock_actual < item.cantidad) {
      throw ApiError.conflict(
        'stock-insuficiente',
        `De "${producto.nombre}" quedan ${producto.stock_actual} en inventario y estás dando de baja ${item.cantidad}. ` +
          `Si la diferencia es un descuadre viejo, corrígelo primero en Inventario.`,
        {
          productId: producto.id,
          producto: producto.nombre,
          solicitado: item.cantidad,
          disponible: producto.stock_actual,
        },
      );
    }
  }

  return porId;
}

/**
 * SELECT compartido.
 *
 * `creadoPor` sale del JOIN con `users` y no de una copia en la fila: el acta
 * ya guarda el id, y a diferencia del nombre de un proveedor —que puede
 * desaparecer de la agenda— un usuario del panel sigue existiendo. Si algún
 * día se borrara, el `ON DELETE SET NULL` deja el acta viva y sin autor, que es
 * mejor que perder el documento entero.
 */
const SELECT_MERMA = `
  SELECT m.id, m.total_costo AS totalCosto, m.total_venta AS totalVenta,
         m.observaciones, m.creado_en AS creadoEn, m.closing_id AS closingId,
         autor.nombre AS creadoPor
    FROM mermas m
    LEFT JOIN users autor ON autor.id = m.creado_por`;

/** Carga las líneas de varias actas de una vez, para no hacer N+1. */
async function cargarItems(env: Env, mermaIds: readonly string[]): Promise<Map<string, unknown[]>> {
  if (mermaIds.length === 0) {
    return new Map();
  }

  const marcadores = mermaIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT i.merma_id AS mermaId, i.product_id AS productId,
            i.producto_nombre AS productoNombre, i.unidad, i.cantidad,
            i.costo_unitario AS costoUnitario, i.subtotal_costo AS subtotalCosto,
            i.precio_unitario AS precioUnitario, i.subtotal_venta AS subtotalVenta,
            i.motivo, i.observacion
       FROM merma_items i
      WHERE i.merma_id IN (${marcadores})
      ORDER BY i.id`,
  )
    .bind(...mermaIds)
    .all<{ mermaId: string }>();

  const porMerma = new Map<string, unknown[]>();
  for (const fila of results) {
    const lista = porMerma.get(fila.mermaId) ?? [];
    lista.push(fila);
    porMerma.set(fila.mermaId, lista);
  }
  return porMerma;
}

/**
 * GET /api/admin/mermas — el historial de actas.
 *
 * Trae las líneas dentro de cada acta: la pantalla las despliega sin una
 * segunda petición y son pocas. `?abiertas=1` deja solo las que todavía no ha
 * adoptado un cierre, que son las únicas que se pueden deshacer.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const soloAbiertas = url.searchParams.get('abiertas') === '1';
  const where = soloAbiertas ? 'WHERE m.closing_id IS NULL' : '';

  const { results } = await env.DB.prepare(
    `${SELECT_MERMA} ${where} ORDER BY m.creado_en DESC LIMIT 200`,
  ).all<{ id: string }>();

  const items = await cargarItems(env, results.map((m) => m.id));

  return json({
    mermas: results.map((merma) => ({ ...merma, items: items.get(merma.id) ?? [] })),
  });
}

/**
 * POST /api/admin/mermas — registra el acta y baja el inventario.
 *
 * Un solo batch hace las tres cosas que tienen que pasar juntas: la cabecera,
 * su detalle y el descuento de stock. Si una falla, D1 revierte todo — media
 * acta registrada dejaría inventario descontado sin documento que lo explique,
 * que es exactamente el problema que este módulo viene a resolver.
 */
export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<{ observaciones?: unknown; items?: unknown }>(request);

  const observaciones =
    body.observaciones === undefined || body.observaciones === null || body.observaciones === ''
      ? null
      : requireString(body.observaciones, 'observaciones', 500);

  const items = leerItems(body.items);
  const productos = await cargarDestinos(env, items);

  // Valoración: el costo y el precio del catálogo HOY, congelados en la línea.
  // Redondeado por línea porque `cantidad` puede ser decimal y el peso no tiene
  // subunidad — mismo criterio que el subtotal de una venta.
  const lineas = items.map((item) => {
    const producto = productos.get(item.productId)!;
    return {
      ...item,
      productoNombre: producto.nombre,
      unidad: producto.unidad,
      costoUnitario: producto.precio_costo,
      subtotalCosto: Math.round(producto.precio_costo * item.cantidad),
      precioUnitario: producto.precio,
      subtotalVenta: Math.round(producto.precio * item.cantidad),
    };
  });

  const totalCosto = lineas.reduce((suma, l) => suma + l.subtotalCosto, 0);
  const totalVenta = lineas.reduce((suma, l) => suma + l.subtotalVenta, 0);

  const mermaId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mermas (id, total_costo, total_venta, observaciones, creado_por)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(mermaId, totalCosto, totalVenta, observaciones, user.sub),

    ...lineas.flatMap((linea) => [
      env.DB.prepare(
        `INSERT INTO merma_items
           (merma_id, product_id, producto_nombre, unidad, cantidad,
            costo_unitario, subtotal_costo, precio_unitario, subtotal_venta,
            motivo, observacion)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        mermaId,
        linea.productId,
        linea.productoNombre,
        linea.unidad,
        linea.cantidad,
        linea.costoUnitario,
        linea.subtotalCosto,
        linea.precioUnitario,
        linea.subtotalVenta,
        linea.motivo,
        linea.observacion,
      ),

      // La mercancía sale del inventario en el acto: ya está en la caneca. El
      // CHECK `stock_actual >= 0` es la red si alguien vendió entre la
      // validación de arriba y este batch.
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual - ?2, actualizado_en = datetime('now')
          WHERE id = ?1`,
      ).bind(linea.productId, linea.cantidad),
    ]),
  ]);

  return json({ merma: await cargarUna(env, mermaId) }, 201);
}

/**
 * DELETE /api/admin/mermas/:id — deshace un acta y devuelve el inventario.
 *
 * Solo mientras la jornada siga abierta. En cuanto un cierre la adopta, su
 * costo ya está restado de una `ganancia` congelada que no se puede recomputar
 * (los pedidos de esa jornada ya se archivaron): devolver el stock entonces
 * dejaría el inventario diciendo una cosa y la contabilidad otra. Mismo
 * criterio que ya usan los gastos.
 */
export async function remove(env: Env, user: JwtPayload, mermaId: string): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const actual = await env.DB.prepare(
    `SELECT id, closing_id AS closingId FROM mermas WHERE id = ?1`,
  )
    .bind(mermaId)
    .first<{ id: string; closingId: string | null }>();

  if (!actual) {
    throw ApiError.notFound('Esa acta de merma no existe.');
  }
  if (actual.closingId !== null) {
    throw ApiError.conflict(
      'merma-archivada',
      'Esta acta ya entró en un cierre de jornada: su pérdida está contada en una ganancia que ya no se recalcula. Registra un ajuste de inventario si hace falta corregir.',
    );
  }

  const { results: lineas } = await env.DB.prepare(
    `SELECT product_id AS productId, cantidad FROM merma_items WHERE merma_id = ?1`,
  )
    .bind(mermaId)
    .all<{ productId: string; cantidad: number }>();

  // El detalle se va por CASCADE; el stock hay que devolverlo a mano, y en el
  // mismo batch para que no quede acta borrada con inventario sin reponer.
  await env.DB.batch([
    ...lineas.map((linea) =>
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual + ?2, actualizado_en = datetime('now')
          WHERE id = ?1`,
      ).bind(linea.productId, linea.cantidad),
    ),
    env.DB.prepare(`DELETE FROM mermas WHERE id = ?1`).bind(mermaId),
  ]);

  return json({ ok: true });
}

/**
 * GET /api/admin/mermas/reporte?desde=&hasta= — cuánto y por qué se pierde.
 *
 * Dos agrupaciones, que responden dos preguntas distintas:
 *   · por motivo → "¿qué está fallando?" (¿la nevera? ¿la exhibición? ¿las
 *     compras de más?)
 *   · por producto → "¿en qué se está yendo la plata?"
 *
 * Las fechas se comparan con `date(creado_en, '-5 hours')`: es la hora de
 * Colombia, el mismo criterio que usa el resto del panel para que "hoy" no
 * cambie a las 7 de la tarde.
 */
export async function reporte(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const desde = url.searchParams.get('desde');
  const hasta = url.searchParams.get('hasta');

  const filtros: string[] = [];
  const bindings: unknown[] = [];

  if (desde) {
    bindings.push(desde);
    filtros.push(`date(m.creado_en, '-5 hours') >= date(?${bindings.length})`);
  }
  if (hasta) {
    bindings.push(hasta);
    filtros.push(`date(m.creado_en, '-5 hours') <= date(?${bindings.length})`);
  }

  const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  const [porMotivo, porProducto, totales] = await env.DB.batch([
    env.DB.prepare(
      `SELECT i.motivo,
              COUNT(DISTINCT m.id)              AS actas,
              COALESCE(SUM(i.cantidad), 0)      AS cantidad,
              COALESCE(SUM(i.subtotal_costo), 0) AS costo,
              COALESCE(SUM(i.subtotal_venta), 0) AS venta
         FROM merma_items i
         JOIN mermas m ON m.id = i.merma_id
         ${where}
        GROUP BY i.motivo
        ORDER BY costo DESC`,
    ).bind(...bindings),

    env.DB.prepare(
      `SELECT i.product_id AS productId, i.producto_nombre AS productoNombre, i.unidad,
              COALESCE(SUM(i.cantidad), 0)       AS cantidad,
              COALESCE(SUM(i.subtotal_costo), 0) AS costo,
              COALESCE(SUM(i.subtotal_venta), 0) AS venta
         FROM merma_items i
         JOIN mermas m ON m.id = i.merma_id
         ${where}
        GROUP BY i.product_id, i.producto_nombre, i.unidad
        ORDER BY costo DESC
        LIMIT 50`,
    ).bind(...bindings),

    env.DB.prepare(
      `SELECT COUNT(*)                          AS actas,
              COALESCE(SUM(m.total_costo), 0)   AS costo,
              COALESCE(SUM(m.total_venta), 0)   AS venta
         FROM mermas m ${where}`,
    ).bind(...bindings),
  ]);

  return json({
    porMotivo: porMotivo.results,
    porProducto: porProducto.results,
    total: totales.results[0] ?? { actas: 0, costo: 0, venta: 0 },
  });
}

/** Un acta con su detalle, para devolverla tras crearla. */
async function cargarUna(env: Env, mermaId: string): Promise<unknown> {
  const merma = await env.DB.prepare(`${SELECT_MERMA} WHERE m.id = ?1`)
    .bind(mermaId)
    .first<{ id: string }>();

  if (!merma) {
    throw ApiError.notFound('Esa acta de merma no existe.');
  }

  const items = await cargarItems(env, [mermaId]);
  return { ...merma, items: items.get(mermaId) ?? [] };
}
