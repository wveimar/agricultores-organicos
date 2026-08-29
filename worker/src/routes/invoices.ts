import { ApiError, json, optionalString, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { recalcularStatement } from './payments';

/**
 * Facturación — el documento contable de cada venta.
 *
 * La factura no se crea desde aquí: nace sola cuando se aprueba un pedido, en
 * el mismo `batch()` que descuenta el inventario (ver `orders.approve`). Que
 * exista un endpoint para emitirla a mano sería una puerta para facturar dos
 * veces el mismo despacho.
 *
 * Lo que sí se hace aquí es consultarla y anularla. **No hay endpoint de
 * edición, y es a propósito**: una factura emitida es un hecho. Corregirla es
 * anularla y emitir otra, que es lo que deja rastro de que hubo una corrección.
 *
 * Quién puede verla: `GESTOR_PEDIDOS`, que es quien cobra. Anularla exige
 * `SUPER_ADMIN`: deshacer un documento contable no es una operación de rutina.
 */

const COLUMNS = `id,
                 consecutivo,
                 numero,
                 order_id         AS orderId,
                 contact_id       AS contactId,
                 cliente_nombre   AS clienteNombre,
                 cliente_telefono AS clienteTelefono,
                 subtotal,
                 envio,
                 total,
                 saldo,
                 estado,
                 emitida_en       AS emitidaEn,
                 vence_en         AS venceEn,
                 anulada_en       AS anuladaEn,
                 motivo_anulacion AS motivoAnulacion,
                 tipo,
                 invoice_origen_id AS invoiceOrigenId`;

/**
 * Sentencia que emite la factura de un pedido recién aprobado.
 *
 * Vive aquí y no en `orders.ts` para que la forma de la tabla se toque en un
 * solo archivo, pero se ejecuta DENTRO del batch de `approve()`: emitir la
 * factura en una petición aparte dejaría la ventana en la que el pedido está
 * aprobado y la venta no está facturada.
 *
 * Es un `INSERT ... SELECT ... WHERE`, no un INSERT normal, por el mismo motivo
 * que el apunte de `order_status_log`: `batch()` es atómico ante *errores*,
 * pero el UPDATE que aprueba el pedido no lanza error cuando pierde la carrera
 * de idempotencia — afecta 0 filas y el batch continúa. Un INSERT incondicional
 * emitiría factura de una aprobación que no ocurrió. La condición del token
 * hace que solo facture quien de verdad ganó la carrera.
 *
 * El consecutivo sale de `MAX(consecutivo) + 1` y no de `COUNT(*)`: contar
 * filas reutilizaría el número de una factura borrada. Como `consecutivo` es
 * UNIQUE, dos aprobaciones simultáneas de pedidos distintos no pueden acabar
 * con el mismo número — la segunda rompería el batch entero antes que duplicar.
 */
export function emitirStatement(
  env: Env,
  invoiceId: string,
  orderId: string,
  aprobacionToken: string,
) {
  return env.DB.prepare(
    `INSERT INTO invoices (
       id, consecutivo, numero, order_id, contact_id,
       cliente_nombre, cliente_telefono,
       subtotal, envio, total, saldo, estado, emitida_en, vence_en
     )
     SELECT ?1,
            (SELECT IFNULL(MAX(consecutivo), 0) + 1 FROM invoices),
            'FAC-' || printf('%06d', (SELECT IFNULL(MAX(consecutivo), 0) + 1 FROM invoices)),
            o.id, o.contact_id, o.cliente_nombre, o.cliente_telefono,
            o.subtotal, o.envio, o.total, o.total, 'emitida',
            datetime('now'), o.vence_en
       FROM orders o
      WHERE o.id = ?2
        AND o.aprobacion_token = ?3`,
  ).bind(invoiceId, orderId, aprobacionToken);
}

/**
 * Copia las líneas del pedido a la factura recién emitida.
 *
 * Va en el mismo batch y con la misma guarda de token que `emitirStatement`:
 * una factura sin líneas no se puede imprimir ni auditar, así que las dos
 * sentencias tienen que aplicarse juntas o ninguna.
 */
export function emitirLineasStatement(
  env: Env,
  invoiceId: string,
  orderId: string,
  aprobacionToken: string,
) {
  return env.DB.prepare(
    `INSERT INTO invoice_items (invoice_id, product_id, descripcion, cantidad, precio_unitario, importe)
     SELECT ?1, oi.product_id, oi.producto_nombre, oi.cantidad, oi.precio_unitario,
            oi.cantidad * oi.precio_unitario
       FROM order_items oi
      WHERE oi.order_id = ?2
        AND (SELECT aprobacion_token FROM orders WHERE id = ?2) = ?3`,
  ).bind(invoiceId, orderId, aprobacionToken);
}

/**
 * Anula la factura viva de un pedido que se cancela.
 *
 * (`marcarPagadaStatement` vivía aquí y era el apaño provisional de la 0027:
 * ponía la factura en 'pagada' de un plumazo porque todavía no había dónde
 * anotar el cobro. Lo reemplazó `payments.cobrarPedidoStatements`, que además
 * registra cuánto entró, por qué medio y en qué jornada.)
 */
export function anularPorPedidoStatement(env: Env, orderId: string, motivo: string) {
  return env.DB.prepare(
    `UPDATE invoices
        SET saldo = 0,
            estado = 'anulada',
            anulada_en = datetime('now'),
            motivo_anulacion = ?2
      WHERE order_id = ?1 AND estado <> 'anulada'`,
  ).bind(orderId, motivo);
}

/**
 * GET /api/admin/invoices — el listado de facturación.
 *
 * Admite `?estado=` para la pestaña de cartera y `?contactId=` para el estado
 * de cuenta de un cliente. Sin filtro devuelve las últimas, no todas: el día
 * que haya diez mil facturas nadie quiere bajárselas para ver la de ayer.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const estado = url.searchParams.get('estado');
  const contactId = url.searchParams.get('contactId');

  const where: string[] = [];
  const bindings: unknown[] = [];

  if (estado) {
    where.push(`estado = ?${bindings.push(estado)}`);
  }
  if (contactId) {
    where.push(`contact_id = ?${bindings.push(contactId)}`);
  }

  const filtro = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM invoices ${filtro} ORDER BY consecutivo DESC LIMIT 200`,
  )
    .bind(...bindings)
    .all();

  // Los totales van con la lista y no en otra petición: son lo primero que se
  // mira al abrir la pantalla, y calcularlos sobre las 200 que caben en el
  // listado daría una cifra distinta a la real en cuanto haya más.
  const resumen = await env.DB.prepare(
    `SELECT
       IFNULL(SUM(CASE WHEN estado <> 'anulada' THEN total ELSE 0 END), 0) AS facturado,
       IFNULL(SUM(saldo), 0)                                              AS porCobrar,
       COUNT(CASE WHEN saldo > 0 AND estado <> 'anulada' THEN 1 END)      AS abiertas,
       COUNT(CASE WHEN saldo > 0 AND estado <> 'anulada'
                   AND vence_en IS NOT NULL
                   AND vence_en < datetime('now') THEN 1 END)             AS vencidas
     FROM invoices`,
  ).first();

  return json({ invoices: results, resumen });
}

const ITEM_COLUMNS = `id,
                      product_id      AS productId,
                      descripcion,
                      cantidad,
                      precio_unitario AS precioUnitario,
                      importe`;

/** GET /api/admin/invoices/:id — la factura con sus líneas. */
export async function detail(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const [facturaRes, lineasRes] = await env.DB.batch([
    env.DB.prepare(`SELECT ${COLUMNS} FROM invoices WHERE id = ?1`).bind(id),
    env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM invoice_items WHERE invoice_id = ?1 ORDER BY id`).bind(id),
  ]);

  const invoice = facturaRes.results[0];
  if (!invoice) {
    throw ApiError.notFound('Esa factura no existe.');
  }

  return json({ invoice, items: lineasRes.results });
}

// ───────────────────────────── Crear, editar, borrar ─────────────────────────────

interface ItemBody {
  productId?: unknown;
  descripcion?: unknown;
  cantidad?: unknown;
  precioUnitario?: unknown;
}

interface InvoiceBody {
  contactId?: unknown;
  clienteNombre?: unknown;
  clienteTelefono?: unknown;
  envio?: unknown;
  venceEn?: unknown;
  items?: unknown;
}

interface LineaValidada {
  productId: string | null;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  importe: number;
}

/**
 * Valida las líneas y calcula el importe de cada una.
 *
 * El importe lo calcula el servidor y NO se acepta del cliente: si viniera de
 * fuera, cualquiera podría facturar 10 kilos a $5.000 y mandar un importe de
 * $50. El precio y la cantidad son datos de negocio; el producto de los dos
 * es aritmética, y la aritmética la hace quien guarda.
 */
function leerLineas(valor: unknown): LineaValidada[] {
  if (!Array.isArray(valor) || valor.length === 0) {
    throw ApiError.badRequest('factura-vacia', 'La factura necesita al menos una línea.');
  }
  if (valor.length > 100) {
    throw ApiError.badRequest('demasiadas-lineas', 'Una factura admite como mucho 100 líneas.');
  }

  return (valor as ItemBody[]).map((item, i) => {
    const cantidad = requireInt(item.cantidad, `items[${i}].cantidad`, 1);
    const precioUnitario = requireInt(item.precioUnitario, `items[${i}].precioUnitario`, 0);

    return {
      productId:
        item.productId === undefined || item.productId === null || item.productId === ''
          ? null
          : requireString(item.productId, `items[${i}].productId`, 60),
      descripcion: requireString(item.descripcion, `items[${i}].descripcion`, 160),
      cantidad,
      precioUnitario,
      importe: cantidad * precioUnitario,
    };
  });
}

/** Sentencias que reemplazan por completo las líneas de una factura. */
function sentenciasDeLineas(env: Env, invoiceId: string, lineas: LineaValidada[]) {
  return [
    env.DB.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?1`).bind(invoiceId),
    ...lineas.map((linea) =>
      env.DB.prepare(
        `INSERT INTO invoice_items (invoice_id, product_id, descripcion, cantidad, precio_unitario, importe)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(
        invoiceId,
        linea.productId,
        linea.descripcion,
        linea.cantidad,
        linea.precioUnitario,
        linea.importe,
      ),
    ),
  ];
}

/**
 * Lee la factura y decide si todavía se puede tocar.
 *
 * La regla es una sola y vale igual para editar y para borrar: **una factura
 * con dinero encima no se modifica**. Cambiarle el total dejaría un abono
 * cobrado contra una cifra que ya no existe, y borrarla dejaría el dinero en
 * la caja sin ninguna venta detrás. Lo que corresponde ahí es una nota
 * crédito con su devolución.
 *
 * Una anulada tampoco: ya es historia, y reescribirla borraría el rastro de
 * que hubo una corrección.
 */
async function exigirModificable(env: Env, user: JwtPayload, id: string) {
  const factura = await env.DB.prepare(
    `SELECT id, estado, total, saldo, tipo, order_id AS orderId FROM invoices WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      id: string;
      estado: string;
      total: number;
      saldo: number;
      tipo: string;
      orderId: string | null;
    }>();

  if (!factura) {
    throw ApiError.notFound('Ese documento no existe.');
  }

  /**
   * El administrador pasa por encima de las dos barreras.
   *
   * Es una decisión deliberada del dueño del negocio: en una finca chica, quien
   * responde por la plata a veces necesita corregir un error de tecleo sin
   * montar el papeleo de una nota. Se le abre solo a `SUPER_ADMIN` y no a
   * `GESTOR_PEDIDOS`, que es quien cobra todos los días.
   *
   * Lo que NO cambia: para el resto del equipo el camino sigue siendo la nota
   * crédito, que es lo que deja rastro de que hubo una corrección. Editar una
   * factura ya cobrada deja el abono apuntando a una cifra que ya no existe, y
   * eso sigue siendo cierto aunque lo haga el administrador — por eso la
   * respuesta avisa cuando se usó el atajo.
   */
  const esAdmin = user.roles.includes('SUPER_ADMIN');

  if (factura.estado === 'anulada' && !esAdmin) {
    throw ApiError.conflict(
      'factura-anulada',
      'Ese documento está anulado: ya es histórico y no se toca. Emite uno nuevo.',
    );
  }
  if (factura.saldo < factura.total && !esAdmin) {
    throw ApiError.conflict(
      'factura-con-pagos',
      'Esa factura ya tiene dinero recibido. Emite una nota crédito para corregirla, ' +
        'o pídele a un administrador que la edite.',
    );
  }

  return { factura, forzadoPorAdmin: esAdmin && factura.saldo < factura.total };
}

/**
 * POST /api/admin/invoices — factura a mano, sin pedido detrás.
 *
 * Es la venta de mostrador: alguien llega a la finca, se lleva mercancía y hay
 * que cobrarle. No existe un pedido y no tiene por qué existir.
 *
 * **No toca inventario a propósito.** Descontar stock es lo que hace aprobar un
 * pedido, y hacerlo también aquí descontaría dos veces cualquier venta que
 * pasara por los dos caminos. Si esta factura tiene que mover bodega, lo
 * correcto es crear el pedido y aprobarlo — ahí la factura sale sola.
 */
export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<InvoiceBody>(request);
  const clienteNombre = requireString(body.clienteNombre, 'clienteNombre', 120);
  const clienteTelefono = optionalString(body.clienteTelefono, 'clienteTelefono', 40) ?? '';
  const envio = body.envio === undefined ? 0 : requireInt(body.envio, 'envio', 0);
  const venceEn = optionalString(body.venceEn, 'venceEn', 40);
  const contactId = optionalString(body.contactId, 'contactId', 60);

  const lineas = leerLineas(body.items);
  const subtotal = lineas.reduce((suma, linea) => suma + linea.importe, 0);
  const total = subtotal + envio;

  const id = `inv-man-${crypto.randomUUID()}`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoices (
         id, consecutivo, numero, order_id, contact_id,
         cliente_nombre, cliente_telefono,
         subtotal, envio, total, saldo, estado, emitida_en, vence_en
       )
       VALUES (
         ?1,
         (SELECT IFNULL(MAX(consecutivo), 0) + 1 FROM invoices),
         'FAC-' || printf('%06d', (SELECT IFNULL(MAX(consecutivo), 0) + 1 FROM invoices)),
         NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'emitida', datetime('now'), ?8
       )`,
    ).bind(id, contactId, clienteNombre, clienteTelefono, subtotal, envio, total, venceEn),
    ...sentenciasDeLineas(env, id, lineas),
  ]);

  const created = await env.DB.prepare(`SELECT ${COLUMNS} FROM invoices WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ invoice: created }, 201);
}

/**
 * PUT /api/admin/invoices/:id
 *
 * Reemplaza las líneas enteras en vez de parchear una a una: una factura es un
 * documento completo, y editarla es reescribirla. Los totales se recalculan
 * aquí y el saldo los sigue — mientras no haya cobros, saldo y total van
 * juntos por definición.
 *
 * El consecutivo y el número NO se tocan nunca: son la identidad del
 * documento. Y el `order_id` tampoco: mover una factura de pedido dejaría al
 * pedido viejo sin documento y al nuevo con dos.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  id: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { forzadoPorAdmin } = await exigirModificable(env, user, id);

  const body = await readJson<InvoiceBody>(request);
  const clienteNombre = requireString(body.clienteNombre, 'clienteNombre', 120);
  const clienteTelefono = optionalString(body.clienteTelefono, 'clienteTelefono', 40) ?? '';
  const envio = body.envio === undefined ? 0 : requireInt(body.envio, 'envio', 0);
  const venceEn = optionalString(body.venceEn, 'venceEn', 40);

  const lineas = leerLineas(body.items);
  const subtotal = lineas.reduce((suma, linea) => suma + linea.importe, 0);
  const total = subtotal + envio;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE invoices
          SET cliente_nombre = ?2, cliente_telefono = ?3,
              subtotal = ?4, envio = ?5, total = ?6, saldo = ?6,
              vence_en = ?7
        WHERE id = ?1`,
    ).bind(id, clienteNombre, clienteTelefono, subtotal, envio, total, venceEn),
    ...sentenciasDeLineas(env, id, lineas),
  ]);

  const updated = await env.DB.prepare(`SELECT ${COLUMNS} FROM invoices WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ invoice: updated, forzadoPorAdmin });
}

interface NotaBody {
  tipo?: unknown;
  motivo?: unknown;
  items?: unknown;
}

/**
 * POST /api/admin/invoices/:id/nota — emitir una nota crédito o débito.
 *
 * Es la forma correcta de corregir algo ya cobrado, y la razón de que una
 * factura emitida no se edite: en vez de reescribir el pasado, se emite un
 * documento nuevo que dice qué cambió y por qué.
 *
 *   · crédito → resta de la factura (devolución, descuento, cobro de más)
 *   · débito  → suma (mora, reenvío, un cargo que aparece después)
 *
 * La nota vive en `invoices` con su propia serie de numeración y sus propias
 * líneas. No se cobra por sí misma: mueve el saldo de la factura de origen, y
 * ese recálculo va en el mismo `batch()` — si la nota existiera un instante sin
 * haber movido el saldo, la cartera estaría mintiendo en ese instante.
 *
 * Una nota crédito no puede pasarse de lo que la factura debe con sus otras
 * notas ya aplicadas: acreditar de más significaría que el negocio le queda
 * debiendo al cliente, y eso es una devolución de dinero, no una nota.
 */
export async function crearNota(
  request: Request,
  env: Env,
  user: JwtPayload,
  origenId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<NotaBody>(request);
  const tipo = body.tipo === 'nota_debito' ? 'nota_debito' : 'nota_credito';
  const motivo = requireString(body.motivo, 'motivo', 200);
  const lineas = leerLineas(body.items);
  const monto = lineas.reduce((suma, linea) => suma + linea.importe, 0);

  const origen = await env.DB.prepare(
    `SELECT id, tipo, estado, total, saldo, contact_id AS contactId,
            cliente_nombre AS clienteNombre, cliente_telefono AS clienteTelefono
       FROM invoices WHERE id = ?1`,
  )
    .bind(origenId)
    .first<{
      id: string;
      tipo: string;
      estado: string;
      total: number;
      saldo: number;
      contactId: string | null;
      clienteNombre: string;
      clienteTelefono: string;
    }>();

  if (!origen) {
    throw ApiError.notFound('Esa factura no existe.');
  }
  if (origen.tipo !== 'factura') {
    // Una nota sobre una nota encadenaría correcciones de correcciones y
    // nadie podría reconstruir cuánto se debe de verdad.
    throw ApiError.badRequest(
      'origen-invalido',
      'Solo se le emiten notas a una factura, no a otra nota.',
    );
  }
  if (origen.estado === 'anulada') {
    throw ApiError.conflict(
      'factura-anulada',
      'Esa factura está anulada: ya no hay deuda que corregir.',
    );
  }

  if (tipo === 'nota_credito') {
    // Cuánto se puede acreditar todavía: lo facturado más los cargos, menos lo
    // ya acreditado. NO se resta lo cobrado — se puede acreditar una factura
    // pagada entera, y eso es justamente una devolución.
    const margen = await env.DB.prepare(
      `SELECT invoices.total
              + IFNULL((SELECT SUM(n.total) FROM invoices n
                         WHERE n.invoice_origen_id = invoices.id
                           AND n.tipo = 'nota_debito' AND n.estado <> 'anulada'), 0)
              - IFNULL((SELECT SUM(n.total) FROM invoices n
                         WHERE n.invoice_origen_id = invoices.id
                           AND n.tipo = 'nota_credito' AND n.estado <> 'anulada'), 0)
              AS acreditable
         FROM invoices WHERE id = ?1`,
    )
      .bind(origenId)
      .first<{ acreditable: number }>();

    const acreditable = margen?.acreditable ?? 0;
    if (monto > acreditable) {
      throw ApiError.badRequest(
        'credito-excesivo',
        `No se pueden acreditar ${monto}: esta factura solo admite ${acreditable} más. ` +
          `Acreditar de más significaría que le quedas debiendo al cliente, y eso es una devolución.`,
      );
    }
  }

  const prefijo = tipo === 'nota_credito' ? 'NC' : 'ND';
  const id = `${tipo === 'nota_credito' ? 'nc' : 'nd'}-${crypto.randomUUID()}`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoices (
         id, consecutivo, numero, order_id, contact_id,
         cliente_nombre, cliente_telefono,
         subtotal, envio, total, saldo, estado, emitida_en,
         tipo, invoice_origen_id, motivo_anulacion
       )
       VALUES (
         ?1,
         (SELECT IFNULL(MAX(consecutivo), 0) + 1 FROM invoices),
         ?2 || '-' || printf('%06d',
           (SELECT IFNULL(MAX(CASE WHEN tipo = ?3 THEN CAST(substr(numero, 4) AS INTEGER) END), 0) + 1
              FROM invoices)),
         NULL, ?4, ?5, ?6, ?7, 0, ?7, 0, 'emitida', datetime('now'),
         ?3, ?8, ?9
       )`,
    ).bind(
      id,
      prefijo,
      tipo,
      origen.contactId,
      origen.clienteNombre,
      origen.clienteTelefono,
      monto,
      origenId,
      // El motivo se guarda en la misma columna que el de anulación: las dos
      // responden lo mismo —«por qué existe este documento»— y separarlas
      // habría sido una columna nueva para el mismo dato.
      motivo,
    ),
    ...sentenciasDeLineas(env, id, lineas),
    // Y el saldo de la factura corregida, en el mismo batch.
    recalcularStatement(env, origenId),
  ]);

  const nota = await env.DB.prepare(`SELECT ${COLUMNS} FROM invoices WHERE id = ?1`)
    .bind(id)
    .first();
  const actualizada = await env.DB.prepare(`SELECT ${COLUMNS} FROM invoices WHERE id = ?1`)
    .bind(origenId)
    .first();

  return json({ nota, invoice: actualizada }, 201);
}

/**
 * DELETE /api/admin/invoices/:id — borrado de verdad.
 *
 * Solo para lo que todavía no tiene dinero encima. Las líneas se van con ella
 * por el CASCADE de `invoice_items`.
 *
 * Deja un hueco en el consecutivo, y es aceptable: un número saltado se
 * explica, uno repetido es un fraude. El día que haya resolución DIAN esto
 * tendrá que cerrarse y dejar solo la anulación — por eso `anular()` existe y
 * es el camino recomendado para algo que ya salió al cliente.
 */
export async function remove(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  await exigirModificable(env, user, id);

  /**
   * Hay un límite que ni el administrador salta, y no lo pone este código:
   * lo pone la base.
   *
   * `payment_allocations.invoice_id` es ON DELETE RESTRICT, así que una
   * factura con plata asignada no se borra. Tiene que ser así: el cobro
   * seguiría existiendo apuntando a una factura que ya no está, y esa plata
   * dejaría de tener explicación en la contabilidad.
   *
   * Sin este try, el fallo de la FK sube en crudo y el panel recibe un 500 sin
   * explicación. Se traduce a un 409 que dice qué hacer: deshacer el cobro
   * primero, o emitir una nota crédito, que es el camino pensado para esto.
   */
  try {
    await env.DB.prepare(`DELETE FROM invoices WHERE id = ?1`).bind(id).run();
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    if (/FOREIGN KEY|constraint/i.test(mensaje)) {
      throw ApiError.conflict(
        'factura-con-cobros',
        'Esa factura tiene cobros asignados, así que borrarla dejaría ese dinero sin explicación. ' +
          'Deshaz primero el cobro en Cobros, o emítele una nota crédito.',
      );
    }
    throw error;
  }

  return json({ ok: true });
}

interface AnularBody {
  motivo?: unknown;
}

/**
 * POST /api/admin/invoices/:id/anular
 *
 * El motivo es obligatorio: una factura anulada sin explicación es un agujero
 * en la contabilidad que nadie puede auditar después.
 */
export async function anular(
  request: Request,
  env: Env,
  user: JwtPayload,
  id: string,
): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const body = await readJson<AnularBody>(request);
  const motivo = requireString(body.motivo, 'motivo', 200);

  // Una factura con dinero encima NO se anula.
  //
  // Anularla pondría el saldo en 0 y daría por buena la deuda, pero el abono
  // que ya entró seguiría existiendo: la caja diría que se recibió una plata
  // que ya no corresponde a ninguna venta. La forma contable de deshacer algo
  // ya cobrado es una nota crédito con su devolución, no borrar el documento.
  // Se cierra aquí, en el servidor, y no solo escondiendo el botón: la
  // pantalla puede llegar con datos viejos, la API no.
  const result = await env.DB.prepare(
    `UPDATE invoices
        SET saldo = 0,
            estado = 'anulada',
            anulada_en = datetime('now'),
            anulada_por = ?2,
            motivo_anulacion = ?3
      WHERE id = ?1
        AND estado NOT IN ('anulada', 'pagada', 'pagada_parcial')`,
  )
    .bind(id, user.sub, motivo)
    .run();

  if (result.meta.changes === 0) {
    const existe = await env.DB.prepare(`SELECT estado FROM invoices WHERE id = ?1`)
      .bind(id)
      .first<{ estado: string }>();

    if (!existe) {
      throw ApiError.notFound('Esa factura no existe.');
    }
    if (existe.estado === 'anulada') {
      throw ApiError.conflict('ya-anulada', 'Esa factura ya estaba anulada.');
    }
    throw ApiError.conflict(
      'factura-con-pagos',
      'Esa factura ya tiene dinero recibido, así que no se puede anular. ' +
        'Para deshacerla hay que registrar la devolución.',
    );
  }

  const updated = await env.DB.prepare(`SELECT ${COLUMNS} FROM invoices WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ invoice: updated });
}
