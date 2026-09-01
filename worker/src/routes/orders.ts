import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { translateConstraint } from '../db-errors';
import { Env, JwtPayload } from '../types';
import { optionalAuth, requireRole } from '../auth/middleware';
import { discountedPrice, loadDiscounts, loadUserRoles } from '../pricing';
import { contactoDeUsuario, encontrarOCrearCliente } from './contacts';
import { decodeDataUrl, validateDataUrl } from '../receipts';
import {
  contenidoDePedidos,
  expandir,
  recetasActuales,
  recetasDelPedido,
  sentenciasDeInstantanea,
  stockDeCanastas,
} from '../combos';
import * as invoices from './invoices';
import * as payments from './payments';

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

export interface IncomingItem {
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
  metodoPago?: unknown;
}

/** `'transferencia'` si no viene o viene basura: es el único método que existió hasta ahora. */
function readMetodoPago(value: unknown): 'transferencia' | 'contraentrega' | 'entrega_en_tienda' {
  if (value === 'contraentrega') return 'contraentrega';
  if (value === 'entrega_en_tienda') return 'entrega_en_tienda';
  return 'transferencia';
}

/**
 * Cómo se guarda en la base lo que el cliente eligió.
 *
 * 'entrega_en_tienda' NO es un valor de `metodo_pago`: esa columna tiene un
 * CHECK que no se puede ampliar sin recrear la tabla, y recrear `orders` es
 * imposible en una base D1 que ya tiene pedidos (ver la cabecera de la
 * migración 0032 para las cuatro vías que se probaron y por qué fallan todas).
 *
 * Retirar en la tienda es, en el fondo, pagar al recibir: se guarda como
 * 'contraentrega' y el matiz vive en `medio_pago`. Como efecto secundario,
 * RECAUDADO_WHERE ya lo cuenta bien sin tocar esa constante.
 */
function columnasDePago(metodo: 'transferencia' | 'contraentrega' | 'entrega_en_tienda') {
  return metodo === 'entrega_en_tienda'
    ? { metodoPago: 'contraentrega', medioPago: 'entrega_en_tienda' }
    : { metodoPago: metodo, medioPago: null };
}

/**
 * Lo que la API devuelve como `metodoPago`, reconstruido desde las dos
 * columnas. Sin esto, un pedido que se retira en la tienda se leería como
 * 'contraentrega' y el panel diría que sale a la calle un pedido que el
 * cliente viene a recoger. Sin alias de tabla: las tres consultas que lo usan
 * seleccionan de `orders` sin aliarla.
 */
const METODO_PAGO_SQL = `CASE WHEN medio_pago = 'entrega_en_tienda'
                              THEN 'entrega_en_tienda'
                              ELSE metodo_pago END AS metodoPago`;

export interface StockRow {
  id: string;
  nombre: string;
  precio: number;
  precio_costo: number;
  stock_actual: number;
  /** 1 si el producto agrupa variantes: entonces él no se vende, sus hijas sí. */
  tiene_variantes: number;
}

/** Faltante concreto, para que el cliente sepa qué ajustar. */
export interface Shortfall {
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
export function aggregate(items: readonly IncomingItem[]): Map<string, number> {
  const required = new Map<string, number>();

  for (const item of items) {
    const productId = requireString(item.productId, 'items[].productId', 64);
    const cantidad = requireInt(item.cantidad, 'items[].cantidad', 1);
    required.set(productId, (required.get(productId) ?? 0) + cantidad);
  }

  return required;
}

/**
 * Lee stock y precios actuales de los productos pedidos, en una sola consulta.
 *
 * El `stock_actual` que devuelve **no siempre es el de la columna**: para una
 * canasta se sustituye por cuántas se pueden armar con lo que hay de sus
 * componentes. Su columna vale 0 por definición, así que dejarla pasar tal cual
 * haría que toda canasta se leyera como agotada.
 *
 * Se hace aquí, en el único sitio por el que pasan las tres validaciones de
 * disponibilidad —crear, aprobar y editar líneas—, y no en cada una: así
 * ninguna puede quedarse sin enterarse de qué es una canasta.
 */
export async function loadProducts(env: Env, ids: readonly string[]): Promise<Map<string, StockRow>> {
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.nombre, p.precio, p.precio_costo, p.stock_actual,
            EXISTS (SELECT 1 FROM products h WHERE h.parent_id = p.id) AS tiene_variantes
       FROM products p
      WHERE p.activo = 1 AND p.id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<StockRow>();

  const canastas = await stockDeCanastas(env, ids);

  return new Map(
    results.map((row) => [
      row.id,
      canastas.has(row.id) ? { ...row, stock_actual: canastas.get(row.id)! } : row,
    ]),
  );
}

/**
 * Un producto que agrupa variantes no se vende él mismo.
 *
 * Su fila existe para tener foto, nombre y categoría —es la portada de la
 * miel, no un tarro— y su `stock_actual` es 0 justamente por eso. Sin este
 * corte, pedir la madre reventaría más abajo contra el CHECK de stock, y el
 * cliente leería "no hay unidades suficientes" cuando lo que pasa es que hay
 * que elegir de cuál. La tienda ya no lo ofrece; esto es para quien llame a la
 * API a mano.
 */
export function rejectParents(ids: Iterable<string>, products: Map<string, StockRow>): void {
  for (const productId of ids) {
    const product = products.get(productId);
    if (product?.tiene_variantes) {
      throw ApiError.badRequest(
        'producto-con-variantes',
        `"${product.nombre}" se vende por variantes. Elige una de sus presentaciones.`,
      );
    }
  }
}

/**
 * POST /api/orders — cierra una compra desde la tienda.
 *
 * Reserva el inventario en el mismo paso: el cliente ya consignó, así que esas
 * unidades salen de la disponibilidad aunque el pago esté sin verificar. El
 * pedido nace en estado `verificacion` con `stock_reservado = 1`, y por eso
 * aprobarlo después **no** vuelve a descontar.
 *
 * ── Qué decide el servidor y qué acepta del cliente ──
 *
 * El navegador manda **solo qué y cuánto**: `productId` y `cantidad`. Nunca
 * precios. El importe se arma aquí leyendo `products.precio` y aplicando el
 * descuento de mayorista que corresponda a la sesión, así que manipular el
 * catálogo en devtools no cambia un peso de lo que se cobra.
 *
 * El envío también se calcula aquí, y esto sí cambió con los precios de
 * mayorista: antes se aceptaba el `envio` que mandaba el carrito. Con un
 * descuento por medio, el subtotal que ve el navegador y el que calcula el
 * servidor pueden caer a lados distintos del umbral de envío gratis, y el
 * cliente acabaría con envío gratis sobre un subtotal que ya no llega. El
 * campo `envio` del cuerpo se sigue aceptando por compatibilidad, pero se
 * ignora.
 *
 * La sesión es opcional: la tienda se compra sin cuenta, y quien no la tiene
 * paga precio de lista.
 */
export async function create(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateOrderBody>(request);

  const clienteNombre = requireString(body.clienteNombre, 'clienteNombre', 120);
  const clienteTelefono = requireString(body.clienteTelefono, 'clienteTelefono', 40);
  const clienteDireccion = requireString(body.clienteDireccion, 'clienteDireccion', 240);
  // Se valida aunque no se use, para que un cuerpo con basura en este campo
  // siga dando 400 y no pase inadvertido.
  if (body.envio !== undefined) {
    requireInt(body.envio, 'envio', 0);
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw ApiError.badRequest('carrito-vacio', 'El pedido no tiene productos.');
  }
  if (body.items.length > 100) {
    throw ApiError.badRequest('carrito-grande', 'Un pedido admite máximo 100 líneas.');
  }

  const required = aggregate(body.items as IncomingItem[]);
  const products = await loadProducts(env, [...required.keys()]);

  rejectParents(required.keys(), products);

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

  // Precio de mayorista, si la sesión lo tiene. Los roles se releen de la base
  // en vez de creerle al JWT: el token dura 8 h y a una cuenta a la que se le
  // retiró el nivel se le seguiría facturando con descuento el resto del día.
  const session = await optionalAuth(request, env);
  const roles = session ? await loadUserRoles(env, session.sub) : [];
  const discounts = await loadDiscounts(env, [...required.keys()], roles);

  /** Precio unitario ya con descuento. Es el que se congela en la línea. */
  const unitPrice = (productId: string): number =>
    discountedPrice(products.get(productId)!.precio, discounts.get(productId) ?? 0);

  const subtotal = [...required.entries()].reduce(
    (total, [productId, cantidad]) => total + unitPrice(productId) * cantidad,
    0,
  );

  const comprobanteNombre =
    typeof body.comprobanteNombre === 'string' ? body.comprobanteNombre.slice(0, 200) : null;

  // Se valida antes de tocar la base: si la imagen viene mal, el cliente
  // recibe un 400 claro y no queda ningún pedido a medias.
  const comprobanteUrl = validateDataUrl(body.comprobanteUrl);

  // Reserva de stock y estado inicial no dependen del método de pago: la
  // reserva evita sobreventa sin importar cómo se vaya a cobrar, y
  // 'verificacion' ya significa "pedido web, pendiente de revisión humana",
  // no "pendiente de comprobante" — el comprobante siempre fue opcional.
  const metodoElegido = readMetodoPago(body.metodoPago);
  const { metodoPago, medioPago } = columnasDePago(metodoElegido);

  // Sobre el subtotal ya descontado: es el importe que el cliente paga de
  // verdad, y es el que decide si alcanza el envío gratis. Excepto entrega en
  // tienda, que siempre es envío 0 — no hay domicilio que cobrar.
  const envio =
    metodoElegido === 'entrega_en_tienda'
      ? 0
      : subtotal >= FREE_SHIPPING_THRESHOLD
        ? 0
        : SHIPPING_COST;

  // Ficha en la agenda. Va FUERA del batch a propósito: es un dato de
  // conveniencia, no parte del pedido. Si fallara, no debe tumbar una compra
  // que por lo demás está bien — el pedido ya guarda su propia copia del
  // nombre, teléfono y dirección, que es lo único que hace falta para
  // entregarlo.
  //
  // Con sesión, se usa la ficha que un SUPER_ADMIN enlazó a esa cuenta desde
  // Usuarios (migración 0024) — así el mayorista siempre acumula su deuda en
  // el mismo sitio, sin importar qué teléfono escriba ese día. Si la cuenta no
  // tiene enlace —o no hay sesión— se busca o crea por teléfono, como a
  // cualquier invitado.
  const contactId =
    (session && (await contactoDeUsuario(env, session.sub, clienteDireccion))) ||
    (await encontrarOCrearCliente(env, {
      nombre: clienteNombre,
      telefono: clienteTelefono,
      direccion: clienteDireccion,
    }));

  const statements: D1PreparedStatement[] = [
    // La referencia se calcula dentro de la propia transacción: leerla antes y
    // escribirla después dejaría una ventana para asignar el mismo número dos
    // veces. El UNIQUE de la columna es la red de seguridad.
    env.DB.prepare(
      `INSERT INTO orders (
         id, referencia, user_id, contact_id,
         cliente_nombre, cliente_telefono, cliente_direccion,
         estado, stock_reservado, subtotal, envio, total,
         comprobante_nombre, comprobante_url, metodo_pago, medio_pago
       ) VALUES (
         ?1,
         'ORD-' || (SELECT COALESCE(MAX(CAST(substr(referencia, 5) AS INTEGER)), 1000) + 1 FROM orders),
         ?2, ?3, ?4, ?5, ?6, 'verificacion', 1, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       )`,
    ).bind(
      orderId,
      // Queda apuntado quién compró cuando había sesión. Es lo que permite
      // auditar después por qué una línea salió por debajo del precio de
      // lista: sin esto, un pedido con descuento sería indistinguible de un
      // error de precios.
      session?.sub ?? null,
      contactId,
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
      metodoPago,
      medioPago,
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
      ).bind(
        orderId,
        productId,
        product.nombre,
        // El precio **cobrado**, no el de lista: la línea es el documento de
        // lo que se facturó. Guardar aquí el de catálogo dejaría un pedido que
        // suma más que su propio total, y descuadraría el cierre de caja, que
        // se calcula sumando líneas.
        unitPrice(productId),
        product.precio_costo,
        cantidad,
      ),
    );
  }

  // La línea del pedido dice «1 Canasta Pequeña»; el inventario tiene que ver
  // la papa, el tomate y el aguacate. `expandir` traduce lo uno en lo otro y
  // **suma**: una canasta con 1 kg de papa más 2 kg sueltos son 3 kg en una
  // sola resta, no dos que pasarían el CHECK por separado.
  const recetas = await recetasActuales(env, [...required.keys()]);
  const movimientos = expandir(required, recetas);

  // Qué llevaba cada canasta hoy, congelado en el pedido: es lo que hará
  // cuadrar la devolución si mañana cambia la receta.
  statements.push(...sentenciasDeInstantanea(env, orderId, required, recetas));

  for (const [productId, cantidad] of movimientos) {
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
    // La factura nace aquí, en el mismo batch que descuenta el inventario
    // (migración 0027). Emitirla después, en otra petición, dejaría una
    // ventana en la que el pedido está aprobado y la venta sin facturar — y si
    // esa segunda petición fallara, la mercancía habría salido sin documento.
    //
    // Lleva la misma guarda de token que el apunte de arriba, y por el mismo
    // motivo: solo factura quien ganó la carrera de aprobación.
    invoices.emitirStatement(env, `inv-${orderId}`, orderId, token),
    // Las líneas van en el mismo batch: una factura sin líneas no se puede
    // imprimir ni auditar.
    invoices.emitirLineasStatement(env, `inv-${orderId}`, orderId, token),
  ];

  if (necesitaDescuento) {
    // La receta congelada al vender, no la de hoy: si la canasta cambió entre
    // el pedido y su aprobación, lo que se descuenta tiene que ser lo que se
    // le prometió al cliente.
    const movimientos = expandir(
      new Map(items.map((item) => [item.product_id, item.cantidad])),
      await recetasDelPedido(env, orderId),
    );

    for (const [productId, cantidad] of movimientos) {
      statements.push(
        env.DB.prepare(
          `UPDATE products
              SET stock_actual = stock_actual - ?2, actualizado_en = ?4
            WHERE id = ?1
              AND (SELECT aprobacion_token FROM orders WHERE id = ?3) = ?5`,
        ).bind(productId, cantidad, orderId, now, token),
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
 * POST /api/admin/orders/:id/pagar — el domiciliario marca que cobró un
 * pedido contra entrega.
 *
 * Mismo patrón que ship(): una sola columna cambia, sin token de idempotencia
 * — no toca stock ni dinero, así que un doble-submit concurrente (mal
 * internet, doble-tap) hace que el segundo UPDATE afecte 0 filas sin efecto
 * secundario. Ver la migración 0015 para el porqué de que esto NO sea todavía
 * "dinero recaudado": ese efectivo sigue en el bolsillo del domiciliario hasta
 * que un admin lo liquide (ver liquidar() más abajo).
 */
export async function markPaid(
  request: Request,
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'DOMICILIARIO');

  /**
   * `monto` es opcional: sin él, cobro completo, que sigue siendo el caso de
   * siempre. Con él, es un abono — el cliente en la puerta solo tenía una
   * parte — y lo que falte se queda vivo en el saldo de la factura.
   *
   * El cuerpo puede llegar vacío (`{}`), que es justo lo que manda hoy el
   * botón de "cobro completo": por eso se lee con `.catch()` en vez de dejar
   * que `readJson` reviente por falta de cuerpo.
   */
  const body = await readJson<{ monto?: unknown }>(request).catch(() => ({ monto: undefined }));
  const monto =
    body.monto === undefined || body.monto === null
      ? undefined
      : requireInt(body.monto, 'monto', 1);

  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET estado = 'pago'
        WHERE id = ?1 AND estado = 'enviado' AND metodo_pago = 'contraentrega'`,
    ).bind(orderId),
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'pago', ?2, ?3
        WHERE (SELECT estado FROM orders WHERE id = ?1) = 'pago'`,
    ).bind(orderId, user.sub, user.nombre),
    // El cobro de verdad (0028): un `payment` con su reparto contra la
    // factura. `liquidado: 0` porque este efectivo sigue en el bolsillo del
    // domiciliario hasta que alguien lo entregue en la finca — contarlo antes
    // en el cierre sería contar plata que nadie ha visto.
    ...payments.cobrarPedidoStatements(env, `pay-cod-${orderId}`, orderId, user, {
      metodo: 'efectivo',
      liquidado: 0,
      monto,
    }),
  ]);

  if (updateResult.meta.changes === 0) {
    // Distingue la carrera perdida (alguien más ya lo cobró) del caso general,
    // porque a quien la pierde no le sirve reintentar: el efectivo ya lo tiene
    // en la mano y tiene que reportarlo, no volver a tocar el botón.
    const actual = await env.DB.prepare(`SELECT estado, metodo_pago FROM orders WHERE id = ?1`)
      .bind(orderId)
      .first<{ estado: string; metodo_pago: string }>();

    if (actual?.estado === 'pago') {
      throw ApiError.conflict(
        'ya-pagado',
        'Este pedido ya fue marcado como pagado por otra persona. Si ya cobraste, avisa para revisar el efectivo.',
      );
    }
    throw ApiError.conflict(
      'estado-invalido',
      actual?.metodo_pago !== 'contraentrega'
        ? 'Este pedido no es contra entrega.'
        : 'Solo se puede marcar como pagado un pedido enviado.',
    );
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * POST /api/admin/orders/:id/entregar — el domiciliario confirma que un
 * pedido que NO es contra entrega ya tocó la puerta.
 *
 * Es el equivalente de markPaid() para lo que no hay nada que cobrar: mismo
 * patrón (una sola columna cambia, sin token de idempotencia — un
 * doble-submit hace que el segundo UPDATE afecte 0 filas sin efecto
 * secundario más allá de un posible duplicado en la traza, igual que en
 * markPaid()/settleCash()), pero `estado` se queda en 'enviado' — no hay
 * transición que hacer, solo una fecha que anotar. Ver la migración 0018.
 *
 * Contra entrega no pasa por aquí: ahí `pagar()` confirma cobro y entrega en
 * el mismo paso, y esta ruta lo rechaza para no dejar dos caminos abiertos
 * hacia el mismo pedido.
 */
export async function confirmDelivery(
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'DOMICILIARIO');

  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET entregado_en = datetime('now')
        WHERE id = ?1 AND estado = 'enviado' AND metodo_pago <> 'contraentrega'
          AND entregado_en IS NULL`,
    ).bind(orderId),
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'entregado', ?2, ?3
        WHERE (SELECT entregado_en FROM orders WHERE id = ?1) IS NOT NULL`,
    ).bind(orderId, user.sub, user.nombre),
  ]);

  if (updateResult.meta.changes === 0) {
    // Distingue "ya la confirmó otra persona" del caso general, por el mismo
    // motivo que markPaid() separa 'ya-pagado': a quien pierde esa carrera no
    // le sirve reintentar, solo confundiría un segundo mensaje de error.
    const actual = await env.DB.prepare(
      `SELECT estado, metodo_pago, entregado_en FROM orders WHERE id = ?1`,
    )
      .bind(orderId)
      .first<{ estado: string; metodo_pago: string; entregado_en: string | null }>();

    if (actual?.entregado_en) {
      throw ApiError.conflict(
        'ya-entregado',
        'Este pedido ya fue confirmado como entregado.',
      );
    }
    throw ApiError.conflict(
      'estado-invalido',
      actual?.metodo_pago === 'contraentrega'
        ? 'Este pedido es contra entrega: se confirma junto con el cobro.'
        : 'Solo se puede confirmar la entrega de un pedido enviado.',
    );
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * POST /api/admin/orders/:id/credito — se le fía este pedido al cliente.
 *
 * El checkout público no puede llegar aquí: `readMetodoPago()` es lista
 * blanca y solo deja pasar 'contraentrega'. Fiar es siempre una decisión de
 * alguien del panel sobre una ficha concreta.
 *
 * ── Se le fía a la FICHA, no a la cuenta (migración 0023) ──
 *
 * Antes esto exigía `orders.user_id`, así que solo se le podía fiar a alguien
 * con contraseña — y cuatro de cada cinco pedidos son de invitado. La deuda la
 * tiene una persona, no un usuario del panel, así que el cupo vive en
 * `contacts` y se lee por `contact_id`, que TODO pedido tiene desde la 0022.
 *
 * Un mayorista con login funciona igual: su pedido también trae `contact_id`,
 * porque el checkout lo ficha por teléfono como a cualquiera.
 *
 * ── Por qué el cupo se comprueba dentro del UPDATE ──
 *
 * Leer el cupo, sumar la deuda y luego escribir deja una ventana entre la
 * lectura y la escritura: dos pedidos concedidos a la vez al mismo cliente
 * pasarían los dos la comprobación y juntos se saldrían del cupo. Metiendo la
 * suma en el propio WHERE, SQLite evalúa y escribe en la misma sentencia y el
 * segundo afecta 0 filas — que es exactamente lo que hay que decirle a quien
 * lo intentó.
 *
 * `vence_en` sale de `dias_credito` de la ficha y se calcula en la base, no en
 * el navegador de quien pulsa: el vencimiento de una factura no puede depender
 * de la zona horaria del que la crea.
 */
export async function grantCredit(
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  // Deuda viva de esa misma ficha, sin contar este pedido. Es la definición
  // que usa cartera(): a crédito, aprobado o enviado, todavía sin 'pago'.
  const DEUDA_ACTUAL = `COALESCE((
        SELECT SUM(d.total) FROM orders d
         WHERE d.contact_id = o.contact_id
           AND d.metodo_pago = 'credito'
           AND d.estado IN ('aprobado', 'enviado')
           AND d.id <> o.id
      ), 0)`;

  const CUPO = `(SELECT cupo_credito FROM contacts WHERE id = o.contact_id)`;

  const result = await env.DB.prepare(
    `UPDATE orders AS o
        SET metodo_pago = 'credito',
            vence_en = date('now', '-5 hours',
                            '+' || (SELECT dias_credito FROM contacts WHERE id = o.contact_id) || ' days')
      WHERE o.id = ?1
        AND o.metodo_pago <> 'credito'
        AND o.estado IN ('aprobado', 'enviado')
        AND o.contact_id IS NOT NULL
        AND ${CUPO} > 0
        AND o.total + ${DEUDA_ACTUAL} <= ${CUPO}`,
  )
    .bind(orderId)
    .run();

  if (result.meta.changes === 0) {
    throw await explicarRechazoCredito(env, orderId);
  }

  await env.DB.prepare(
    `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
     VALUES (?1, 'editado', ?2, ?3)`,
  )
    .bind(orderId, user.sub, user.nombre)
    .run();

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * Por qué no se pudo fiar. Se calcula solo cuando ya falló, así que el camino
 * feliz sigue siendo una sola consulta.
 */
async function explicarRechazoCredito(env: Env, orderId: string): Promise<ApiError> {
  const fila = await env.DB.prepare(
    `SELECT o.estado, o.metodo_pago, o.total,
            o.contact_id AS contactId, o.cliente_nombre AS clienteNombre,
            c.nombre AS contactoNombre,
            COALESCE(c.cupo_credito, 0) AS cupo,
            COALESCE((
              SELECT SUM(d.total) FROM orders d
               WHERE d.contact_id = o.contact_id
                 AND d.metodo_pago = 'credito'
                 AND d.estado IN ('aprobado', 'enviado')
                 AND d.id <> o.id
            ), 0) AS deuda
       FROM orders o
       LEFT JOIN contacts c ON c.id = o.contact_id
      WHERE o.id = ?1`,
  )
    .bind(orderId)
    .first<{
      estado: string;
      metodo_pago: string;
      total: number;
      contactId: string | null;
      clienteNombre: string;
      contactoNombre: string | null;
      cupo: number;
      deuda: number;
    }>();

  if (!fila) {
    return ApiError.notFound('Ese pedido no existe.');
  }
  if (fila.metodo_pago === 'credito') {
    return ApiError.conflict('ya-es-credito', 'Este pedido ya estaba a crédito.');
  }
  if (!['aprobado', 'enviado'].includes(fila.estado)) {
    return ApiError.conflict(
      'estado-invalido',
      `Solo se fía un pedido aprobado o enviado, y este está ${fila.estado}.`,
    );
  }
  // Solo les pasa a los pedidos anteriores a la agenda (migración 0022): desde
  // entonces el checkout ficha a todo el mundo por teléfono.
  if (!fila.contactId) {
    return ApiError.conflict(
      'sin-ficha',
      `Este pedido no está enlazado a ninguna ficha de la agenda, así que no hay a quién cobrarle. Crea el contacto de "${fila.clienteNombre}" en Contactos y vuelve a intentarlo.`,
    );
  }
  if (fila.cupo === 0) {
    return ApiError.conflict(
      'sin-cupo',
      `"${fila.contactoNombre}" no tiene cupo de crédito. Ábreselo en Contactos —no hace falta que tenga cuenta— y vuelve a intentarlo.`,
      { contactId: fila.contactId },
    );
  }
  const libre = fila.cupo - fila.deuda;
  return ApiError.conflict(
    'cupo-excedido',
    `Se pasa del cupo: debe ${fila.deuda} de ${fila.cupo}, le quedan ${libre} y este pedido son ${fila.total}.`,
    { cupo: fila.cupo, deuda: fila.deuda, libre, total: fila.total },
  );
}

/**
 * POST /api/admin/orders/:id/recaudar — el mayorista pagó lo que debía.
 *
 * Va aparte de markPaid() aunque las dos escriban estado='pago', por dos
 * razones que no son de estilo:
 *
 * - **Quién.** markPaid() lo puede llamar un DOMICILIARIO, que es quien tiene
 *   el efectivo en la mano. Un crédito no lo cobra nadie en la calle: el
 *   mayorista transfiere. Un domiciliario que pudiera marcar una deuda como
 *   pagada estaría certificando algo que no presenció.
 * - **Desde dónde.** Contra entrega solo se cobra tras enviar. Una deuda se
 *   puede pagar en cuanto existe: el mayorista puede transferir el mismo día
 *   que se aprueba el pedido, antes de que salga el camión. De ahí que aquí
 *   valgan 'aprobado' y 'enviado'.
 *
 * Sin token de idempotencia, mismo argumento que markPaid(): no toca stock ni
 * inventario, solo una columna y una traza. El segundo envío de un doble
 * click afecta 0 filas.
 *
 * A partir de aquí el pedido sí encaja en RECAUDADO_WHERE, así que lo recoge
 * el siguiente cierre de caja. No se toca `efectivo_liquidado`: esa columna
 * es de contra entrega, y aquí no hay efectivo de nadie que liquidar.
 */
export async function collectCredit(
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET estado = 'pago'
        WHERE id = ?1 AND metodo_pago = 'credito' AND estado IN ('aprobado', 'enviado')`,
    ).bind(orderId),
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'pago', ?2, ?3
        WHERE (SELECT estado FROM orders WHERE id = ?1) = 'pago'`,
    ).bind(orderId, user.sub, user.nombre),
    // Cobro del fiado (0028). `liquidado: 1`: un crédito se salda por
    // transferencia, así que la plata entra a la cuenta en el acto y no hay
    // efectivo de nadie que liquidar.
    //
    // Esto salda la factura ENTERA. Para cobrar solo una parte está
    // `POST /api/admin/payments`, que es el camino que admite abonos.
    ...payments.cobrarPedidoStatements(env, `pay-cre-${orderId}`, orderId, user, {
      metodo: 'transferencia',
      liquidado: 1,
    }),
  ]);

  if (updateResult.meta.changes === 0) {
    const actual = await env.DB.prepare(`SELECT estado, metodo_pago FROM orders WHERE id = ?1`)
      .bind(orderId)
      .first<{ estado: string; metodo_pago: string }>();

    if (!actual) {
      throw ApiError.notFound('Ese pedido no existe.');
    }
    if (actual.metodo_pago !== 'credito') {
      throw ApiError.conflict('no-es-credito', 'Este pedido no se vendió a crédito.');
    }
    if (actual.estado === 'pago') {
      throw ApiError.conflict(
        'ya-pagado',
        'Esta deuda ya fue registrada como pagada por otra persona.',
      );
    }
    throw ApiError.conflict(
      'estado-invalido',
      `No se puede recaudar un pedido ${actual.estado}.`,
    );
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * POST /api/admin/orders/:id/liquidar — un admin confirma que el efectivo
 * cobrado por el domiciliario ya está físicamente en la finca.
 *
 * Paso separado de markPaid() a propósito: el domiciliario no se autocertifica
 * — quien confirma que el dinero llegó no puede ser quien lo trae encima. Sin
 * token: no muta stock, solo un flag + traza, mismo argumento que markPaid().
 */
export async function settleCash(env: Env, user: JwtPayload, orderId: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET efectivo_liquidado = 1
        WHERE id = ?1 AND estado = 'pago' AND metodo_pago = 'contraentrega' AND efectivo_liquidado = 0`,
    ).bind(orderId),
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'liquidado', ?2, ?3
        WHERE (SELECT efectivo_liquidado FROM orders WHERE id = ?1) = 1`,
    ).bind(orderId, user.sub, user.nombre),
    // El cobro pasa a contar para el cierre: hasta ahora era plata cobrada
    // pero no disponible. Mismo hecho que `efectivo_liquidado`, anotado
    // también en el lado del dinero (0028).
    payments.liquidarPedidoStatement(env, orderId),
  ]);

  if (updateResult.meta.changes === 0) {
    throw ApiError.conflict(
      'estado-invalido',
      'Solo se puede liquidar un pedido contra entrega ya pagado y sin liquidar.',
    );
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * POST /api/admin/orders/:id/rechazar-entrega — el cliente rechazó el pedido
 * en la puerta.
 *
 * Único camino de reversión para un pedido 'enviado' — cancel() lo bloquea a
 * propósito. Es el espejo de cancel() y comparte su mecánica: sí muta stock,
 * así que sí necesita token de idempotencia (reutiliza las columnas de
 * cancelación, no hace falta agregar otras — el significado es el mismo:
 * quién/cuándo/por qué se canceló, con o sin token).
 *
 * `orders.estado` termina en 'cancelado' —no un estado nuevo— para que toda la
 * UI que ya filtra por 'cancelado' siga funcionando. La distinción "rechazado
 * en la puerta" vive solo en la traza: se registra 'rechazado', no
 * 'cancelado', el mismo truco que usa 'editado' para no mentir en
 * `orders.estado`.
 *
 * También lo puede llamar el `DOMICILIARIO`: es quien está delante cuando el
 * cliente no paga, y sin este permiso el pedido se le quedaría atascado en su
 * lista de entregas hasta que alguien de escritorio lo viera y lo cancelara a
 * mano.
 */
export async function rejectDelivery(
  request: Request,
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'DOMICILIARIO');

  const body = await readJson<{ motivo?: unknown }>(request).catch(() => ({ motivo: undefined }));
  const motivo =
    typeof body.motivo === 'string' && body.motivo.trim() !== ''
      ? body.motivo.trim().slice(0, 300)
      : null;

  const order = await env.DB.prepare(
    `SELECT id, estado, metodo_pago FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{ id: string; estado: string; metodo_pago: string }>();

  if (!order) {
    throw ApiError.notFound('Ese pedido no existe.');
  }
  if (order.estado !== 'enviado' || order.metodo_pago !== 'contraentrega') {
    throw ApiError.conflict(
      'estado-invalido',
      order.metodo_pago !== 'contraentrega'
        ? 'Solo un pedido contra entrega se puede rechazar en la puerta.'
        : `Un pedido "${order.estado}" no se puede rechazar en la puerta.`,
    );
  }

  const { results: items } = await env.DB.prepare(
    `SELECT product_id, cantidad FROM order_items WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{ product_id: string; cantidad: number }>();

  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE orders
          SET estado = 'cancelado', cancelado_por = ?2, cancelado_en = ?3,
              cancelacion_token = ?4, motivo_cancelacion = ?5
        WHERE id = ?1
          AND cancelacion_token IS NULL
          AND estado = 'enviado'`,
    ).bind(orderId, user.sub, now, token, motivo),
    // 'rechazado' y no 'cancelado': documenta que este pedido llegó a salir y
    // se rechazó en la puerta, distinto de una cancelación temprana — la
    // métrica de tasa de rechazo COD depende de esta distinción.
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'rechazado', ?2, ?3
        WHERE (SELECT cancelacion_token FROM orders WHERE id = ?1) = ?4`,
    ).bind(orderId, user.sub, user.nombre, token),
    // Este pedido sí llegó a aprobarse, así que tiene factura (0027) y hay que
    // anularla: un rechazo en la puerta no deja deuda. `cancel()` no necesita
    // esta línea porque solo cancela pedidos sin aprobar, que nunca se
    // facturaron.
    invoices.anularPorPedidoStatement(env, orderId, `Rechazado en la entrega: ${motivo}`),
  ];

  // A diferencia de cancel(), aquí siempre se devuelve stock: un pedido
  // 'enviado' siempre tiene `stock_reservado = 1` (se descontó al aprobarlo,
  // o antes, al crearse) — no hay caso donde no haya nada que devolver.
  const movimientos = expandir(
    new Map(items.map((item) => [item.product_id, item.cantidad])),
    await recetasDelPedido(env, orderId),
  );

  for (const [productId, cantidad] of movimientos) {
    statements.push(
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual + ?2, actualizado_en = ?4
          WHERE id = ?1
            AND (SELECT cancelacion_token FROM orders WHERE id = ?3) = ?5`,
      ).bind(productId, cantidad, orderId, now, token),
    );
  }

  let batchResults: D1Result[];
  try {
    batchResults = await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  if (batchResults[0].meta.changes === 0) {
    throw ApiError.conflict('estado-invalido', 'Otro usuario ya resolvió este pedido.');
  }

  return json({
    order: await loadOrder(env, orderId),
    unidadesDevueltas: items.reduce((suma, item) => suma + item.cantidad, 0),
  });
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
    // Con la receta congelada: devolver según la de hoy dejaría descontado para
    // siempre el componente que se le quitó a la canasta desde que se vendió.
    const movimientos = expandir(
      new Map(items.map((item) => [item.product_id, item.cantidad])),
      await recetasDelPedido(env, orderId),
    );

    for (const [productId, cantidad] of movimientos) {
      statements.push(
        env.DB.prepare(
          `UPDATE products
              SET stock_actual = stock_actual + ?2, actualizado_en = ?4
            WHERE id = ?1
              AND (SELECT cancelacion_token FROM orders WHERE id = ?3) = ?5`,
        ).bind(productId, cantidad, orderId, now, token),
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
    `SELECT id, estado, stock_reservado, closing_id, user_id FROM orders WHERE id = ?1`,
  )
    .bind(orderId)
    .first<{
      id: string;
      estado: string;
      stock_reservado: number;
      closing_id: string | null;
      user_id: string | null;
    }>();

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
      // Solo se mira al **subir** una línea. Si un producto que ya se había
      // vendido pasó después a agrupar variantes, su línea vieja se puede
      // conservar o reducir: bloquearla entera dejaría el pedido inmodificable
      // por un cambio de catálogo posterior a la compra.
      rejectParents([productId], products);
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

  // Una línea nueva se cobra al precio que tendría **ese cliente** hoy, no al
  // de lista: añadirle un producto a un pedido de mayorista desde el panel no
  // puede salirle más caro que si lo hubiera puesto él mismo en el carrito.
  // Si el pedido era de invitado (`user_id` nulo), no hay descuento que buscar.
  const compradorRoles = order.user_id ? await loadUserRoles(env, order.user_id) : [];
  const compradorDiscounts = await loadDiscounts(env, [...required.keys()], compradorRoles);

  // Subtotal del pedido resultante: precio histórico para lo que ya estaba,
  // precio de catálogo —con el descuento del comprador— para lo que se añade.
  let subtotal = 0;
  for (const [productId, cantidad] of required) {
    const historico = existing.get(productId);
    const precio = historico
      ? historico.precio_unitario
      : discountedPrice(
          products.get(productId)!.precio,
          compradorDiscounts.get(productId) ?? 0,
        );
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

  // ── Recetas: congelada para lo que ya estaba, de hoy para lo que se añade ──
  //
  // Una línea que ya existía se mueve con la receta que se le congeló al
  // vender. Una línea nueva se congela ahora, igual que toma el precio de hoy.
  //
  // Un pedido anterior a las canastas no tiene instantánea, así que su mapa
  // sale vacío y sus líneas se tratan como productos simples — que es
  // exactamente como se descontaron en su día.
  const congeladas = await recetasDelPedido(env, orderId);
  const nuevasCanastas = deltas.filter((d) => d.oldQty === 0).map((d) => d.productId);
  const deHoy = await recetasActuales(env, nuevasCanastas);

  const recetas = new Map(congeladas);
  for (const productId of nuevasCanastas) {
    const receta = deHoy.get(productId);
    if (receta) {
      recetas.set(productId, receta);
    }
  }

  for (const delta of deltas) {
    if (delta.newQty === 0) {
      statements.push(
        env.DB.prepare(`DELETE FROM order_items WHERE order_id = ?1 AND product_id = ?2`).bind(
          orderId,
          delta.productId,
        ),
      );
      // La instantánea de una línea que ya no está sobra: si se vuelve a
      // añadir esa canasta después, se congelará la receta de ese momento.
      statements.push(
        env.DB.prepare(
          `DELETE FROM order_item_components WHERE order_id = ?1 AND parent_product_id = ?2`,
        ).bind(orderId, delta.productId),
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
          discountedPrice(product.precio, compradorDiscounts.get(delta.productId) ?? 0),
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

  }

  // Congela la receta de las canastas recién añadidas, en el mismo batch.
  statements.push(
    ...sentenciasDeInstantanea(
      env,
      orderId,
      new Map(deltas.filter((d) => d.oldQty === 0).map((d) => [d.productId, d.newQty])),
      recetas,
    ),
  );

  // El inventario en vivo solo existe si el pedido lo reservó. Un `diff`
  // positivo pide más (se resta), uno negativo devuelve (se suma) — la misma
  // resta cubre las dos direcciones, también al expandirla: un `diff` negativo
  // multiplica en negativo y acaba sumando el componente de vuelta.
  //
  // Se expande todo junto y no línea por línea para que dos movimientos del
  // mismo componente —una canasta que sube y la papa suelta que baja— se
  // netearan en una sola resta en vez de pelearse contra el CHECK por separado.
  if (order.stock_reservado === 1) {
    const movimientos = expandir(
      new Map(deltas.map((delta) => [delta.productId, delta.diff])),
      recetas,
    );

    for (const [productId, cantidad] of movimientos) {
      if (cantidad === 0) {
        continue;
      }
      statements.push(
        env.DB.prepare(
          `UPDATE products
              SET stock_actual = stock_actual - ?2, actualizado_en = ?3
            WHERE id = ?1`,
        ).bind(productId, cantidad, now),
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
    // dónde sacar las cantidades. Lo mismo vale para la receta congelada, que
    // cuelga del pedido y se borra con él.
    const movimientos = expandir(
      new Map(items.map((item) => [item.product_id, item.cantidad])),
      await recetasDelPedido(env, orderId),
    );

    for (const [productId, cantidad] of movimientos) {
      statements.push(
        env.DB.prepare(
          `UPDATE products SET stock_actual = stock_actual + ?2, actualizado_en = datetime('now')
            WHERE id = ?1`,
        ).bind(productId, cantidad),
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
            ${METODO_PAGO_SQL}, canal, medio_pago AS medioPago,
            efectivo_liquidado AS efectivoLiquidado, vence_en AS venceEn,
            closing_id AS closingId, creado_en AS creadoEn,
            domiciliario_id AS domiciliarioId, domiciliario_nombre AS domiciliarioNombre
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
    .all<{ orderId: string; productId: string }>();

  // Qué llevaba cada canasta del pedido, con la receta congelada del día que
  // se vendió. Sin esto, "Canasta Pequeña × 3" no dice qué salió de la bodega.
  const contenidos = await contenidoDePedidos(env, ids);

  const byOrder = new Map<string, unknown[]>();
  for (const item of items) {
    const contenido = contenidos.get(`${item.orderId}:${item.productId}`);
    const bucket = byOrder.get(item.orderId) ?? [];
    bucket.push(contenido ? { ...item, contiene: contenido } : item);
    byOrder.set(item.orderId, bucket);
  }

  return json({
    orders: orders.map((order) => ({
      ...order,
      items: byOrder.get((order as { id: string }).id) ?? [],
    })),
  });
}

interface AsignarBody {
  domiciliarioId?: unknown;
}

/**
 * POST /api/admin/orders/:id/domiciliario — asignar o soltar el reparto.
 *
 * Mandar `domiciliarioId: null` lo desasigna, que es lo que hace falta cuando
 * alguien se enferma a mitad de ruta. Reasignar es simplemente volver a
 * asignar: no hay estado intermedio ni hay que soltar primero.
 *
 * Solo `GESTOR_PEDIDOS`: un domiciliario no se adjudica pedidos a sí mismo.
 *
 * Se guarda también el nombre, congelado. Si mañana se borra la cuenta, la FK
 * pone el id en NULL pero el pedido tiene que poder seguir diciendo quién lo
 * llevó — es el mismo criterio que `cliente_nombre` frente a `contact_id`.
 *
 * Queda traza en `order_status_log`: reasignar a mitad de jornada es
 * justamente el tipo de cosa que después nadie recuerda al cuadrar el efectivo.
 */
export async function assignCourier(
  request: Request,
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<AsignarBody>(request);
  const soltar = body.domiciliarioId === null || body.domiciliarioId === '';
  const domiciliarioId = soltar
    ? null
    : requireString(body.domiciliarioId, 'domiciliarioId', 80);

  let nombre: string | null = null;

  if (domiciliarioId) {
    // Se comprueba el rol, no solo que el usuario exista: asignarle un reparto
    // a quien lleva el inventario dejaría el pedido en manos de alguien que no
    // tiene la pantalla para entregarlo.
    const candidato = await env.DB.prepare(
      `SELECT u.nombre
         FROM users u
         JOIN user_roles r ON r.user_id = u.id
        WHERE u.id = ?1 AND u.activo = 1 AND r.role = 'DOMICILIARIO'`,
    )
      .bind(domiciliarioId)
      .first<{ nombre: string }>();

    if (!candidato) {
      throw ApiError.badRequest(
        'domiciliario-invalido',
        'Esa cuenta no existe, está desactivada o no tiene el rol de domiciliario.',
      );
    }
    nombre = candidato.nombre;
  }

  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET domiciliario_id = ?2, domiciliario_nombre = ?3
        WHERE id = ?1 AND estado IN ('aprobado', 'enviado')`,
    ).bind(orderId, domiciliarioId, nombre),
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       SELECT ?1, 'enviado', ?2, ?3
        WHERE (SELECT COUNT(*) FROM orders
                WHERE id = ?1 AND estado IN ('aprobado', 'enviado')) = 1`,
    ).bind(orderId, user.sub, user.nombre),
  ]);

  if (updateResult.meta.changes === 0) {
    const actual = await env.DB.prepare(`SELECT estado FROM orders WHERE id = ?1`)
      .bind(orderId)
      .first<{ estado: string }>();

    if (!actual) {
      throw ApiError.notFound('Ese pedido no existe.');
    }
    throw ApiError.conflict(
      'estado-invalido',
      `Solo se le asigna domiciliario a un pedido aprobado o enviado, y este está ${actual.estado}.`,
    );
  }

  return json({ order: await loadOrder(env, orderId) });
}

/**
 * GET /api/admin/couriers — las cuentas que pueden repartir.
 *
 * Vive aquí y no en users.ts porque es la lista que llena el desplegable de
 * asignación, no una pantalla de administración de cuentas: solo devuelve id y
 * nombre, sin correo ni nada de la cuenta.
 */
export async function couriers(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.nombre
       FROM users u
       JOIN user_roles r ON r.user_id = u.id
      WHERE r.role = 'DOMICILIARIO' AND u.activo = 1
      ORDER BY u.nombre COLLATE NOCASE`,
  ).all();

  return json({ couriers: results });
}

/**
 * GET /api/admin/entregas — pedidos enviados que el domiciliario todavía
 * tiene pendientes en la calle.
 *
 * No son solo los contra entrega: un pedido pagado por transferencia también
 * sale a repartir, y el domiciliario necesita verlo en su lista aunque no
 * haya nada que cobrarle — solo confirmar que ya tocó la puerta
 * (`entregar()`). Por eso el filtro es "contra entrega" (siempre, hasta que
 * se cobre y `estado` deje de ser 'enviado') **o** "todavía sin
 * `entregado_en`" (para el resto, hasta que se confirme la entrega). Ver la
 * migración 0018.
 *
 * Deliberadamente NO reutiliza list(): esa consulta trae `costoUnitario` sin
 * filtrar por rol, y un domiciliario no tiene por qué ver costo ni margen.
 * En vez de condicionar campos dentro de un handler que ya asume confianza de
 * GESTOR_PEDIDOS, esta es una consulta propia que nunca selecciona esa
 * columna — mismo espíritu que separar components.ts de products.ts.
 */
export async function deliveries(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'DOMICILIARIO');

  /**
   * Un domiciliario ve SOLO lo suyo; un gestor ve toda la calle.
   *
   * Lo sin asignar también lo ve el domiciliario: si la lista se limitara a lo
   * que lleva su nombre, un pedido que nadie asignó desaparecería de todas las
   * pantallas y se quedaría en la calle sin que nadie lo reclame. Prefiere
   * enseñarlo de más a perderlo.
   */
  const esSoloDomiciliario =
    user.roles.includes('DOMICILIARIO') && !user.roles.includes('GESTOR_PEDIDOS');

  const filtroMio = esSoloDomiciliario
    ? `AND (domiciliario_id = ?1 OR domiciliario_id IS NULL)`
    : '';

  const { results: orders } = await env.DB.prepare(
    `SELECT id, referencia, cliente_nombre AS clienteNombre,
            cliente_telefono AS clienteTelefono, cliente_direccion AS clienteDireccion,
            total, creado_en AS creadoEn, ${METODO_PAGO_SQL},
            domiciliario_id AS domiciliarioId,
            domiciliario_nombre AS domiciliarioNombre,
            contact_id AS contactId,
            -- Lo que este cliente debe de ANTES, sin contar la factura de este
            -- mismo pedido. Viaja con la entrega porque es lo que el
            -- domiciliario necesita saber en la puerta: muchas veces le pagan
            -- de una deuda vieja, y sin esta cifra tendría que llamar a
            -- preguntar cuánto es.
            IFNULL((SELECT SUM(i.saldo) FROM invoices i
                     WHERE i.contact_id = orders.contact_id
                       AND i.estado <> 'anulada'
                       AND i.tipo = 'factura'
                       AND (i.order_id IS NULL OR i.order_id <> orders.id)), 0) AS deudaAnterior
       FROM orders
      WHERE estado = 'enviado'
        AND (metodo_pago = 'contraentrega' OR entregado_en IS NULL)
        -- Ni las ventas de mostrador ni las compras que el cliente viene a
        -- recoger salen a la calle. Las dos se guardan como 'contraentrega'
        -- —se paga al recibir— así que sin esta línea aparecerían en la ruta
        -- del domiciliario, que tendría que adivinar que no debe llevarlas.
        AND canal = 'ecommerce'
        AND COALESCE(medio_pago, '') <> 'entrega_en_tienda'
        ${filtroMio}
      ORDER BY creado_en ASC`,
  )
    .bind(...(esSoloDomiciliario ? [user.sub] : []))
    .all<{ id: string }>();

  if (orders.length === 0) {
    return json({ entregas: [] });
  }

  const ids = orders.map((order) => order.id);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');

  const { results: items } = await env.DB.prepare(
    `SELECT order_id AS orderId, producto_nombre AS productoNombre,
            precio_unitario AS precioUnitario, cantidad
       FROM order_items
      WHERE order_id IN (${placeholders})`,
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
    entregas: orders.map((order) => ({
      ...order,
      items: byOrder.get(order.id) ?? [],
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
      `SELECT id, referencia, contact_id AS contactId,
              cliente_nombre AS clienteNombre, cliente_telefono AS clienteTelefono,
              cliente_direccion AS clienteDireccion, estado, stock_reservado AS stockReservado,
              subtotal, envio, total, comprobante_nombre AS comprobanteNombre,
              (comprobante_url IS NOT NULL) AS tieneComprobante,
              aprobado_en AS aprobadoEn,
              ${METODO_PAGO_SQL}, canal, medio_pago AS medioPago,
              efectivo_liquidado AS efectivoLiquidado, vence_en AS venceEn,
              closing_id AS closingId, creado_en AS creadoEn,
              domiciliario_id AS domiciliarioId, domiciliario_nombre AS domiciliarioNombre
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

  // También en la respuesta de crear un pedido: es lo que ve el cliente en la
  // pantalla de éxito justo tras confirmar la compra.
  const contenidos = await contenidoDePedidos(env, [orderId]);
  const items = (itemsResult.results as { productId: string }[]).map((item) => {
    const contenido = contenidos.get(`${orderId}:${item.productId}`);
    return contenido ? { ...item, contiene: contenido } : item;
  });

  return { ...order, items };
}

/**
 * Traduce la violación del CHECK de stock a un 400 comprensible. Sin esto, una
 * carrera perdida le llegaría al cliente como un 500 opaco.
 */
// `translateConstraint` se mudó a `../db-errors`: el punto de venta arma los
// mismos batches y choca con los mismos CHECK, así que la traducción tenía que
// dejar de vivir dentro de este fichero.
