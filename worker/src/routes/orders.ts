import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { decodeDataUrl, validateDataUrl } from '../receipts';

/**
 * Misma regla que `src/app/core/models/cart.model.ts`. Editar un pedido
 * recalcula el envío con la tarifa **vigente hoy**, no con la que estaba
 * activa cuando se hizo el pedido — a diferencia del resto de los campos
 * históricos de `order_items`, que sí se congelan. Es lo que pide esta
 * funcionalidad: si el admin quita una línea y el subtotal cruza el umbral,
 * el domicilio tiene que reflejarlo, no quedarse con la tarifa del día en que
 * el cliente pidió.
 */
const FREE_SHIPPING_THRESHOLD = 70_000;
const SHIPPING_COST = 5_000;

interface IncomingItem {
  productId?: unknown;
  cantidad?: unknown;
}

interface CreateOrderBody {
  clienteNombre?: unknown;
  clienteTelefono?: unknown;
  clienteDireccion?: unknown;
  items?: unknown;
  envio?: unknown;
  comprobanteNombre?: unknown;
  comprobanteUrl?: unknown;
}

interface StockRow {
  id: string;
  nombre: string;
  precio: number;
  precio_costo: number;
  stock_actual: number;
}

/** Faltante concreto, para que el cliente sepa qué ajustar. */
interface Shortfall {
  productId: string;
  productName: string;
  requested: number;
  available: number;
}

/**
 * Agrega cantidades por producto.
 *
 * Un mismo producto puede llegar repetido en el cuerpo de la petición. Sin
 * sumarlo antes, cada línea pasaría el chequeo de stock por separado y entre
 * todas se llevarían más unidades de las que hay. La restricción
 * UNIQUE(order_id, product_id) del esquema cierra el mismo agujero en la base.
 */
function aggregate(items: readonly IncomingItem[]): Map<string, number> {
  const required = new Map<string, number>();

  for (const item of items) {
    const productId = requireString(item.productId, 'items[].productId', 64);
    const cantidad = requireInt(item.cantidad, 'items[].cantidad', 1);
    required.set(productId, (required.get(productId) ?? 0) + cantidad);
  }

  return required;
}

/** Lee stock y precios actuales de los productos pedidos, en una sola consulta. */
async function loadProducts(env: Env, ids: readonly string[]): Promise<Map<string, StockRow>> {
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, nombre, precio, precio_costo, stock_actual
       FROM products
      WHERE activo = 1 AND id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<StockRow>();

  return new Map(results.map((row) => [row.id, row]));
}

/**
 * POST /api/orders — cierra una compra desde la tienda.
 *
 * Reserva el inventario en el mismo paso: el cliente ya consignó, así que esas
 * unidades salen de la disponibilidad aunque el pago esté sin verificar. El
 * pedido nace en estado `verificacion` con `stock_reservado = 1`, y por eso
 * aprobarlo después **no** vuelve a descontar.
 */
export async function create(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateOrderBody>(request);

  const clienteNombre = requireString(body.clienteNombre, 'clienteNombre', 120);
  const clienteTelefono = requireString(body.clienteTelefono, 'clienteTelefono', 40);
  const clienteDireccion = requireString(body.clienteDireccion, 'clienteDireccion', 240);
  const envio = body.envio === undefined ? 0 : requireInt(body.envio, 'envio', 0);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw ApiError.badRequest('carrito-vacio', 'El pedido no tiene productos.');
  }
  if (body.items.length > 100) {
    throw ApiError.badRequest('carrito-grande', 'Un pedido admite máximo 100 líneas.');
  }

  const required = aggregate(body.items as IncomingItem[]);
  const products = await loadProducts(env, [...required.keys()]);

  // Validación amable: se responde con los faltantes exactos antes de intentar
  // escribir. El CHECK de la base sigue siendo la garantía real ante carreras.
  const shortfalls: Shortfall[] = [];
  for (const [productId, cantidad] of required) {
    const product = products.get(productId);
    if (!product) {
      throw ApiError.badRequest(
        'producto-invalido',
        `El producto ${productId} no existe o ya no está a la venta.`,
      );
    }
    if (product.stock_actual < cantidad) {
      shortfalls.push({
        productId,
        productName: product.nombre,
        requested: cantidad,
        available: product.stock_actual,
      });
    }
  }

  if (shortfalls.length > 0) {
    throw ApiError.badRequest(
      'stock-insuficiente',
      'No hay unidades suficientes para completar el pedido.',
      { shortfalls },
    );
  }

  const orderId = crypto.randomUUID();
  const subtotal = [...required.entries()].reduce(
    (total, [productId, cantidad]) => total + products.get(productId)!.precio * cantidad,
    0,
  );

  const comprobanteNombre =
    typeof body.comprobanteNombre === 'string' ? body.comprobanteNombre.slice(0, 200) : null;

  // Se valida antes de tocar la base: si la imagen viene mal, el cliente
  // recibe un 400 claro y no queda ningún pedido a medias.
  const comprobanteUrl = validateDataUrl(body.comprobanteUrl);

  const statements: D1PreparedStatement[] = [
    // La referencia se calcula dentro de la propia transacción: leerla antes y
    // escribirla después dejaría una ventana para asignar el mismo número dos
    // veces. El UNIQUE de la columna es la red de seguridad.
    env.DB.prepare(
      `INSERT INTO orders (
         id, referencia, cliente_nombre, cliente_telefono, cliente_direccion,
         estado, stock_reservado, subtotal, envio, total,
         comprobante_nombre, comprobante_url
       ) VALUES (
         ?1,
         'ORD-' || (SELECT COALESCE(MAX(CAST(substr(referencia, 5) AS INTEGER)), 1000) + 1 FROM orders),
         ?2, ?3, ?4, 'verificacion', 1, ?5, ?6, ?7, ?8, ?9
       )`,
    ).bind(
      orderId,
      clienteNombre,
      clienteTelefono,
      clienteDireccion,
      subtotal,
      envio,
      subtotal + envio,
      comprobanteNombre,
      // La imagen entra en la misma transacción que el pedido: o quedan los
      // dos, o no queda ninguno. Nunca se selecciona en los listados; se lee
      // solo desde GET /api/admin/orders/:id/comprobante.
      comprobanteUrl,
    ),
    // Traza de la primera transición, en el mismo batch: si el pedido no llega
    // a crearse, tampoco debe quedar un registro de que "nació".
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       VALUES (?1, 'verificacion', NULL, ?2)`,
    ).bind(orderId, clienteNombre),
  ];

  for (const [productId, cantidad] of required) {
    const product = products.get(productId)!;

    statements.push(
      env.DB.prepare(
        `INSERT INTO order_items
           (order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(orderId, productId, product.nombre, product.precio, product.precio_costo, cantidad),
    );

    // Si entre la validación y este UPDATE otra petición se llevó las unidades,
    // el CHECK (stock_actual >= 0) hace fallar la sentencia y D1 revierte
    // **todo** el batch: no queda un pedido creado sin su descuento.
    statements.push(
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual - ?1, actualizado_en = datetime('now')
          WHERE id = ?2`,
      ).bind(cantidad, productId),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  const created = await loadOrder(env, orderId);
  return json({ order: created }, 201);
}

/**
 * POST /api/admin/orders/:id/aprobar — acción crítica.
 *
 * Todo ocurre en un único `batch()`, que en D1 es una transacción implícita:
 * o se aplican todas las sentencias o ninguna. D1 no admite transacciones
 * interactivas (BEGIN/COMMIT con awaits en medio), así que `batch()` es el
 * primitivo correcto aquí, no un atajo.
 *
 * La idempotencia se consigue con `aprobacion_token`:
 *  1. La primera sentencia marca el pedido **solo si** `aprobacion_token IS NULL`.
 *  2. Cada descuento de stock lleva un WHERE que exige que el token guardado
 *     sea exactamente el que generamos en esta petición.
 *
 * Si dos aprobaciones del mismo pedido llegan a la vez, la segunda encuentra el
 * token ya puesto por la primera: su UPDATE inicial afecta 0 filas y sus
 * descuentos tampoco casan. Sin ese token, la segunda transacción restaría el
 * inventario por segunda vez.
 */
export async function approve(
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const order = await env.DB.prepare(
    `SELECT id, estado, stock_reservado FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{ id: string; estado: string; stock_reservado: number }>();

  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }
  if (order.estado !== 'pendiente' && order.estado !== 'verificacion') {
    throw ApiError.conflict('ya-aprobado', `El pedido ya está en estado "${order.estado}".`);
  }

  const { results: items } = await env.DB.prepare(
    `SELECT product_id, producto_nombre, cantidad FROM order_items WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{ product_id: string; producto_nombre: string; cantidad: number }>();

  if (items.length === 0) {
    throw ApiError.badRequest('pedido-vacio', 'El pedido no tiene líneas que aprobar.');
  }

  const necesitaDescuento = order.stock_reservado === 0;

  if (necesitaDescuento) {
    const products = await loadProducts(env, items.map((item) => item.product_id));
    const shortfalls: Shortfall[] = [];

    for (const item of items) {
      const available = products.get(item.product_id)?.stock_actual ?? 0;
      if (available < item.cantidad) {
        shortfalls.push({
          productId: item.product_id,
          productName: item.producto_nombre,
          requested: item.cantidad,
          available,
        });
      }
    }

    if (shortfalls.length > 0) {
      throw ApiError.badRequest(
        'stock-insuficiente',
        'No se aprobó: falta inventario. No se descontó ninguna unidad.',
        { shortfalls },
      );
    }
  }

  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE orders
          SET estado = 'aprobado', aprobado_por = ?2, aprobado_en = ?3, aprobacion_token = ?4
        WHERE id = ?1
          AND aprobacion_token IS NULL
          AND estado IN ('pendiente', 'verificacion')`,
    ).bind(orderId, user.sub, now, token),
    // OJO: un INSERT normal aquí sería un bug. `batch()` es atómico ante
    // *errores*, pero el UPDATE de arriba no lanza error si pierde la carrera
    // de idempotencia — simplemente afecta 0 filas y el batch sigue. Un
    // `INSERT ... VALUES` incondicional se ejecutaría igual y dejaría en el
    // log una aprobación que en realidad no ocurrió. Por eso es un
    // `INSERT ... SELECT ... WHERE`, con la misma condición del token que
    // usan los UPDATE de stock más abajo: solo inserta si esta petición fue
    // la que de verdad ganó la carrera.
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'aprobado', ?2, ?3
        WHERE (SELECT aprobacion_token FROM orders WHERE id = ?1) = ?4`,
    ).bind(orderId, user.sub, user.nombre, token),
  ];

  if (necesitaDescuento) {
    for (const item of items) {
      statements.push(
        env.DB.prepare(
          `UPDATE products
              SET stock_actual = stock_actual - ?2, actualizado_en = ?4
            WHERE id = ?1
              AND (SELECT aprobacion_token FROM orders WHERE id = ?3) = ?5`,
        ).bind(item.product_id, item.cantidad, orderId, now, token),
      );
    }
  }

  let batchResults: D1Result[];
  try {
    batchResults = await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  // Si el UPDATE del pedido no tocó ninguna fila, otra petición ganó la carrera.
  // Gracias al token, sus descuentos tampoco se aplicaron: no hay nada que deshacer.
  if (batchResults[0].meta.changes === 0) {
    throw ApiError.conflict('ya-aprobado', 'Otro usuario aprobó este pedido primero.');
  }

  const updated = await loadOrder(env, orderId);
  return json({ order: updated });
}

/** POST /api/admin/orders/:id/enviar — solo se envía lo ya aprobado. */
export async function ship(env: Env, user: JwtPayload, orderId: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  // Dos sentencias en un batch, no una suelta: así el registro del log queda
  // ligado al mismo todo-o-nada que el cambio de estado, igual que en approve().
  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET estado = 'enviado' WHERE id = ?1 AND estado = 'aprobado'`,
    ).bind(orderId),
    // Mismo motivo que en approve(): condicionado a que el UPDATE de arriba
    // haya encontrado de verdad un pedido en estado 'aprobado' que mover.
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'enviado', ?2, ?3
        WHERE (SELECT estado FROM orders WHERE id = ?1) = 'enviado'`,
    ).bind(orderId, user.sub, user.nombre),
  ]);

  if (updateResult.meta.changes === 0) {
    throw ApiError.conflict(
      'estado-invalido',
      'Solo se puede marcar como enviado un pedido aprobado.',
    );
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * POST /api/admin/orders/:id/cancelar — anula un pedido y devuelve el stock.
 *
 * Es el espejo de `approve()`, y comparte su mecánica por el mismo motivo. Se
 * cancela desde el panel, no desde la tienda: los pedidos se crean sin sesión
 * (compra de invitado), así que no hay forma de comprobar que quien pide la
 * cancelación es el dueño del pedido. Un endpoint público solo estaría
 * protegido por lo difícil que es adivinar un UUID, que no es una defensa.
 *
 * Solo se cancela lo que todavía no salió: 'verificacion' o 'pendiente'. Un
 * pedido aprobado ya entró en la caja de la jornada, y uno enviado ya va en
 * camino — deshacer cualquiera de los dos descuadraría cuentas o inventario
 * frente a lo que de verdad pasó.
 */
export async function cancel(
  request: Request,
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<{ motivo?: unknown }>(request).catch(() => ({ motivo: undefined }));
  const motivo =
    typeof body.motivo === 'string' && body.motivo.trim() !== ''
      ? body.motivo.trim().slice(0, 300)
      : null;

  const order = await env.DB.prepare(
    `SELECT id, estado, stock_reservado FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{ id: string; estado: string; stock_reservado: number }>();

  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }
  if (order.estado !== 'pendiente' && order.estado !== 'verificacion') {
    throw ApiError.conflict(
      'estado-invalido',
      order.estado === 'cancelado'
        ? 'Ese pedido ya está cancelado.'
        : `Un pedido "${order.estado}" ya no se puede cancelar.`,
    );
  }

  const { results: items } = await env.DB.prepare(
    `SELECT product_id, cantidad FROM order_items WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{ product_id: string; cantidad: number }>();

  // Solo se devuelve stock si de verdad se descontó. Con stock_reservado = 0
  // el pedido nunca tocó el inventario —lo habría descontado la aprobación,
  // que no llegó a ocurrir— y sumarlo ahora inventaría unidades.
  const devuelveStock = order.stock_reservado === 1 && items.length > 0;

  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE orders
          SET estado = 'cancelado', cancelado_por = ?2, cancelado_en = ?3,
              cancelacion_token = ?4, motivo_cancelacion = ?5, stock_reservado = 0
        WHERE id = ?1
          AND cancelacion_token IS NULL
          AND estado IN ('pendiente', 'verificacion')`,
    ).bind(orderId, user.sub, now, token, motivo),
    // Condicionado al token, igual que en approve(): `batch()` es atómico ante
    // errores, pero el UPDATE de arriba no lanza si pierde la carrera —
    // simplemente afecta 0 filas—, y un INSERT incondicional dejaría en el log
    // una cancelación que no ocurrió.
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'cancelado', ?2, ?3
        WHERE (SELECT cancelacion_token FROM orders WHERE id = ?1) = ?4`,
    ).bind(orderId, user.sub, user.nombre, token),
  ];

  if (devuelveStock) {
    for (const item of items) {
      statements.push(
        env.DB.prepare(
          `UPDATE products
              SET stock_actual = stock_actual + ?2, actualizado_en = ?4
            WHERE id = ?1
              AND (SELECT cancelacion_token FROM orders WHERE id = ?3) = ?5`,
        ).bind(item.product_id, item.cantidad, orderId, now, token),
      );
    }
  }

  let batchResults: D1Result[];
  try {
    batchResults = await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  // Si el UPDATE no tocó ninguna fila, otra petición canceló primero. Gracias
  // al token, sus devoluciones de stock tampoco se aplicaron.
  if (batchResults[0].meta.changes === 0) {
    throw ApiError.conflict('estado-invalido', 'Otro usuario canceló este pedido primero.');
  }

  return json({
    order: await loadOrder(env, orderId),
    unidadesDevueltas: devuelveStock
      ? items.reduce((suma, item) => suma + item.cantidad, 0)
      : 0,
  });
}

/** Estados desde los que el contenido del pedido todavía se puede tocar. */
const EDITABLE_STATES = ['verificacion', 'pendiente', 'aprobado'] as const;

interface UpdateItemsBody {
  items?: unknown;
}

/**
 * PATCH /api/admin/orders/:id/items — cambia qué y cuánto lleva un pedido.
 *
 * El cuerpo manda la lista **completa** de líneas que el pedido debe tener al
 * terminar, no un parche incremental: es lo que ya construye el formulario en
 * el panel (cantidades con +/-, líneas quitadas, productos añadidos desde el
 * buscador), así que aquí solo hay que compararla contra lo que hay guardado.
 *
 * ── Qué se toca y qué no ──
 *
 * - Una línea que **ya existía** y solo cambia de cantidad conserva su
 *   `precio_unitario`/`costo_unitario`: son el precio al que de verdad se
 *   vendió, y no deben moverse porque el catálogo haya cambiado desde
 *   entonces — el mismo principio que protege `create()`.
 * - Una línea **nueva** sí toma el precio y costo actuales del catálogo, tal
 *   como se congelaría si el pedido se creara hoy.
 * - El inventario **solo se mueve si `stock_reservado = 1`**. Un pedido
 *   `pendiente` por teléfono no ha tocado el inventario todavía —lo hará
 *   `approve()`—, así que editar sus cantidades aquí es un cambio de
 *   contenido puro. Tocar `stock_actual` en ese caso reservaría inventario
 *   que la aprobación volvería a descontar por segunda vez.
 *
 * Igual que `create()`, la disponibilidad se valida antes de escribir para dar
 * un error legible, y el CHECK `stock_actual >= 0` es la garantía real ante
 * una carrera con otra venta concurrente.
 */
export async function updateItems(
  request: Request,
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<UpdateItemsBody>(request);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw ApiError.badRequest(
      'carrito-vacio',
      'Un pedido no puede quedar sin líneas. Para eso está cancelar o eliminar.',
    );
  }
  if (body.items.length > 100) {
    throw ApiError.badRequest('carrito-grande', 'Un pedido admite máximo 100 líneas.');
  }

  const order = await env.DB.prepare(
    `SELECT id, estado, stock_reservado, closing_id FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{ id: string; estado: string; stock_reservado: number; closing_id: string | null }>();

  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }
  if (order.closing_id !== null) {
    throw ApiError.conflict(
      'pedido-archivado',
      'Este pedido ya entró en un cierre de caja: cambiar sus líneas descuadraría esa jornada.',
    );
  }
  if (!EDITABLE_STATES.includes(order.estado as (typeof EDITABLE_STATES)[number])) {
    throw ApiError.conflict(
      'estado-invalido',
      `Un pedido "${order.estado}" ya no admite cambios en sus productos.`,
    );
  }

  const required = aggregate(body.items as IncomingItem[]);

  const { results: currentItems } = await env.DB.prepare(
    `SELECT product_id, producto_nombre, precio_unitario, costo_unitario, cantidad
       FROM order_items WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{
      product_id: string;
      producto_nombre: string;
      precio_unitario: number;
      costo_unitario: number;
      cantidad: number;
    }>();

  const existing = new Map(currentItems.map((item) => [item.product_id, item]));
  const touchedIds = new Set<string>([...required.keys(), ...existing.keys()]);
  const products = await loadProducts(env, [...touchedIds]);

  interface Delta {
    productId: string;
    oldQty: number;
    newQty: number;
    diff: number;
  }

  const deltas: Delta[] = [];
  const shortfalls: Shortfall[] = [];

  for (const productId of touchedIds) {
    const oldQty = existing.get(productId)?.cantidad ?? 0;
    const newQty = required.get(productId) ?? 0;
    const diff = newQty - oldQty;

    if (diff === 0) {
      continue;
    }

    // Un incremento neto necesita producto activo y unidades disponibles,
    // tanto si el pedido ya reservó stock como si no: sin esto, un pedido
    // `pendiente` se podría editar hacia algo que `approve()` rechazaría
    // después, y el admin se enteraría tarde.
    if (diff > 0) {
      const product = products.get(productId);
      if (!product) {
        throw ApiError.badRequest(
          'producto-invalido',
          `El producto ${productId} no existe o ya no está a la venta.`,
        );
      }
      if (product.stock_actual < diff) {
        shortfalls.push({
          productId,
          productName: product.nombre,
          requested: diff,
          available: product.stock_actual,
        });
      }
    }

    deltas.push({ productId, oldQty, newQty, diff });
  }

  if (shortfalls.length > 0) {
    throw ApiError.badRequest(
      'stock-insuficiente',
      'No se guardó: falta inventario para las unidades añadidas.',
      { shortfalls },
    );
  }

  if (deltas.length === 0) {
    // Nada cambió de verdad — mismas líneas, mismas cantidades.
    return json({ order: await loadOrder(env, orderId) });
  }

  // Subtotal del pedido resultante: precio histórico para lo que ya estaba,
  // precio de catálogo para lo que se añade.
  let subtotal = 0;
  for (const [productId, cantidad] of required) {
    const historico = existing.get(productId);
    const precio = historico ? historico.precio_unitario : products.get(productId)!.precio;
    subtotal += precio * cantidad;
  }

  const envio = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE orders SET subtotal = ?2, envio = ?3, total = ?4 WHERE id = ?1`,
    ).bind(orderId, subtotal, envio, subtotal + envio),
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       VALUES (?1, 'editado', ?2, ?3)`,
    ).bind(orderId, user.sub, user.nombre),
  ];

  for (const delta of deltas) {
    if (delta.newQty === 0) {
      statements.push(
        env.DB.prepare(`DELETE FROM order_items WHERE order_id = ?1 AND product_id = ?2`).bind(
          orderId,
          delta.productId,
        ),
      );
    } else if (delta.oldQty === 0) {
      const product = products.get(delta.productId)!;
      statements.push(
        env.DB.prepare(
          `INSERT INTO order_items
             (order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(
          orderId,
          delta.productId,
          product.nombre,
          product.precio,
          product.precio_costo,
          delta.newQty,
        ),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `UPDATE order_items SET cantidad = ?3 WHERE order_id = ?1 AND product_id = ?2`,
        ).bind(orderId, delta.productId, delta.newQty),
      );
    }

    // El inventario en vivo solo existe si el pedido lo reservó. Un `diff`
    // positivo pide más (se resta), uno negativo devuelve (se suma) — la
    // misma resta cubre las dos direcciones.
    if (order.stock_reservado === 1) {
      statements.push(
        env.DB.prepare(
          `UPDATE products
              SET stock_actual = stock_actual - ?2, actualizado_en = ?3
            WHERE id = ?1`,
        ).bind(delta.productId, delta.diff, now),
      );
    }
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * DELETE /api/admin/orders/:id — borra un pedido del todo.
 *
 * Es para lo que no debería estar ahí: pruebas, spam, un pedido duplicado por
 * un doble clic. Para anular una compra real está `cancelar`, que deja
 * constancia de que existió y de por qué se anuló.
 *
 * ── Las dos protecciones que no son opcionales ──
 *
 * 1. **Un pedido dentro de un cierre de caja no se puede borrar.** Las cifras
 *    de `cash_closings` quedan congeladas y el detalle del cierre se calcula
 *    leyendo los pedidos que apuntan a él. Borrar uno dejaría un cierre que
 *    dice haber recaudado más de lo que suman sus pedidos, y no hay forma de
 *    recomputarlo: el descuadre sería permanente y silencioso.
 *
 * 2. **Si tenía stock reservado, se devuelve al inventario.** El CASCADE de
 *    `order_items` borra las líneas sin enterarse de que esas unidades salieron
 *    de `products`. Sin devolverlas, borrar un pedido evapora inventario real.
 *
 * Las tablas hijas sí se van solas: `order_items` y `order_status_log` tienen
 * ON DELETE CASCADE, así que basta con borrar la fila de `orders`.
 */
export async function remove(
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const order = await env.DB.prepare(
    `SELECT id, referencia, estado, stock_reservado, closing_id FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{
      id: string;
      referencia: string;
      estado: string;
      stock_reservado: number;
      closing_id: string | null;
    }>();

  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }

  if (order.closing_id !== null) {
    throw ApiError.conflict(
      'pedido-archivado',
      'Este pedido ya entró en un cierre de caja y no se puede borrar: descuadraría la contabilidad de esa jornada.',
    );
  }

  const { results: items } = await env.DB.prepare(
    `SELECT product_id, cantidad FROM order_items WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{ product_id: string; cantidad: number }>();

  const devuelveStock = order.stock_reservado === 1 && items.length > 0;

  const statements: D1PreparedStatement[] = [];

  if (devuelveStock) {
    // Antes del DELETE: después, `order_items` ya no existe y no habría de
    // dónde sacar las cantidades.
    for (const item of items) {
      statements.push(
        env.DB.prepare(
          `UPDATE products SET stock_actual = stock_actual + ?2, actualizado_en = datetime('now')
            WHERE id = ?1`,
        ).bind(item.product_id, item.cantidad),
      );
    }
  }

  statements.push(env.DB.prepare(`DELETE FROM orders WHERE id = ?1`).bind(orderId));

  const resultados = await env.DB.batch(statements);
  const borrado = resultados[resultados.length - 1];

  if (borrado.meta.changes === 0) {
    throw ApiError.notFound('Ese pedido ya no existe.');
  }

  return json({
    ok: true,
    referencia: order.referencia,
    unidadesDevueltas: devuelveStock
      ? items.reduce((suma, item) => suma + item.cantidad, 0)
      : 0,
  });
}

/**
 * GET /api/admin/orders — lista con sus líneas.
 *
 * Dos consultas en un `batch()` (una de pedidos y otra de líneas) y el cruce en
 * memoria, en vez de una consulta por pedido. Con N pedidos son 2 viajes a D1
 * en lugar de N+1, que es lo que dispara la latencia en el edge.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const estado = url.searchParams.get('estado');
  const soloAbiertos = url.searchParams.get('abiertos') === '1';
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 200);

  const filters: string[] = [];
  const bindings: unknown[] = [];

  if (estado) {
    bindings.push(estado);
    filters.push(`estado = ?${bindings.length}`);
  }
  if (soloAbiertos) {
    filters.push('closing_id IS NULL');
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  bindings.push(limit);

  const { results: orders } = await env.DB.prepare(
    `SELECT id, referencia, cliente_nombre AS clienteNombre, cliente_telefono AS clienteTelefono,
            cliente_direccion AS clienteDireccion, estado, stock_reservado AS stockReservado,
            subtotal, envio, total, comprobante_nombre AS comprobanteNombre,
            -- Nunca la imagen: solo si la hay. Los bytes se piden aparte,
            -- cuando el admin abre el pedido concreto que quiere revisar.
            (comprobante_url IS NOT NULL) AS tieneComprobante,
            aprobado_en AS aprobadoEn,
            closing_id AS closingId, creado_en AS creadoEn
       FROM orders ${where}
      ORDER BY creado_en DESC
      LIMIT ?${bindings.length}`,
  )
    .bind(...bindings)
    .all();

  if (orders.length === 0) {
    return json({ orders: [] });
  }

  const ids = orders.map((order) => (order as { id: string }).id);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');

  const { results: items } = await env.DB.prepare(
    `SELECT oi.order_id AS orderId, oi.product_id AS productId, oi.producto_nombre AS productoNombre,
            oi.precio_unitario AS precioUnitario, oi.costo_unitario AS costoUnitario, oi.cantidad,
            -- GESTOR_PEDIDOS no tiene permiso sobre /api/admin/products (ve costo y margen,
            -- que no son de su incumbencia), así que el stock disponible viaja aquí: es la
            -- única forma en que el detalle del pedido puede mostrarlo sin ese acceso.
            p.stock_actual AS stockDisponible
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ orderId: string }>();

  const byOrder = new Map<string, unknown[]>();
  for (const item of items) {
    const bucket = byOrder.get(item.orderId) ?? [];
    bucket.push(item);
    byOrder.set(item.orderId, bucket);
  }

  return json({
    orders: orders.map((order) => ({
      ...order,
      items: byOrder.get((order as { id: string }).id) ?? [],
    })),
  });
}

/**
 * GET /api/admin/orders/:id/historial — traza de estados.
 *
 * Pensado para soporte postventa por WhatsApp: responde exactamente "¿en qué
 * va este pedido y cuándo pasó cada cosa" sin tener que reconstruirlo a ojo
 * a partir de `aprobado_en`.
 */
export async function history(env: Env, user: JwtPayload, orderId: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { results } = await env.DB.prepare(
    `SELECT estado, actor_id AS actorId, actor_nombre AS actorNombre, creado_en AS creadoEn
       FROM order_status_log
      WHERE order_id = ?1
      ORDER BY creado_en ASC, id ASC`,
  )
    .bind(orderId)
    .all();

  return json({ history: results });
}

/**
 * GET /api/admin/orders/:id/comprobante — devuelve la imagen del comprobante.
 *
 * Es el **único** sitio donde se lee `orders.comprobante_url`. Mantenerlo así
 * es lo que permite guardar la imagen en D1 sin penalizar el resto: el listado
 * del panel trae 100 pedidos y ninguno arrastra su imagen, porque ninguna otra
 * consulta selecciona esa columna.
 *
 * Protegido con el mismo rol que el resto de la gestión de pedidos: un
 * comprobante de consignación lleva el nombre del titular, el banco y el monto.
 * No es un recurso público.
 */
export async function receipt(env: Env, user: JwtPayload, orderId: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const order = await env.DB.prepare(
    `SELECT comprobante_url AS url, comprobante_nombre AS nombre, closing_id AS closingId
       FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{ url: string | null; nombre: string | null; closingId: string | null }>();

  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }
  if (!order.url) {
    // Se distingue el pedido que nunca trajo comprobante del que sí lo trajo y
    // se purgó al cerrar la caja. Con un solo mensaje, quien abre un pedido
    // archivado creería que se perdió algo.
    throw ApiError.notFound(
      order.nombre && order.closingId
        ? 'El comprobante se eliminó al cerrar la caja, cuando ya estaba verificado.'
        : 'Este pedido no tiene comprobante adjunto.',
    );
  }

  // Se devuelven bytes, no la cadena base64: ahorra un tercio del tráfico y
  // deja que el navegador la trate como una imagen normal.
  const { bytes, contentType } = decodeDataUrl(order.url);

  return new Response(bytes, {
    headers: {
      'content-type': contentType,
      // Privado y de vida corta: no debe quedar cacheado en ningún proxy
      // intermedio, pero sí puede reutilizarse mientras el admin revisa.
      'cache-control': 'private, max-age=300',
      'content-disposition': `inline; filename="${sanitizeFileName(order.nombre)}"`,
    },
  });
}

/**
 * El nombre del fichero lo eligió el cliente y acaba dentro de una cabecera
 * HTTP: sin limpiarlo, unas comillas o un salto de línea permitirían inyectar
 * cabeceras arbitrarias en la respuesta.
 */
function sanitizeFileName(name: string | null): string {
  if (!name) {
    return 'comprobante.jpg';
  }
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'comprobante.jpg';
}

async function loadOrder(env: Env, orderId: string): Promise<unknown> {
  const [orderResult, itemsResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, referencia, cliente_nombre AS clienteNombre, cliente_telefono AS clienteTelefono,
              cliente_direccion AS clienteDireccion, estado, stock_reservado AS stockReservado,
              subtotal, envio, total, comprobante_nombre AS comprobanteNombre,
              (comprobante_url IS NOT NULL) AS tieneComprobante,
              aprobado_en AS aprobadoEn, closing_id AS closingId, creado_en AS creadoEn
         FROM orders WHERE id = ?1`,
    ).bind(orderId),
    env.DB.prepare(
      `SELECT oi.product_id AS productId, oi.producto_nombre AS productoNombre,
              oi.precio_unitario AS precioUnitario, oi.costo_unitario AS costoUnitario, oi.cantidad,
              p.stock_actual AS stockDisponible
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?1`,
    ).bind(orderId),
  ]);

  const order = orderResult.results[0];
  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }

  return { ...order, items: itemsResult.results };
}

/**
 * Traduce la violación del CHECK de stock a un 400 comprensible. Sin esto, una
 * carrera perdida le llegaría al cliente como un 500 opaco.
 */
function translateConstraint(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('CHECK constraint failed') && message.includes('stock_actual')) {
    return ApiError.badRequest(
      'stock-insuficiente',
      'Otra venta se llevó esas unidades mientras procesábamos el pedido. No se aplicó ningún cambio.',
    );
  }

  if (message.includes('UNIQUE constraint failed')) {
    return ApiError.conflict('duplicado', 'Ese registro ya existe.');
  }

  return new ApiError(500, 'error-base-datos', 'No se pudo completar la operación.');
}
