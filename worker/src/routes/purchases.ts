import { ApiError, json, optionalString, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Compras a las fincas.
 *
 * Es la primera entrada de inventario de verdad del proyecto: hasta ahora el
 * stock solo bajaba al aprobar pedidos y subía al cancelarlos, y reponer era
 * teclear un número nuevo en el campo `stock` del producto. Aquí queda
 * registrado qué se compró, a quién, a qué costo y si ya se le pagó.
 *
 * ── Dónde encaja en las cuentas ──
 *
 * La compra **no** se resta de `ganancia`. Al registrarla se actualiza
 * `products.precio_costo`; ese costo se congela en `order_items.costo_unitario`
 * al vender (ver create() en orders.ts) y de ahí sale el `costo_producto` que
 * el cierre ya resta. Restar además el pago a la finca contaría lo mismo dos
 * veces y convertiría la mercancía en bodega en pérdida contable.
 *
 * ── Los dos momentos ──
 *
 * Registrar la compra sube el stock: la fruta ya está en la bodega y se puede
 * vender, se le haya girado al agricultor o no. Confirmar el pago solo cambia
 * `estado` y deja la fecha — es la respuesta a "¿a quién le debo todavía?".
 */

/** Lo que el cliente manda por línea. Se valida entero antes de tocar nada. */
interface ItemEntrada {
  productId: string;
  cantidad: number;
  costoUnitario: number;
}

/**
 * Resuelve a qué proveedor es la compra.
 *
 * Se manda `contactId` y el servidor saca el nombre de la agenda: así una
 * compra no puede quedar a nombre de un proveedor que no existe. El nombre se
 * **copia** a `origen` en vez de leerse siempre por JOIN, para que corregir la
 * ficha mañana no reescriba lo que se compró ayer.
 *
 * Se sigue aceptando `origen` suelto sin `contactId` por las compras que ya
 * existían antes de la agenda (migración 0022), y para no bloquear el registro
 * si alguien todavía no ha creado la ficha del proveedor.
 */
async function resolverProveedor(
  env: Env,
  body: { contactId?: unknown; origen?: unknown },
): Promise<{ contactId: string | null; origen: string }> {
  if (body.contactId !== undefined && body.contactId !== null && body.contactId !== '') {
    const contactId = requireString(body.contactId, 'contactId', 64);

    const proveedor = await env.DB.prepare(
      `SELECT id, nombre, es_proveedor AS esProveedor, activo FROM contacts WHERE id = ?1`,
    )
      .bind(contactId)
      .first<{ id: string; nombre: string; esProveedor: number; activo: number }>();

    if (!proveedor) {
      throw ApiError.badRequest('proveedor-inexistente', 'Ese proveedor no está en la agenda.');
    }
    if (!proveedor.esProveedor) {
      throw ApiError.badRequest(
        'no-es-proveedor',
        `"${proveedor.nombre}" está en la agenda como cliente. Márcalo también como proveedor para poder comprarle.`,
      );
    }

    return { contactId: proveedor.id, origen: proveedor.nombre };
  }

  // Sin ficha: se guarda el texto tal cual y la compra queda sin enlazar.
  return { contactId: null, origen: requireString(body.origen, 'origen', 160) };
}

/** Fila de producto con lo necesario para decidir si puede recibir stock. */
interface ProductoDestino {
  id: string;
  nombre: string;
  origen: string;
  stock_actual: number;
  /** >0 si es una canasta: su stock se deriva de los componentes. */
  es_canasta: number;
  /** >0 si es madre de variantes: el inventario vive en las hijas. */
  es_madre: number;
}

/**
 * Valida el detalle que llega del navegador.
 *
 * Los subtotales y el total se **recalculan** aquí en vez de creerle al
 * cliente: son la base de lo que se le va a girar a un agricultor, y el
 * navegador es un sitio donde cualquiera puede cambiar un número. Si lo que
 * mandó no cuadra con lo calculado, se rechaza en vez de corregirlo en
 * silencio — un descuadre así significa que alguien vio en pantalla una cifra
 * distinta de la que se iba a guardar, y eso hay que mirarlo.
 */
function leerItems(raw: unknown): { items: readonly ItemEntrada[]; total: number } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.badRequest('sin-items', 'La compra tiene que llevar al menos un producto.');
  }

  const items: ItemEntrada[] = [];
  const vistos = new Set<string>();
  let total = 0;

  for (const [i, crudo] of raw.entries()) {
    const fila = (crudo ?? {}) as Record<string, unknown>;
    const productId = requireString(fila['productId'], `items[${i}].productId`, 64);

    // Dos líneas del mismo producto harían dos UPDATE de stock sobre la misma
    // fila dentro del batch: el resultado sería correcto, pero la compra
    // mostraría el producto repetido y editarla después sería ambiguo.
    if (vistos.has(productId)) {
      throw ApiError.badRequest(
        'producto-repetido',
        'Un mismo producto no puede aparecer dos veces. Suma las cantidades en una sola línea.',
      );
    }
    vistos.add(productId);

    const cantidad = requireInt(fila['cantidad'], `items[${i}].cantidad`, 1);
    const costoUnitario = requireInt(fila['costoUnitario'], `items[${i}].costoUnitario`, 0);

    items.push({ productId, cantidad, costoUnitario });
    total += cantidad * costoUnitario;
  }

  return { items, total };
}

/**
 * Trae los productos del detalle y comprueba que todos puedan recibir stock.
 *
 * Una canasta y una madre de variantes tienen `stock_actual = 0` **por
 * definición**: su disponibilidad se calcula desde sus componentes o sus
 * hijas (ver combos.ts). Sumarles unidades ahí no las haría vendibles —el
 * número quedaría escondido en una columna que nadie lee— así que se rechaza
 * con un mensaje que dice qué comprar en su lugar.
 */
async function cargarDestinos(
  env: Env,
  items: readonly ItemEntrada[],
): Promise<Map<string, ProductoDestino>> {
  const ids = items.map((i) => i.productId);
  const marcadores = ids.map((_, i) => `?${i + 1}`).join(', ');

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.nombre, p.origen, p.stock_actual,
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
        `Uno de los productos de la compra ya no está en el catálogo.`,
      );
    }
    if (producto.es_canasta > 0) {
      throw ApiError.badRequest(
        'canasta-sin-stock',
        `"${producto.nombre}" es una canasta: su disponibilidad sale de lo que lleva dentro. Registra la compra de esos productos.`,
      );
    }
    if (producto.es_madre > 0) {
      throw ApiError.badRequest(
        'madre-sin-stock',
        `"${producto.nombre}" agrupa variantes y no tiene inventario propio. Registra la compra sobre la presentación concreta.`,
      );
    }
  }

  return porId;
}

/**
 * SELECT compartido.
 *
 * `origen` sale de la compra —el nombre copiado ese día— y no de la ficha del
 * proveedor: si mañana se corrige el nombre en la agenda, esta compra debe
 * seguir diciendo a quién se le compró entonces. La ficha viaja aparte, para
 * poder enlazar a ella y mostrar sus datos bancarios al ir a girar.
 */
const SELECT_COMPRA = `
  SELECT c.id, c.contact_id AS contactId, c.origen,
         c.total_pago AS totalPago, c.estado, c.notas,
         c.monto_pagado AS montoPagado,
         -- El saldo se calcula aquí y no en la pantalla: es la cifra sobre la
         -- que se decide cuánto abonar, y dos sitios calculándola es un sitio
         -- de más donde puede quedar desfasada.
         (c.total_pago - c.monto_pagado) AS saldo,
         c.creado_en AS creadoEn, c.pagado_en AS pagadoEn,
         autor.nombre AS creadoPor, pagador.nombre AS pagadoPor,
         prov.nombre        AS proveedorNombre,
         prov.telefono      AS proveedorTelefono,
         prov.banco         AS proveedorBanco,
         prov.tipo_cuenta   AS proveedorTipoCuenta,
         prov.numero_cuenta AS proveedorNumeroCuenta,
         prov.titular       AS proveedorTitular
    FROM provider_purchases c
    LEFT JOIN users    autor   ON autor.id   = c.creado_por
    LEFT JOIN users    pagador ON pagador.id = c.pagado_por
    LEFT JOIN contacts prov    ON prov.id    = c.contact_id`;

/** Carga las líneas de varias compras de una vez, para no hacer N+1. */
async function cargarItems(
  env: Env,
  compraIds: readonly string[],
): Promise<Map<string, unknown[]>> {
  if (compraIds.length === 0) {
    return new Map();
  }

  const marcadores = compraIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT i.purchase_id AS purchaseId, i.product_id AS productId,
            i.cantidad, i.costo_unitario AS costoUnitario, i.subtotal,
            p.nombre AS productoNombre, p.unidad
       FROM provider_purchase_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.purchase_id IN (${marcadores})
      ORDER BY i.id`,
  )
    .bind(...compraIds)
    .all<{ purchaseId: string }>();

  const porCompra = new Map<string, unknown[]>();
  for (const fila of results) {
    const lista = porCompra.get(fila.purchaseId) ?? [];
    lista.push(fila);
    porCompra.set(fila.purchaseId, lista);
  }
  return porCompra;
}

/**
 * GET /api/admin/providers/purchases — historial de compras.
 *
 * Filtros opcionales `origen` y `estado`. Las líneas vienen dentro de cada
 * compra: la pantalla las despliega sin una segunda petición, y son pocas.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const contactId = url.searchParams.get('contact_id');
  const origen = url.searchParams.get('origen');
  const estado = url.searchParams.get('estado');

  const filtros: string[] = [];
  const bindings: unknown[] = [];

  // Por ficha cuando se tiene (la vista del proveedor en la agenda) y por
  // texto para las compras viejas que nunca se enlazaron.
  if (contactId) {
    bindings.push(contactId);
    filtros.push(`c.contact_id = ?${bindings.length}`);
  }
  if (origen) {
    bindings.push(origen);
    filtros.push(`c.origen = ?${bindings.length}`);
  }
  if (estado === 'pendiente' || estado === 'pagado') {
    bindings.push(estado);
    filtros.push(`c.estado = ?${bindings.length}`);
  }

  const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `${SELECT_COMPRA} ${where} ORDER BY c.creado_en DESC LIMIT 200`,
  )
    .bind(...bindings)
    .all<{ id: string }>();

  const items = await cargarItems(env, results.map((c) => c.id));

  return json({
    compras: results.map((compra) => ({ ...compra, items: items.get(compra.id) ?? [] })),
  });
}

/**
 * POST /api/admin/providers/purchases — registra una compra.
 *
 * Un solo batch hace las cuatro cosas que tienen que pasar juntas: la
 * cabecera, su detalle, la subida de inventario y la actualización del costo
 * del catálogo. Si una falla, D1 revierte todo — media compra registrada
 * dejaría stock que nadie compró o una deuda sin mercancía detrás.
 */
export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const body = await readJson<{
    contactId?: unknown;
    origen?: unknown;
    notas?: unknown;
    items?: unknown;
  }>(request);

  const { contactId, origen } = await resolverProveedor(env, body);
  const notas = body.notas === undefined || body.notas === null || body.notas === ''
    ? null
    : requireString(body.notas, 'notas', 500);

  const { items, total } = leerItems(body.items);
  await cargarDestinos(env, items);

  const purchaseId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO provider_purchases (id, contact_id, origen, total_pago, notas, creado_por)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(purchaseId, contactId, origen, total, notas, user.sub),

    ...items.flatMap((item) => [
      env.DB.prepare(
        `INSERT INTO provider_purchase_items
           (purchase_id, product_id, cantidad, costo_unitario, subtotal)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(
        purchaseId,
        item.productId,
        item.cantidad,
        item.costoUnitario,
        item.cantidad * item.costoUnitario,
      ),

      // La mercancía entra a la bodega ya, aunque al agricultor todavía no se
      // le haya girado: lo que está en la finca se puede vender.
      //
      // `precio_costo` se actualiza al costo de esta compra porque el costo
      // vigente es el de la última entrada. De ahí lo copia cada venta nueva
      // a `order_items.costo_unitario`, que es lo que el cierre suma como
      // costo de mercancía.
      env.DB.prepare(
        `UPDATE products
            SET stock_actual   = stock_actual + ?2,
                precio_costo   = ?3,
                actualizado_en = datetime('now')
          WHERE id = ?1`,
      ).bind(item.productId, item.cantidad, item.costoUnitario),
    ]),
  ]);

  return json({ compra: await cargarUna(env, purchaseId) }, 201);
}

/**
 * PATCH /api/admin/providers/purchases/:id — corrige una compra.
 *
 * Se reemplaza el detalle entero en vez de casar línea por línea: son compras
 * de pocas líneas y el diff parcial tendría tres caminos (alta, baja, cambio)
 * donde este tiene uno. Lo que sí hay que hacer con cuidado es el inventario:
 * primero se devuelve todo lo que la compra había sumado y después se suma lo
 * nuevo, todo en el mismo batch.
 *
 * Si devolver el stock viejo dejaría el inventario en negativo —porque ya se
 * vendió— la corrección se rechaza con el detalle de cuánto queda. Ver
 * `verificarDevolucion()`.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  purchaseId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const actual = await env.DB.prepare(
    `SELECT id, estado FROM provider_purchases WHERE id = ?1`,
  )
    .bind(purchaseId)
    .first<{ id: string; estado: string }>();

  if (!actual) {
    throw ApiError.notFound('Esa compra no existe.');
  }
  if (actual.estado === 'pagado') {
    throw ApiError.conflict(
      'compra-pagada',
      'Esta compra ya está pagada. Si el pago fue por otra cantidad, registra una compra de ajuste en vez de reescribir lo que ya se giró.',
    );
  }

  const body = await readJson<{
    contactId?: unknown;
    origen?: unknown;
    notas?: unknown;
    items?: unknown;
  }>(request);

  const { contactId, origen } = await resolverProveedor(env, body);
  const notas = body.notas === undefined || body.notas === null || body.notas === ''
    ? null
    : requireString(body.notas, 'notas', 500);

  const { items, total } = leerItems(body.items);
  await cargarDestinos(env, items);

  const anteriores = await lineasDe(env, purchaseId);
  await verificarDevolucion(env, anteriores);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE provider_purchases
          SET contact_id = ?2, origen = ?3, total_pago = ?4, notas = ?5
        WHERE id = ?1`,
    ).bind(purchaseId, contactId, origen, total, notas),

    // Devolver lo viejo antes de sumar lo nuevo. El orden importa dentro del
    // batch: al revés, un producto que sube y baja podría pasar por un estado
    // intermedio que viole el CHECK de stock por el camino.
    ...anteriores.map((linea) =>
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual - ?2, actualizado_en = datetime('now')
          WHERE id = ?1`,
      ).bind(linea.productId, linea.cantidad),
    ),

    env.DB.prepare(`DELETE FROM provider_purchase_items WHERE purchase_id = ?1`).bind(purchaseId),

    ...items.flatMap((item) => [
      env.DB.prepare(
        `INSERT INTO provider_purchase_items
           (purchase_id, product_id, cantidad, costo_unitario, subtotal)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(
        purchaseId,
        item.productId,
        item.cantidad,
        item.costoUnitario,
        item.cantidad * item.costoUnitario,
      ),
      env.DB.prepare(
        `UPDATE products
            SET stock_actual   = stock_actual + ?2,
                precio_costo   = ?3,
                actualizado_en = datetime('now')
          WHERE id = ?1`,
      ).bind(item.productId, item.cantidad, item.costoUnitario),
    ]),
  ]);

  return json({ compra: await cargarUna(env, purchaseId) });
}

/**
 * DELETE /api/admin/providers/purchases/:id — borra una compra.
 *
 * Devuelve al inventario lo que había sumado. Si eso dejaría algún producto en
 * negativo, se rechaza: significa que parte de esa mercancía ya se vendió y
 * borrar la compra dejaría el inventario diciendo una mentira. El CHECK
 * `stock_actual >= 0` es la garantía última, pero el mensaje de
 * `verificarDevolucion()` explica cuál producto y cuánto queda, que es lo que
 * hace falta para decidir qué hacer.
 */
export async function remove(env: Env, user: JwtPayload, purchaseId: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const actual = await env.DB.prepare(
    `SELECT id, estado, monto_pagado AS montoPagado FROM provider_purchases WHERE id = ?1`,
  )
    .bind(purchaseId)
    .first<{ id: string; estado: string; montoPagado: number }>();

  if (!actual) {
    throw ApiError.notFound('Esa compra no existe.');
  }
  // No basta con mirar el estado desde que hay abonos (migración 0036): una
  // compra a medio girar sigue en 'pendiente' y borrarla se llevaría por
  // CASCADE los abonos ya hechos, dejando plata que salió de una cuenta sin
  // nada que la explique.
  if (actual.estado === 'pagado' || actual.montoPagado > 0) {
    throw ApiError.conflict(
      'compra-pagada',
      actual.estado === 'pagado'
        ? 'Esta compra ya está pagada y no se puede borrar: es el respaldo de un giro que sí ocurrió.'
        : 'Esta compra ya tiene abonos girados y no se puede borrar. Si la mercancía se devolvió, registra una compra de ajuste.',
    );
  }

  const lineas = await lineasDe(env, purchaseId);
  await verificarDevolucion(env, lineas);

  // El detalle se va por CASCADE; el stock hay que devolverlo a mano, y en el
  // mismo batch para que no quede compra borrada con inventario inflado.
  await env.DB.batch([
    ...lineas.map((linea) =>
      env.DB.prepare(
        `UPDATE products
            SET stock_actual = stock_actual - ?2, actualizado_en = datetime('now')
          WHERE id = ?1`,
      ).bind(linea.productId, linea.cantidad),
    ),
    env.DB.prepare(`DELETE FROM provider_purchases WHERE id = ?1`).bind(purchaseId),
  ]);

  return json({ ok: true });
}

/**
 * POST /api/admin/providers/purchases/:id/pagar — se le giró al agricultor.
 *
 * Solo cambia el estado y deja la fecha: la mercancía entró al registrar, no
 * aquí. La guardia va dentro del UPDATE, como en el resto del proyecto, para
 * que dos clics simultáneos no registren dos pagos.
 */
export async function markPaid(
  request: Request,
  env: Env,
  user: JwtPayload,
  purchaseId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<{ monto?: unknown; metodo?: unknown; nota?: unknown }>(
    request,
  ).catch(() => ({}) as { monto?: unknown; metodo?: unknown; nota?: unknown });

  const compra = await env.DB.prepare(
    `SELECT id, origen, total_pago AS totalPago, monto_pagado AS montoPagado, estado
       FROM provider_purchases WHERE id = ?1`,
  )
    .bind(purchaseId)
    .first<{
      id: string;
      origen: string;
      totalPago: number;
      montoPagado: number;
      estado: string;
    }>();

  if (!compra) {
    throw ApiError.notFound('Esa compra no existe.');
  }

  const saldo = compra.totalPago - compra.montoPagado;
  if (compra.estado === 'pagado' || saldo <= 0) {
    throw ApiError.conflict('ya-pagada', 'Esta compra ya está girada por completo.');
  }

  // Sin monto se gira todo lo que falta: es lo que hacía el botón «Pagar» de
  // Compras antes de que hubiera abonos, y hay que seguir sirviéndolo.
  const monto = body.monto === undefined || body.monto === null
    ? saldo
    : requireInt(body.monto, 'monto', 1);

  if (monto > saldo) {
    throw ApiError.badRequest(
      'abono-mayor-al-saldo',
      `A ${compra.origen} solo le faltan ${saldo} por girar; no se puede abonar ${monto}.`,
    );
  }

  const metodo = leerMetodoGiro(body.metodo);
  const nota = optionalString(body.nota, 'nota', 200);

  // De qué cuenta sale, deducido del método igual que en los cobros: en
  // efectivo sale del cajón, por transferencia del banco. No se pide aparte
  // porque preguntar dos veces lo mismo es la manera de que un día no
  // coincidan.
  const cuentaId = metodo === 'efectivo' ? 'caja-efectivo' : 'cuenta-bancaria';

  const abonoId = `ppay-${crypto.randomUUID()}`;

  // El orden importa: primero el HECHO (la fila del abono), después la caché.
  //
  // El INSERT lleva su propia guardia dentro del SELECT, así que dos clics a
  // la vez no pueden girar de más: el segundo no inserta nada. Y el UPDATE no
  // suma, RECALCULA desde la tabla de abonos — así la caché no puede quedar
  // diciendo algo distinto de lo que suman las filas.
  const [insertado] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO provider_payments (id, purchase_id, monto, metodo, cuenta_id, nota, pagado_por)
       SELECT ?1, c.id, ?3, ?4, ?5, ?6, ?7
         FROM provider_purchases c
        WHERE c.id = ?2
          AND c.estado = 'pendiente'
          AND c.monto_pagado + ?3 <= c.total_pago`,
    ).bind(abonoId, purchaseId, monto, metodo, cuentaId, nota, user.sub),

    env.DB.prepare(
      `UPDATE provider_purchases
          SET monto_pagado = (SELECT COALESCE(SUM(monto), 0)
                                FROM provider_payments WHERE purchase_id = ?1),
              estado = CASE
                WHEN (SELECT COALESCE(SUM(monto), 0)
                        FROM provider_payments WHERE purchase_id = ?1) >= total_pago
                THEN 'pagado' ELSE 'pendiente' END,
              -- Sin acentos graves en este comentario: va DENTRO de una
              -- plantilla de JS y un acento grave la cortaría en seco.
              -- pagado_en marca el giro COMPLETO, no cada abono: la fecha de
              -- cada abono vive en su propia fila.
              pagado_por = CASE
                WHEN (SELECT COALESCE(SUM(monto), 0)
                        FROM provider_payments WHERE purchase_id = ?1) >= total_pago
                THEN ?2 ELSE pagado_por END,
              pagado_en = CASE
                WHEN (SELECT COALESCE(SUM(monto), 0)
                        FROM provider_payments WHERE purchase_id = ?1) >= total_pago
                THEN datetime('now') ELSE pagado_en END,
              cuenta_id = COALESCE(cuenta_id, ?3)
        WHERE id = ?1`,
    ).bind(purchaseId, user.sub, cuentaId),
  ]);

  if (insertado.meta.changes === 0) {
    throw ApiError.conflict(
      'abono-rechazado',
      'Ese abono ya no cabe en la compra. Vuelve a abrirla para ver cuánto falta.',
    );
  }

  return json({ compra: await cargarUna(env, purchaseId) });
}

/**
 * Por dónde salió el giro.
 *
 * Solo dos, y a propósito: lo que de verdad tiene que saber el sistema es de
 * qué cuenta salió la plata, y para eso «efectivo» y «transferencia» bastan.
 * Nequi o Daviplata caen en transferencia porque van al mismo bolsillo.
 */
function leerMetodoGiro(valor: unknown): 'efectivo' | 'transferencia' {
  return valor === 'efectivo' ? 'efectivo' : 'transferencia';
}

/** Las líneas de una compra, con lo justo para devolver inventario. */
async function lineasDe(
  env: Env,
  purchaseId: string,
): Promise<readonly { productId: string; cantidad: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT product_id AS productId, cantidad
       FROM provider_purchase_items WHERE purchase_id = ?1`,
  )
    .bind(purchaseId)
    .all<{ productId: string; cantidad: number }>();

  return results;
}

/**
 * ¿Alcanza el inventario para deshacer esta compra?
 *
 * Se comprueba antes del batch para poder decir **qué** producto falta y
 * cuánto queda. Sin esto, el CHECK de la base rechazaría igual —así que no hay
 * riesgo de corromper nada— pero el mensaje sería un 500 opaco justo cuando
 * alguien intenta corregir un error de tecleo.
 *
 * Entre esta consulta y el batch cabe una venta, y entonces el CHECK actúa y
 * D1 revierte: la carrera termina en un error feo pero nunca en un inventario
 * negativo.
 */
async function verificarDevolucion(
  env: Env,
  lineas: readonly { productId: string; cantidad: number }[],
): Promise<void> {
  if (lineas.length === 0) {
    return;
  }

  const ids = lineas.map((l) => l.productId);
  const marcadores = ids.map((_, i) => `?${i + 1}`).join(', ');

  const { results } = await env.DB.prepare(
    `SELECT id, nombre, stock_actual FROM products WHERE id IN (${marcadores})`,
  )
    .bind(...ids)
    .all<{ id: string; nombre: string; stock_actual: number }>();

  const porId = new Map(results.map((p) => [p.id, p]));

  for (const linea of lineas) {
    const producto = porId.get(linea.productId);
    if (!producto) {
      continue;
    }
    if (producto.stock_actual < linea.cantidad) {
      throw ApiError.conflict(
        'stock-ya-vendido',
        `No se puede deshacer: de las ${linea.cantidad} unidades de "${producto.nombre}" que entraron ` +
          `con esta compra solo quedan ${producto.stock_actual} en inventario. El resto ya se vendió.`,
        {
          productId: producto.id,
          producto: producto.nombre,
          compradas: linea.cantidad,
          disponibles: producto.stock_actual,
        },
      );
    }
  }
}

/** Una compra con su detalle, para devolverla tras crear o modificar. */
async function cargarUna(env: Env, purchaseId: string): Promise<unknown> {
  const compra = await env.DB.prepare(`${SELECT_COMPRA} WHERE c.id = ?1`)
    .bind(purchaseId)
    .first<{ id: string }>();

  if (!compra) {
    throw ApiError.notFound('Esa compra no existe.');
  }

  const items = await cargarItems(env, [purchaseId]);
  return { ...compra, items: items.get(purchaseId) ?? [] };
}
