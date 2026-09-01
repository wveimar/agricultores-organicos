import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { discountedPrice, loadDiscounts } from '../pricing';
import { rolesDeContacto } from './contacts';
import { translateConstraint } from '../db-errors';
import {
  aggregate,
  loadProducts,
  rejectParents,
  type IncomingItem,
  type StockRow,
} from './orders';
import { expandir, recetasActuales, recetasDelPedido, sentenciasDeInstantanea } from '../combos';
import { emitirLineasStatement, emitirStatement, notaStatements } from './invoices';
import { cobrarPedidoStatements } from './payments';

/**
 * Punto de venta — la caja física de la tienda.
 *
 * ── Por qué esto no es "crear pedido y luego aprobarlo" ──
 *
 * En la web hay un desfase real entre las dos cosas: el cliente compra, el
 * pedido queda en 'verificacion' con el stock reservado, y más tarde una
 * persona lo revisa y lo aprueba. Ese desfase es el que justifica que
 * `orders.create()` y `orders.approve()` sean dos pasos con un token de
 * idempotencia entre medias.
 *
 * En el mostrador no existe: el cajero ve salir el producto y entrar el dinero
 * en el mismo instante, con alguien esperando en la fila. Encadenar las dos
 * peticiones aquí no aportaría ninguna garantía y sí abriría una ventana en la
 * que la venta está a medias. Por eso `sell()` escribe el pedido YA aprobado y
 * emite la factura y el cobro en el mismo `batch()`: o la venta entera queda
 * registrada, o no queda nada.
 *
 * Se reutilizan tal cual los constructores de sentencias que ya existían
 * —`emitirStatement`, `emitirLineasStatement`, `cobrarPedidoStatements`,
 * `expandir`, `sentenciasDeInstantanea`— porque una venta de caja y una venta
 * web son el mismo hecho contable con distinta puerta de entrada. Duplicarlos
 * habría significado dos definiciones de "qué es facturar".
 *
 * ── Cómo se guarda una venta de caja ──
 *
 *   metodo_pago = 'contraentrega'   (se paga al recibir: es literal aquí)
 *   medio_pago  = 'efectivo' | 'tarjeta'
 *   canal       = 'pos'
 *   estado      = 'pago', efectivo_liquidado = 1
 *
 * `metodo_pago` no lleva un valor propio porque su CHECK no se puede ampliar:
 * recrear `orders` es imposible en una base D1 que ya tiene pedidos (las cuatro
 * vías probadas están documentadas en la migración 0032). El efecto secundario
 * es bueno: RECAUDADO_WHERE ya cuenta 'contraentrega' + 'pago' + liquidado, así
 * que la venta de caja entra sola en el cierre sin tocar esa constante.
 */

interface PosItemBody extends IncomingItem {
  /** Precio que el cajero fijó a mano. Si difiere del calculado, exige motivo. */
  precioManual?: unknown;
  motivoAjuste?: unknown;
}

interface SellBody {
  contactId?: unknown;
  clienteNombre?: unknown;
  clienteTelefono?: unknown;
  items?: unknown;
  metodoPago?: unknown;
  reciboSolicitado?: unknown;
}

type MetodoPos = 'efectivo' | 'tarjeta' | 'credito';

function readMetodoPos(value: unknown): MetodoPos {
  if (value === 'tarjeta') return 'tarjeta';
  if (value === 'credito') return 'credito';
  return 'efectivo';
}

/** Una línea ya resuelta: qué se vende, a cuánto, y por qué a ese precio. */
interface LineaVenta {
  productId: string;
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  costoUnitario: number;
  motivoAjuste: string | null;
}

/**
 * Resuelve el precio de cada línea y valida los ajustes manuales.
 *
 * El precio automático se calcula igual que en la tienda: precio de lista con
 * el descuento del rol de mayorista que le corresponda a la ficha del cliente.
 * Que el cliente no tenga sesión abierta no le quita su trato — por eso los
 * roles salen de `rolesDeContacto()` y no del token del cajero, que es de otra
 * persona.
 *
 * Sobre el ajuste manual: el negocio decidió que NO hay tope. Un cajero puede
 * dejar una línea en el precio que quiera. El control no es un límite en el
 * código sino la trazabilidad: si el precio no es el calculado, `motivoAjuste`
 * es obligatorio y queda escrito en la línea, junto a la fila 'editado' del log
 * que dice quién fue.
 */
function resolverLineas(
  items: readonly PosItemBody[],
  required: Map<string, number>,
  products: Map<string, StockRow>,
  descuentos: Map<string, number>,
): LineaVenta[] {
  // Los ajustes llegan por línea del cuerpo, pero las cantidades ya vienen
  // agregadas por producto: si alguien mandó el mismo producto dos veces, el
  // último motivo que dio es el que vale.
  const ajustes = new Map<string, { precio: number; motivo: string | null }>();

  items.forEach((item, i) => {
    if (item.precioManual === undefined || item.precioManual === null || item.precioManual === '') {
      return;
    }
    const productId = requireString(item.productId, `items[${i}].productId`, 64);
    ajustes.set(productId, {
      precio: requireInt(item.precioManual, `items[${i}].precioManual`, 0),
      motivo:
        item.motivoAjuste === undefined || item.motivoAjuste === null || item.motivoAjuste === ''
          ? null
          : requireString(item.motivoAjuste, `items[${i}].motivoAjuste`, 200),
    });
  });

  const lineas: LineaVenta[] = [];

  for (const [productId, cantidad] of required) {
    const product = products.get(productId)!;
    const automatico = discountedPrice(product.precio, descuentos.get(productId) ?? 0);
    const ajuste = ajustes.get(productId);

    if (ajuste && ajuste.precio !== automatico) {
      if (!ajuste.motivo) {
        throw ApiError.badRequest(
          'motivo-requerido',
          `Cambiaste el precio de "${product.nombre}" de ${automatico} a ${ajuste.precio}. ` +
            `Escribe por qué: un descuento sin motivo no se puede auditar después.`,
        );
      }
      lineas.push({
        productId,
        nombre: product.nombre,
        cantidad,
        precioUnitario: ajuste.precio,
        costoUnitario: product.precio_costo,
        motivoAjuste: ajuste.motivo,
      });
      continue;
    }

    lineas.push({
      productId,
      nombre: product.nombre,
      cantidad,
      precioUnitario: automatico,
      costoUnitario: product.precio_costo,
      motivoAjuste: null,
    });
  }

  return lineas;
}

/**
 * Comprueba que a esta ficha se le puede fiar este importe.
 *
 * Misma definición de deuda viva que usa `orders.grantCredit()`: fiado,
 * aprobado o enviado, todavía sin 'pago'.
 *
 * ⚠ A diferencia de `grantCredit()`, esta comprobación NO es atómica. Allí se
 * actualiza una fila que ya existe, así que la suma cabe dentro del propio
 * WHERE del UPDATE y dos peticiones simultáneas no pueden pasar las dos. Aquí
 * la fila todavía no existe, así que se comprueba antes de construir el batch
 * y queda una ventana teórica: dos ventas a crédito al mismo cliente, en el
 * mismo instante, desde dos cajas distintas, podrían pasar ambas. Con un solo
 * mostrador atendiendo una fila, ese escenario no se da; cerrarlo del todo
 * exigiría dejar el pedido a medias cuando pierde la carrera, que es peor.
 */
async function exigirCupo(env: Env, contactId: string, total: number): Promise<void> {
  const fila = await env.DB.prepare(
    `SELECT c.nombre,
            COALESCE(c.cupo_credito, 0) AS cupo,
            COALESCE(c.dias_credito, 0) AS dias,
            COALESCE((
              SELECT SUM(d.total) FROM orders d
               WHERE d.contact_id = c.id
                 AND d.metodo_pago = 'credito'
                 AND d.estado IN ('aprobado', 'enviado')
            ), 0) AS deuda
       FROM contacts c WHERE c.id = ?1`,
  )
    .bind(contactId)
    .first<{ nombre: string; cupo: number; dias: number; deuda: number }>();

  if (!fila) {
    throw ApiError.badRequest('sin-ficha', 'Esa ficha de cliente no existe.');
  }
  if (fila.cupo <= 0) {
    throw ApiError.conflict(
      'sin-cupo',
      `A ${fila.nombre} no se le fía: no tiene cupo abierto. Ábrele uno en Contactos si corresponde.`,
    );
  }
  if (fila.deuda + total > fila.cupo) {
    throw ApiError.conflict(
      'cupo-excedido',
      `${fila.nombre} debe ${fila.deuda} y su cupo es ${fila.cupo}: esta venta de ${total} lo pasaría. ` +
        `Cóbrale parte de lo anterior o súbele el cupo.`,
    );
  }
}

/**
 * POST /api/admin/pos/sell — una venta de mostrador, completa, en un batch.
 *
 * Rol `GESTOR_PEDIDOS`: quien atiende la caja es quien ya gestiona pedidos,
 * cobra y fía. No se creó un rol `CAJERO` aparte porque el POS no hace nada que
 * ese rol no pudiera hacer ya por otros caminos.
 */
export async function sell(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<SellBody>(request);
  const metodo = readMetodoPos(body.metodoPago);
  const reciboSolicitado = body.reciboSolicitado === true || body.reciboSolicitado === 1 ? 1 : 0;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw ApiError.badRequest('venta-vacia', 'La venta necesita al menos un producto.');
  }
  if (body.items.length > 200) {
    throw ApiError.badRequest('demasiadas-lineas', 'Una venta admite como mucho 200 líneas.');
  }

  const items = body.items as PosItemBody[];
  const required = aggregate(items);
  const products = await loadProducts(env, [...required.keys()]);
  rejectParents(required.keys(), products);

  // Mismo corte que la tienda: lo que no está en el catálogo activo no se
  // vende, y lo que no alcanza no se despacha. El CHECK de `stock_actual >= 0`
  // es la red de seguridad si alguien se lleva las unidades entre medias.
  const faltantes: string[] = [];
  for (const [productId, cantidad] of required) {
    const product = products.get(productId);
    if (!product) {
      throw ApiError.badRequest('producto-desconocido', `El producto ${productId} no está a la venta.`);
    }
    if (product.stock_actual < cantidad) {
      faltantes.push(`${product.nombre}: quedan ${product.stock_actual}, pediste ${cantidad}`);
    }
  }
  if (faltantes.length > 0) {
    throw ApiError.badRequest('stock-insuficiente', `No hay suficiente de: ${faltantes.join('; ')}.`);
  }

  const contactId =
    body.contactId === undefined || body.contactId === null || body.contactId === ''
      ? null
      : requireString(body.contactId, 'contactId', 64);

  if (metodo === 'credito' && !contactId) {
    throw ApiError.badRequest(
      'sin-ficha',
      'Para fiar hace falta identificar al cliente: la deuda es de una persona, no de un mostrador.',
    );
  }

  // El descuento de mayorista se aplica por la ficha, no por la sesión: en el
  // mostrador el cliente no tiene sesión abierta, la del token es del cajero.
  const roles = contactId ? await rolesDeContacto(env, contactId) : [];
  const descuentos = await loadDiscounts(env, [...required.keys()], roles);
  const lineas = resolverLineas(items, required, products, descuentos);

  const subtotal = lineas.reduce((suma, l) => suma + l.precioUnitario * l.cantidad, 0);
  // Sin envío: el cliente se lleva la compra del mostrador.
  const total = subtotal;

  if (metodo === 'credito') {
    await exigirCupo(env, contactId!, total);
  }

  // Nombre del cliente: la ficha manda; si no hay ficha, lo que escribió el
  // cajero; y si tampoco, el genérico de mostrador. Se guarda copiado, igual
  // que en la web, porque el pedido es el documento de lo que pasó ese día.
  const ficha = contactId
    ? await env.DB.prepare(`SELECT nombre, telefono, direccion FROM contacts WHERE id = ?1`)
        .bind(contactId)
        .first<{ nombre: string; telefono: string | null; direccion: string | null }>()
    : null;

  const clienteNombre =
    ficha?.nombre ??
    (body.clienteNombre === undefined || body.clienteNombre === null || body.clienteNombre === ''
      ? 'Cliente de mostrador'
      : requireString(body.clienteNombre, 'clienteNombre', 160));

  const clienteTelefono =
    ficha?.telefono ??
    (body.clienteTelefono === undefined ||
    body.clienteTelefono === null ||
    body.clienteTelefono === ''
      ? ''
      : requireString(body.clienteTelefono, 'clienteTelefono', 40));

  const orderId = `ord-${crypto.randomUUID()}`;
  const invoiceId = `fac-${crypto.randomUUID()}`;
  const paymentId = `pay-${crypto.randomUUID()}`;

  // El pedido nace aprobado, así que necesita su token igual que si hubiera
  // pasado por `approve()`: `emitirStatement` condiciona la factura a él, y esa
  // condición es lo que impide facturar una aprobación que no ocurrió.
  const aprobacionToken = crypto.randomUUID();

  const esCredito = metodo === 'credito';
  const estado = esCredito ? 'aprobado' : 'pago';

  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (
         id, referencia, user_id, contact_id,
         cliente_nombre, cliente_telefono, cliente_direccion,
         estado, stock_reservado, subtotal, envio, total,
         metodo_pago, medio_pago, canal, recibo_solicitado,
         aprobado_por, aprobado_en, aprobacion_token,
         efectivo_liquidado, vence_en
       ) VALUES (
         ?1,
         'ORD-' || (SELECT COALESCE(MAX(CAST(substr(referencia, 5) AS INTEGER)), 1000) + 1 FROM orders),
         ?2, ?3, ?4, ?5, 'Retiro en tienda',
         ?6, 1, ?7, 0, ?7,
         ?8, ?9, 'pos', ?10,
         ?2, datetime('now'), ?11,
         ?12,
         ${
           esCredito
             ? `date('now', '-5 hours', '+' || (SELECT COALESCE(dias_credito, 0) FROM contacts WHERE id = ?3) || ' days')`
             : 'NULL'
         }
       )`,
    ).bind(
      orderId,
      user.sub,
      contactId,
      clienteNombre,
      clienteTelefono,
      estado,
      total,
      // Fiar es 'credito'; cobrar en el acto es 'contraentrega' con el
      // instrumento real en `medio_pago`.
      esCredito ? 'credito' : 'contraentrega',
      esCredito ? null : metodo,
      reciboSolicitado,
      aprobacionToken,
      // El efectivo de una caja está en la caja: no hay domiciliario que lo
      // traiga después, así que nace liquidado. Es lo que hace que el cierre
      // lo cuente el mismo día.
      esCredito ? 0 : 1,
    ),

    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(orderId, estado, user.sub, user.nombre),
  ];

  // Si alguna línea salió a un precio distinto del calculado, queda una fila
  // 'editado' aparte: el motivo está en la línea, y esto dice quién y cuándo.
  const ajustadas = lineas.filter((l) => l.motivoAjuste);
  if (ajustadas.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
         VALUES (?1, 'editado', ?2, ?3)`,
      ).bind(orderId, user.sub, user.nombre),
    );
  }

  for (const linea of lineas) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_items
           (order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad, motivo_ajuste)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        orderId,
        linea.productId,
        linea.nombre,
        linea.precioUnitario,
        linea.costoUnitario,
        linea.cantidad,
        linea.motivoAjuste,
      ),
    );
  }

  // La línea dice «1 Canasta»; el inventario tiene que ver la papa y el tomate.
  // `expandir` traduce lo uno en lo otro y suma los repetidos, que es la única
  // forma correcta de tocar stock cuando puede haber canastas de por medio.
  const recetas = await recetasActuales(env, [...required.keys()]);
  const movimientos = expandir(required, recetas);

  statements.push(...sentenciasDeInstantanea(env, orderId, required, recetas));

  for (const [productId, cantidad] of movimientos) {
    statements.push(
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual - ?1, actualizado_en = datetime('now')
          WHERE id = ?2`,
      ).bind(cantidad, productId),
    );
  }

  // La factura, con las mismas sentencias que usa `approve()`. Una venta de
  // mostrador es tan facturable como una web.
  statements.push(
    emitirStatement(env, invoiceId, orderId, aprobacionToken),
    emitirLineasStatement(env, invoiceId, orderId, aprobacionToken),
  );

  // Y el cobro, cuando el dinero entra en el acto. A crédito no hay cobro que
  // registrar todavía: la deuda queda viva en el saldo de la factura y la
  // recoge Cartera.
  if (!esCredito) {
    statements.push(
      ...cobrarPedidoStatements(env, paymentId, orderId, user, {
        // El CHECK de `payments.metodo` no admite 'tarjeta' y no se puede
        // ampliar; el instrumento real va en `medio_pago`.
        metodo: 'efectivo',
        liquidado: 1,
        canal: 'pos',
        medioPago: metodo,
      }),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  return json({ venta: await cargarVenta(env, orderId) }, 201);
}

/** El pedido de caja con sus líneas y su factura, que es lo que imprime el recibo. */
async function cargarVenta(env: Env, orderId: string): Promise<unknown> {
  const [pedidoRes, lineasRes, facturaRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, referencia, contact_id AS contactId, cliente_nombre AS clienteNombre,
              cliente_telefono AS clienteTelefono, estado, subtotal, envio, total,
              metodo_pago AS metodoPago, medio_pago AS medioPago, canal,
              recibo_solicitado AS reciboSolicitado, vence_en AS venceEn,
              creado_en AS creadoEn
         FROM orders WHERE id = ?1`,
    ).bind(orderId),
    env.DB.prepare(
      `SELECT product_id AS productId, producto_nombre AS productoNombre,
              precio_unitario AS precioUnitario, cantidad, motivo_ajuste AS motivoAjuste
         FROM order_items WHERE order_id = ?1`,
    ).bind(orderId),
    env.DB.prepare(
      `SELECT id, numero, total, saldo, estado, emitida_en AS emitidaEn
         FROM invoices WHERE order_id = ?1 AND estado <> 'anulada'`,
    ).bind(orderId),
  ]);

  const pedido = pedidoRes.results[0] as Record<string, unknown> | undefined;
  if (!pedido) {
    throw ApiError.notFound('Esa venta no existe.');
  }

  return { ...pedido, items: lineasRes.results, factura: facturaRes.results[0] ?? null };
}

interface DevolucionBody {
  items?: unknown;
  motivo?: unknown;
}

/**
 * POST /api/admin/pos/:orderId/devolucion — el cliente trae algo de vuelta.
 *
 * Es la única pieza de lógica genuinamente nueva del módulo: junta dinero e
 * inventario en un solo batch. Hoy ningún endpoint hace las dos cosas a la vez
 * —`invoices.crearNota()` mueve el saldo y `orders.cancel()` devuelve stock—, y
 * separarlas aquí dejaría la puerta abierta a acreditarle la plata a alguien
 * sin haber recuperado la fruta, o al revés.
 *
 * Rol `SUPER_ADMIN`, el mismo que ya exige anular una factura: devolver no es
 * una operación de rutina de caja, la autoriza quien responde por el dinero.
 *
 * Los precios salen CONGELADOS de `order_items`, no del catálogo de hoy: se
 * devuelve lo que se cobró, no lo que costaría comprarlo ahora.
 */
export async function devolucion(
  request: Request,
  env: Env,
  user: JwtPayload,
  orderId: string,
): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const body = await readJson<DevolucionBody>(request);
  const motivo = requireString(body.motivo, 'motivo', 200);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw ApiError.badRequest('devolucion-vacia', 'Marca al menos un producto que se devuelve.');
  }

  const pedido = await env.DB.prepare(
    `SELECT o.id, o.estado, o.canal,
            (SELECT i.id FROM invoices i
              WHERE i.order_id = o.id AND i.estado <> 'anulada' AND i.tipo = 'factura') AS invoiceId
       FROM orders o WHERE o.id = ?1`,
  )
    .bind(orderId)
    .first<{ id: string; estado: string; canal: string; invoiceId: string | null }>();

  if (!pedido) {
    throw ApiError.notFound('Esa venta no existe.');
  }
  if (pedido.canal !== 'pos') {
    throw ApiError.badRequest(
      'no-es-venta-de-caja',
      'Esta pantalla solo devuelve ventas de mostrador. Para una compra web, usa la nota crédito desde Facturación.',
    );
  }
  if (pedido.estado === 'cancelado') {
    throw ApiError.conflict('venta-cancelada', 'Esa venta ya está cancelada: no hay nada que devolver.');
  }
  if (!pedido.invoiceId) {
    throw ApiError.conflict(
      'sin-factura',
      'Esa venta no tiene factura viva, así que no hay a qué emitirle la nota crédito.',
    );
  }

  // Lo que se cobró por cada producto ese día, y cuánto se llevó el cliente.
  const { results: vendidas } = await env.DB.prepare(
    `SELECT product_id AS productId, producto_nombre AS productoNombre,
            precio_unitario AS precioUnitario, cantidad
       FROM order_items WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{ productId: string; productoNombre: string; precioUnitario: number; cantidad: number }>();

  const porProducto = new Map(vendidas.map((v) => [v.productId, v]));

  const devueltas = new Map<string, number>();
  (body.items as { productId?: unknown; cantidad?: unknown }[]).forEach((item, i) => {
    const productId = requireString(item.productId, `items[${i}].productId`, 64);
    const cantidad = requireInt(item.cantidad, `items[${i}].cantidad`, 1);
    devueltas.set(productId, (devueltas.get(productId) ?? 0) + cantidad);
  });

  const lineas = [];
  for (const [productId, cantidad] of devueltas) {
    const vendida = porProducto.get(productId);
    if (!vendida) {
      throw ApiError.badRequest(
        'no-estaba-en-la-venta',
        `El producto ${productId} no se vendió en este pedido, así que no se puede devolver aquí.`,
      );
    }
    if (cantidad > vendida.cantidad) {
      throw ApiError.badRequest(
        'devuelve-de-mas',
        `De "${vendida.productoNombre}" se vendieron ${vendida.cantidad} y estás devolviendo ${cantidad}.`,
      );
    }
    lineas.push({
      productId,
      descripcion: `Devolución · ${vendida.productoNombre}`,
      cantidad,
      precioUnitario: vendida.precioUnitario,
      importe: cantidad * vendida.precioUnitario,
    });
  }

  // La nota crédito, con las mismas validaciones que la de Facturación: ahí
  // vive el tope de cuánto admite todavía esta factura.
  const { id: notaId, statements } = await notaStatements(
    env,
    pedido.invoiceId,
    'nota_credito',
    motivo,
    lineas,
  );

  // Y el stock, con la receta CONGELADA del pedido: si la canasta cambió de
  // contenido desde que se vendió, hay que devolver lo que salió, no lo que
  // saldría hoy.
  const recetas = await recetasDelPedido(env, orderId);
  const movimientos = expandir(devueltas, recetas);

  for (const [productId, cantidad] of movimientos) {
    statements.push(
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual + ?1, actualizado_en = datetime('now')
          WHERE id = ?2`,
      ).bind(cantidad, productId),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO order_status_log (order_id, estado, actor_id, actor_nombre)
       VALUES (?1, 'editado', ?2, ?3)`,
    ).bind(orderId, user.sub, user.nombre),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    throw translateConstraint(error);
  }

  const nota = await env.DB.prepare(
    `SELECT id, numero, total, tipo, emitida_en AS emitidaEn FROM invoices WHERE id = ?1`,
  )
    .bind(notaId)
    .first();

  return json({
    nota,
    venta: await cargarVenta(env, orderId),
    unidadesDevueltas: [...devueltas.values()].reduce((a, b) => a + b, 0),
  });
}

/**
 * GET /api/admin/pos/ventas — el historial de la caja.
 *
 * Trae las líneas con cada venta porque las dos pantallas que lo consumen
 * —historial y devolución— las necesitan, y pedirlas una a una convertiría
 * abrir el historial en veinte peticiones.
 */
export async function ventas(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const soloHoy = url.searchParams.get('hoy') === '1';
  const limite = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  // '-5 hours' es la hora de Colombia: sin eso, "hoy" cambiaría a las 7 de la
  // tarde. Mismo criterio que usa `vence_en` al fiar.
  const filtroHoy = soloHoy ? `AND date(o.creado_en, '-5 hours') = date('now', '-5 hours')` : '';

  const { results: ventasRows } = await env.DB.prepare(
    `SELECT o.id, o.referencia, o.cliente_nombre AS clienteNombre, o.contact_id AS contactId,
            o.estado, o.subtotal, o.total, o.metodo_pago AS metodoPago,
            o.medio_pago AS medioPago, o.recibo_solicitado AS reciboSolicitado,
            o.closing_id AS closingId, o.creado_en AS creadoEn,
            (SELECT i.id     FROM invoices i WHERE i.order_id = o.id AND i.estado <> 'anulada') AS invoiceId,
            (SELECT i.numero FROM invoices i WHERE i.order_id = o.id AND i.estado <> 'anulada') AS invoiceNumero
       FROM orders o
      WHERE o.canal = 'pos' ${filtroHoy}
      ORDER BY o.creado_en DESC
      LIMIT ?1`,
  )
    .bind(limite)
    .all<{ id: string; total: number }>();

  if (ventasRows.length === 0) {
    return json({ ventas: [], resumen: { cantidad: 0, total: 0 } });
  }

  const ids = ventasRows.map((v) => v.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');

  const { results: items } = await env.DB.prepare(
    `SELECT order_id AS orderId, product_id AS productId, producto_nombre AS productoNombre,
            precio_unitario AS precioUnitario, cantidad, motivo_ajuste AS motivoAjuste
       FROM order_items WHERE order_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ orderId: string }>();

  const porPedido = new Map<string, unknown[]>();
  for (const item of items) {
    const lista = porPedido.get(item.orderId) ?? [];
    lista.push(item);
    porPedido.set(item.orderId, lista);
  }

  const conItems = ventasRows.map((venta) => ({
    ...venta,
    items: porPedido.get(venta.id) ?? [],
  }));

  return json({
    ventas: conItems,
    resumen: {
      cantidad: conItems.length,
      total: conItems.reduce((suma, v) => suma + (v.total ?? 0), 0),
    },
  });
}
