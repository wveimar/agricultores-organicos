import { ApiError, json, optionalString, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { DeudaAbierta, Reparto, repartirPorAntiguedad, validarReparto } from '../allocation';

/**
 * Cartera — el dinero que entra.
 *
 * Un `payment` es un hecho: entró tal plata, tal día, por tal medio. Las
 * `payment_allocations` dicen contra qué deudas se aplica. Separarlos es lo
 * que permite las tres cosas que un modelo de dos tablas no puede:
 *
 *   · un pago que cubre varias facturas (el restaurante que paga la semana),
 *   · una factura que recibe varios abonos,
 *   · un pago que sobra y queda como anticipo del cliente.
 *
 * El `saldo` de cada factura NO se toca a mano en ningún sitio: se recalcula
 * siempre desde la suma de sus asignaciones, dentro del mismo `batch()` que
 * las modifica. Es lo que impide que la cartera y los abonos se separen.
 */

const COLUMNS = `p.id,
                 p.referencia,
                 p.contact_id          AS contactId,
                 p.cliente_nombre      AS clienteNombre,
                 p.monto,
                 p.metodo,
                 p.recibido_en         AS recibidoEn,
                 p.recibido_por_nombre AS recibidoPorNombre,
                 p.liquidado,
                 p.closing_id          AS closingId,
                 p.nota`;

/**
 * Los tres sumandos del saldo de una factura, en SQL.
 *
 * Se exportan como texto porque el recálculo ocurre en tres sitios distintos
 * (al abonar, al editar un cobro y al emitir una nota) y las tres copias TIENEN
 * que decir lo mismo. Si una se queda atrás, la cartera y la caja empiezan a
 * contar cosas distintas y no hay forma de saber cuál miente.
 *
 * `invoices.id` sin alias a propósito: así el fragmento sirve tanto dentro de
 * un UPDATE sobre `invoices` como en un SELECT que la nombre.
 */
export const COBRADO_SQL = `IFNULL((SELECT SUM(a.monto)
                                      FROM payment_allocations a
                                     WHERE a.invoice_id = invoices.id), 0)`;

/** Notas crédito vivas sobre esta factura: restan. */
export const CREDITOS_SQL = `IFNULL((SELECT SUM(n.total)
                                       FROM invoices n
                                      WHERE n.invoice_origen_id = invoices.id
                                        AND n.tipo = 'nota_credito'
                                        AND n.estado <> 'anulada'), 0)`;

/** Notas débito vivas sobre esta factura: suman. */
export const DEBITOS_SQL = `IFNULL((SELECT SUM(n.total)
                                      FROM invoices n
                                     WHERE n.invoice_origen_id = invoices.id
                                       AND n.tipo = 'nota_debito'
                                       AND n.estado <> 'anulada'), 0)`;

/** Lo que se debe de verdad: total + cargos − créditos − cobrado. */
const DEUDA_SQL = `(total + ${DEBITOS_SQL} - ${CREDITOS_SQL})`;

/**
 * Recalcula el saldo y el estado de una factura.
 *
 * Se devuelve como sentencia para poder meterla en el mismo `batch()` que
 * modifica lo que la afecta: si se ejecutara aparte, un fallo entre las dos
 * dejaría el saldo mintiendo, que es lo que este módulo viene a evitar.
 *
 * Una anulada conserva su estado pase lo que pase: ya es historia. Y una nota
 * nunca se recalcula sobre sí misma —no se cobra, corrige— así que se filtra
 * por `tipo = 'factura'`.
 */
export function recalcularStatement(env: Env, invoiceId: string) {
  return env.DB.prepare(
    `UPDATE invoices
        SET saldo = MAX(0, ${DEUDA_SQL} - ${COBRADO_SQL}),
            estado = CASE
              WHEN estado = 'anulada'                THEN 'anulada'
              WHEN ${COBRADO_SQL} >= ${DEUDA_SQL}    THEN 'pagada'
              WHEN ${COBRADO_SQL} > 0                THEN 'pagada_parcial'
              ELSE 'emitida'
            END
      WHERE id = ?1 AND tipo = 'factura'`,
  ).bind(invoiceId);
}

/** Las facturas de un cliente que todavía deben algo. */
async function deudasDe(env: Env, contactId: string): Promise<DeudaAbierta[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, saldo, emitida_en AS emitidaEn
       FROM invoices
      WHERE contact_id = ?1 AND estado <> 'anulada' AND saldo > 0
      ORDER BY emitida_en, id`,
  )
    .bind(contactId)
    .all<DeudaAbierta>();

  return results;
}

/** Sentencias que insertan un pago y su reparto, y recalculan lo afectado. */
function sentenciasDeCobro(
  env: Env,
  paymentId: string,
  repartos: readonly Reparto[],
) {
  return [
    ...repartos.map((reparto) =>
      env.DB.prepare(
        `INSERT INTO payment_allocations (payment_id, invoice_id, monto) VALUES (?1, ?2, ?3)`,
      ).bind(paymentId, reparto.invoiceId, reparto.monto),
    ),
    ...repartos.map((reparto) => recalcularStatement(env, reparto.invoiceId)),
  ];
}

// ─────────────────── Cobros que nacen de un pedido, no del panel ───────────────────

/**
 * El cobro que hace un domiciliario en la puerta, o el de un fiado.
 *
 * Se expone como sentencias para que `orders.ts` las meta en el mismo `batch()`
 * que cambia el estado del pedido: cobrar y registrar el cobro son el mismo
 * hecho, y partirlos en dos peticiones dejaría una ventana en la que el pedido
 * figura pagado y la cartera sigue diciendo que debe.
 *
 * `liquidado` distingue de dónde sale la plata: el efectivo de la puerta sigue
 * en el bolsillo del domiciliario hasta que alguien lo entrega en la finca, así
 * que no puede contar en el cierre todavía. Una transferencia sí.
 *
 * `monto` es opcional y es lo que hace posible el abono en la puerta: sin él
 * (el caso de siempre, cobro completo) se cobra `i.saldo`, todo lo que la
 * factura debe. Con él —el cliente solo tenía una parte— se cobra
 * `MIN(i.saldo, monto)`: nunca más de lo que en realidad se debe, así que un
 * monto mandado de más no puede sobrepagar esta factura por este camino. El
 * pedido de todas formas pasa a 'pago' — la mercancía salió igual, cobrada del
 * todo o no—, y lo que falte por cobrar queda vivo en el saldo de la factura,
 * donde ya lo sabe encontrar Cartera.
 */
export function cobrarPedidoStatements(
  env: Env,
  paymentId: string,
  orderId: string,
  user: JwtPayload,
  opciones: {
    metodo: 'efectivo' | 'transferencia' | 'tarjeta';
    liquidado: 0 | 1;
    monto?: number;
    /**
     * En qué caja entra la plata. Por defecto 'ecommerce', para que las
     * llamadas de siempre —`orders.markPaid`, `collectCredit`— sigan
     * comportándose igual sin tocarlas.
     */
    canal?: 'ecommerce' | 'pos';
  },
) {
  // NULL de verdad y no `?? i.saldo` en JS: la comparación tiene que ocurrir en
  // SQL contra el saldo real de la factura en el momento del batch, no contra
  // un valor leído en una consulta aparte que podría quedar desactualizado.
  const monto = opciones.monto ?? null;
  const canal = opciones.canal ?? 'ecommerce';

  return [
    // El cliente sale de la propia factura del pedido, no de lo que mande
    // quien llama: es la única fuente correcta de a quién se le cobró.
    env.DB.prepare(
      // `cuenta_id` sale del método y no de quien llama (migración 0035): el
      // efectivo va al cajón y lo demás al banco. Deducirlo aquí, en el único
      // sitio por donde pasan todos los cobros de pedido, evita que cada
      // camino que cobra —POS, domiciliario, cartera— tenga que acordarse.
      `INSERT INTO payments (
         id, referencia, contact_id, cliente_nombre, monto, metodo,
         recibido_en, recibido_por, recibido_por_nombre, liquidado, canal, cuenta_id
       )
       SELECT ?1,
              'ABONO-' || printf('%06d', (SELECT IFNULL(MAX(CAST(substr(referencia, 7) AS INTEGER)), 0) + 1 FROM payments)),
              i.contact_id, i.cliente_nombre,
              CASE WHEN ?7 IS NULL THEN i.saldo ELSE MIN(i.saldo, ?7) END,
              ?4, datetime('now'), ?3, ?5, ?6, ?8,
              CASE WHEN ?4 = 'efectivo' THEN 'caja-efectivo' ELSE 'cuenta-bancaria' END
         FROM invoices i
        WHERE i.order_id = ?2 AND i.estado <> 'anulada' AND i.saldo > 0`,
    ).bind(
      paymentId,
      orderId,
      user.sub,
      opciones.metodo,
      user.nombre,
      opciones.liquidado,
      monto,
      canal,
    ),

    // Y el reparto: lo mismo que se acaba de cobrar, contra esa misma factura.
    // El WHERE del SELECT hace que si no había factura viva no se inserte
    // nada, en vez de crear una asignación colgando del vacío.
    env.DB.prepare(
      `INSERT INTO payment_allocations (payment_id, invoice_id, monto)
       SELECT ?1, i.id, CASE WHEN ?3 IS NULL THEN i.saldo ELSE MIN(i.saldo, ?3) END
         FROM invoices i
        WHERE i.order_id = ?2 AND i.estado <> 'anulada' AND i.saldo > 0`,
    ).bind(paymentId, orderId, monto),

    // Recalcula por `order_id` porque aquí no se conoce el id de la factura.
    // Misma fórmula que `recalcularStatement`, armada con los mismos
    // fragmentos: son la única definición de qué se debe.
    env.DB.prepare(
      `UPDATE invoices
          SET saldo = MAX(0, ${DEUDA_SQL} - ${COBRADO_SQL}),
              estado = CASE
                WHEN estado = 'anulada'             THEN 'anulada'
                WHEN ${COBRADO_SQL} >= ${DEUDA_SQL} THEN 'pagada'
                WHEN ${COBRADO_SQL} > 0             THEN 'pagada_parcial'
                ELSE 'emitida'
              END
        WHERE order_id = ?1 AND estado <> 'anulada' AND tipo = 'factura'`,
    ).bind(orderId),
  ];
}

/**
 * Marca como disponible el efectivo que un domiciliario acaba de entregar.
 *
 * Hasta aquí la plata estaba cobrada pero no en la finca. A partir de ahora
 * cuenta para el cierre.
 */
export function liquidarPedidoStatement(env: Env, orderId: string) {
  return env.DB.prepare(
    `UPDATE payments
        SET liquidado = 1
      WHERE liquidado = 0
        AND id IN (SELECT a.payment_id
                     FROM payment_allocations a
                     JOIN invoices i ON i.id = a.invoice_id
                    WHERE i.order_id = ?1)`,
  ).bind(orderId);
}

// ───────────────────────────────── Endpoints ─────────────────────────────────

/** GET /api/admin/payments — los cobros, del más reciente al más viejo. */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const contactId = url.searchParams.get('contactId');
  const filtro = contactId ? `WHERE p.contact_id = ?1` : '';
  const bindings = contactId ? [contactId] : [];

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            IFNULL((SELECT SUM(a.monto) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS asignado
       FROM payments p
       ${filtro}
      ORDER BY p.recibido_en DESC, p.rowid DESC
      LIMIT 200`,
  )
    .bind(...bindings)
    .all();

  const resumen = await env.DB.prepare(
    `SELECT
       IFNULL(SUM(monto), 0)                                        AS cobrado,
       IFNULL(SUM(CASE WHEN liquidado = 0 THEN monto ELSE 0 END), 0) AS enPoderDelDomiciliario,
       IFNULL(SUM(CASE WHEN closing_id IS NULL AND liquidado = 1 THEN monto ELSE 0 END), 0) AS sinCerrar
     FROM payments`,
  ).first();

  return json({ payments: results, resumen });
}

/** GET /api/admin/payments/deudas?contactId= — lo que un cliente debe hoy. */
export async function deudas(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const contactId = url.searchParams.get('contactId');
  if (!contactId) {
    throw ApiError.badRequest('falta-cliente', 'Dime de qué cliente quieres las deudas.');
  }

  const { results } = await env.DB.prepare(
    `SELECT id, numero, total, saldo, contact_id AS contactId,
            cliente_nombre AS clienteNombre, emitida_en AS emitidaEn, vence_en AS venceEn
       FROM invoices
      WHERE contact_id = ?1 AND estado <> 'anulada' AND saldo > 0
      ORDER BY emitida_en, id`,
  )
    .bind(contactId)
    .all();

  return json({ deudas: results });
}

/**
 * GET /api/admin/payments/deudores — todos los clientes con algo pendiente,
 * con el detalle de cada factura.
 *
 * Es lo mismo que `deudas()` sin el filtro de un cliente: existe para la
 * pantalla de Cobros, que necesita mostrar de entrada quién debe qué, no
 * esperar a que alguien elija un nombre en el desplegable para enterarse.
 *
 * Sin el límite de 200 que sí tiene `list()`: esta es la lista que decide a
 * quién llamar a cobrar, y una deuda vieja que se cayera del límite por
 * antigüedad es exactamente la que más urge no perder de vista.
 */
export async function deudores(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { results } = await env.DB.prepare(
    `SELECT id, numero, total, saldo, contact_id AS contactId,
            cliente_nombre AS clienteNombre, emitida_en AS emitidaEn, vence_en AS venceEn
       FROM invoices
      WHERE estado <> 'anulada' AND tipo = 'factura' AND saldo > 0
      ORDER BY contact_id, emitida_en`,
  ).all();

  return json({ deudas: results });
}

/** GET /api/admin/payments/:id — el cobro con su reparto. */
export async function detail(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const [pagoRes, repartoRes] = await env.DB.batch([
    env.DB.prepare(`SELECT ${COLUMNS} FROM payments p WHERE p.id = ?1`).bind(id),
    env.DB.prepare(
      `SELECT a.id, a.invoice_id AS invoiceId, a.monto, i.numero
         FROM payment_allocations a
         JOIN invoices i ON i.id = a.invoice_id
        WHERE a.payment_id = ?1
        ORDER BY i.consecutivo`,
    ).bind(id),
  ]);

  const payment = pagoRes.results[0];
  if (!payment) {
    throw ApiError.notFound('Ese cobro no existe.');
  }

  return json({ payment, allocations: repartoRes.results });
}

/**
 * POST /api/admin/payments/:id/liquidar — confirma que este efectivo ya
 * llegó a la finca.
 *
 * Es el mismo hecho que `orders.settleCash` para un pedido contra entrega,
 * generalizado a cualquier cobro en efectivo sin liquidar — incluido el
 * abono de una deuda vieja que un domiciliario cobró en la calle y no está
 * atado a ningún pedido puntual. Sin este endpoint, esa plata solo se podía
 * liberar editando el cobro a mano, que ni siquiera tocaba `liquidado`.
 *
 * No hace falta nada más que el flag: a diferencia de un pedido contra
 * entrega, un abono suelto no tiene `orders.efectivo_liquidado` que
 * sincronizar — esa columna es específica del flujo de venta y aquí no hay
 * venta que recaudar, solo dinero que confirmar recibido.
 */
export async function liquidar(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const result = await env.DB.prepare(
    `UPDATE payments SET liquidado = 1 WHERE id = ?1 AND metodo = 'efectivo' AND liquidado = 0`,
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    const pago = await env.DB.prepare(`SELECT metodo, liquidado FROM payments WHERE id = ?1`)
      .bind(id)
      .first<{ metodo: string; liquidado: number }>();

    if (!pago) {
      throw ApiError.notFound('Ese cobro no existe.');
    }
    if (pago.metodo !== 'efectivo') {
      throw ApiError.conflict(
        'no-es-efectivo',
        'Ese cobro no es en efectivo: no hay nada físico que confirmar que llegó.',
      );
    }
    throw ApiError.conflict('ya-liquidado', 'Ese cobro ya estaba liquidado.');
  }

  const actualizado = await env.DB.prepare(`SELECT ${COLUMNS} FROM payments p WHERE p.id = ?1`)
    .bind(id)
    .first();

  return json({ payment: actualizado });
}

interface PaymentBody {
  contactId?: unknown;
  monto?: unknown;
  metodo?: unknown;
  nota?: unknown;
  /** Reparto explícito. Sin él se aplica a lo más viejo primero. */
  allocations?: unknown;
  /**
   * Solo la lee `create()`, y solo le importa a quien NO es domiciliario.
   *
   * Cubre el caso real que se coló: un domiciliario cobra en la calle y avisa
   * por teléfono, y quien contesta —de oficina— registra el abono en el
   * sistema. Ese efectivo sigue en el bolsillo de quien lo cobró, no en la
   * caja, aunque quien lo tecleó sea `GESTOR_PEDIDOS`. Sin esta bandera, todo
   * cobro registrado desde oficina nacía "ya en caja" sin excepción, y esa
   * plata jamás aparecía en "Efectivo por liquidar".
   *
   * `false` explícito es lo único que cambia el resultado — ver `leerEnCaja`.
   */
  enCaja?: unknown;
}

/**
 * Decide si el efectivo de un cobro ya está en la caja o todavía en la calle.
 *
 * Tres reglas, en este orden:
 *  1. Lo que no es efectivo siempre está "en caja": una transferencia llega
 *     directo a la cuenta, nunca pasa por el bolsillo de nadie.
 *  2. Si quien registra es el domiciliario, nunca está en caja — es
 *     literalmente la persona que tiene el billete en la mano, y no se le
 *     puede dejar autocertificar que ya lo entregó.
 *  3. Si es oficina, se confía en lo que diga el formulario: por defecto SÍ
 *     está en caja (alguien pagó en el mostrador o transfirió, que sigue
 *     siendo el caso más común), y solo si se marca `enCaja: false` a
 *     propósito queda pendiente — el caso del domiciliario que avisó por
 *     teléfono.
 */
function estaEnCaja(metodo: string, esDomiciliario: boolean, enCajaDelFormulario: unknown): boolean {
  if (metodo !== 'efectivo') {
    return true;
  }
  if (esDomiciliario) {
    return false;
  }
  return enCajaDelFormulario !== false;
}

/**
 * Los medios por los que puede entrar plata.
 *
 * Esta lista **es** la validación de `payments.metodo`: esa columna no lleva
 * CHECK, porque ampliarlo obligaría a recrear la tabla y recrear `payments`
 * dispara el CASCADE de `payment_allocations` — es decir, se llevaría la
 * asignación de cobros a facturas, que es la cartera entera. Añadir un medio
 * nuevo es añadirlo aquí y nada más.
 */
const METODOS = ['efectivo', 'transferencia', 'nequi', 'daviplata', 'tarjeta'] as const;

function leerMetodo(valor: unknown): (typeof METODOS)[number] {
  if (typeof valor === 'string' && (METODOS as readonly string[]).includes(valor)) {
    return valor as (typeof METODOS)[number];
  }
  // Efectivo por defecto: es lo que pasa en la finca cuando nadie especifica.
  return 'efectivo';
}

function leerRepartos(valor: unknown): Reparto[] | null {
  if (valor === undefined || valor === null) {
    return null;
  }
  if (!Array.isArray(valor)) {
    throw ApiError.badRequest('reparto-invalido', 'El reparto tiene que ser una lista.');
  }

  return valor.map((linea, i) => {
    const item = linea as { invoiceId?: unknown; monto?: unknown };
    return {
      invoiceId: requireString(item.invoiceId, `allocations[${i}].invoiceId`, 80),
      monto: requireInt(item.monto, `allocations[${i}].monto`, 1),
    };
  });
}

/**
 * POST /api/admin/payments — registrar un cobro.
 *
 * Si no se manda reparto, se aplica a las facturas más viejas primero, que es
 * el comportamiento por defecto de cualquier sistema contable: cobrar lo viejo
 * primero impide que una deuda envejezca indefinidamente mientras el cliente
 * sigue comprando y pagando lo último.
 *
 * Lo que sobre después de cubrir todo queda sin asignar: eso es el anticipo,
 * y se aplicará cuando llegue la siguiente factura.
 */
export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  /**
   * También el domiciliario.
   *
   * Es quien está delante del cliente cuando aparece la plata: además de
   * cobrar el pedido que lleva, muchas veces le pagan de una deuda vieja. Sin
   * este permiso ese abono tendría que anotarse en un papel y teclearse
   * después, que es exactamente donde el dinero se pierde.
   *
   * Lo que su rol NO le deja hacer está más abajo: el cobro le nace sin
   * liquidar, porque la plata sigue en su bolsillo hasta que la entregue en la
   * finca. Y no puede editar ni deshacer cobros — ni los suyos.
   */
  requireRole(user, 'GESTOR_PEDIDOS', 'DOMICILIARIO');

  const esDomiciliario =
    user.roles.includes('DOMICILIARIO') && !user.roles.includes('GESTOR_PEDIDOS');

  const body = await readJson<PaymentBody>(request);
  const contactId = requireString(body.contactId, 'contactId', 80);
  const monto = requireInt(body.monto, 'monto', 1);
  const metodo = leerMetodo(body.metodo);
  const nota = optionalString(body.nota, 'nota', 200);

  const contacto = await env.DB.prepare(`SELECT id, nombre FROM contacts WHERE id = ?1`)
    .bind(contactId)
    .first<{ id: string; nombre: string }>();

  if (!contacto) {
    throw ApiError.notFound('Ese cliente no está en la agenda.');
  }

  const abiertas = await deudasDe(env, contactId);
  const pedidos = leerRepartos(body.allocations);

  let repartos: readonly Reparto[];
  if (pedidos === null) {
    repartos = repartirPorAntiguedad(monto, abiertas).repartos;
  } else {
    const fallo = validarReparto(monto, pedidos, abiertas);
    if (fallo) {
      throw ApiError.badRequest('reparto-invalido', fallo);
    }
    repartos = pedidos;
  }

  const id = `pay-${crypto.randomUUID()}`;

  await env.DB.batch([
    env.DB.prepare(
      // `cuenta_id` deducido del método, igual que en `cobrarPedidoStatements`.
      `INSERT INTO payments (
         id, referencia, contact_id, cliente_nombre, monto, metodo,
         recibido_en, recibido_por, recibido_por_nombre, liquidado, nota, cuenta_id
       ) VALUES (
         ?1,
         'ABONO-' || printf('%06d', (SELECT IFNULL(MAX(CAST(substr(referencia, 7) AS INTEGER)), 0) + 1 FROM payments)),
         ?2, ?3, ?4, ?5, datetime('now'), ?6, ?7, ?9, ?8,
         CASE WHEN ?5 = 'efectivo' THEN 'caja-efectivo' ELSE 'cuenta-bancaria' END
       )`,
    ).bind(
      id,
      contactId,
      contacto.nombre,
      monto,
      metodo,
      user.sub,
      user.nombre,
      nota,
      estaEnCaja(metodo, esDomiciliario, body.enCaja) ? 1 : 0,
    ),
    ...sentenciasDeCobro(env, id, repartos),
  ]);

  const created = await env.DB.prepare(`SELECT ${COLUMNS} FROM payments p WHERE p.id = ?1`)
    .bind(id)
    .first();

  const asignado = repartos.reduce((total, r) => total + r.monto, 0);
  return json({ payment: created, anticipo: monto - asignado }, 201);
}

/**
 * Lee un cobro y comprueba que todavía se pueda tocar.
 *
 * Un cobro ya cerrado en una jornada no se modifica: sus cifras están
 * congeladas en `cash_closings` y cambiarlas dejaría el cierre describiendo
 * una realidad que ya no existe. Para corregir algo de una jornada cerrada hay
 * que registrar el movimiento contrario, no reescribir el pasado.
 */
async function exigirAbierto(env: Env, user: JwtPayload, id: string) {
  const pago = await env.DB.prepare(
    `SELECT id, contact_id AS contactId, monto, closing_id AS closingId FROM payments WHERE id = ?1`,
  )
    .bind(id)
    .first<{ id: string; contactId: string; monto: number; closingId: string | null }>();

  if (!pago) {
    throw ApiError.notFound('Ese cobro no existe.');
  }

  // El administrador puede corregir un cobro de una jornada ya cerrada.
  //
  // Es peor que editar una factura: el cierre congeló su cifra de `total_cobrado`
  // y editar el cobro NO la mueve, así que el recibo de esa jornada deja de
  // cuadrar con la suma de sus cobros. Se permite porque lo pidió el dueño del
  // negocio, pero solo a `SUPER_ADMIN` y avisando — ver `avisoDeCierre`.
  const esAdmin = user.roles.includes('SUPER_ADMIN');

  if (pago.closingId && !esAdmin) {
    throw ApiError.conflict(
      'cobro-cerrado',
      'Ese cobro ya entró en un cierre de caja: sus cifras están congeladas. ' +
        'Para corregirlo hay que registrar el movimiento contrario, o pedírselo a un administrador.',
    );
  }

  return { pago, tocaCajaCerrada: Boolean(pago.closingId) };
}

/** El aviso que acompaña a una corrección sobre una jornada ya cerrada. */
function avisoDeCierre(tocaCajaCerrada: boolean): string | null {
  return tocaCajaCerrada
    ? 'Este cobro ya estaba en un cierre de caja. El cierre conserva su cifra vieja, ' +
        'así que ese recibo ya no cuadra con la suma de sus cobros.'
    : null;
}

/**
 * PUT /api/admin/payments/:id
 *
 * Rehace el cobro entero: borra su reparto, lo vuelve a calcular y recalcula
 * todas las facturas que tocaba, las de antes y las de ahora. Las de antes
 * también, porque si el reparto cambia de factura, la que se queda sin plata
 * tiene que volver a deber.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  id: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { pago, tocaCajaCerrada } = await exigirAbierto(env, user, id);

  const body = await readJson<PaymentBody>(request);
  const monto = requireInt(body.monto, 'monto', 1);
  const metodo = leerMetodo(body.metodo);
  const nota = optionalString(body.nota, 'nota', 200);

  // Las facturas que este pago tocaba ANTES del cambio. Hay que recalcularlas
  // aunque salgan del reparto nuevo: si no, la que pierde el abono se quedaría
  // marcada como pagada sin que nadie la haya pagado.
  const { results: previas } = await env.DB.prepare(
    `SELECT invoice_id AS invoiceId FROM payment_allocations WHERE payment_id = ?1`,
  )
    .bind(id)
    .all<{ invoiceId: string }>();

  // Las deudas se calculan como si este pago no existiera: si no, sus propias
  // asignaciones contarían como saldadas y no habría dónde repartir.
  const { results: abiertas } = await env.DB.prepare(
    `SELECT i.id,
            i.total - IFNULL((SELECT SUM(a.monto) FROM payment_allocations a
                               WHERE a.invoice_id = i.id AND a.payment_id <> ?2), 0) AS saldo,
            i.emitida_en AS emitidaEn
       FROM invoices i
      WHERE i.contact_id = ?1 AND i.estado <> 'anulada'
      ORDER BY i.emitida_en, i.id`,
  )
    .bind(pago.contactId, id)
    .all<DeudaAbierta>();

  const disponibles = abiertas.filter((deuda) => deuda.saldo > 0);
  const pedidos = leerRepartos(body.allocations);

  let repartos: readonly Reparto[];
  if (pedidos === null) {
    repartos = repartirPorAntiguedad(monto, disponibles).repartos;
  } else {
    const fallo = validarReparto(monto, pedidos, disponibles);
    if (fallo) {
      throw ApiError.badRequest('reparto-invalido', fallo);
    }
    repartos = pedidos;
  }

  const tocadas = new Set([...previas.map((p) => p.invoiceId), ...repartos.map((r) => r.invoiceId)]);

  await env.DB.batch([
    env.DB.prepare(`UPDATE payments SET monto = ?2, metodo = ?3, nota = ?4 WHERE id = ?1`).bind(
      id,
      monto,
      metodo,
      nota,
    ),
    env.DB.prepare(`DELETE FROM payment_allocations WHERE payment_id = ?1`).bind(id),
    ...repartos.map((reparto) =>
      env.DB.prepare(
        `INSERT INTO payment_allocations (payment_id, invoice_id, monto) VALUES (?1, ?2, ?3)`,
      ).bind(id, reparto.invoiceId, reparto.monto),
    ),
    ...[...tocadas].map((invoiceId) => recalcularStatement(env, invoiceId)),
  ]);

  const updated = await env.DB.prepare(`SELECT ${COLUMNS} FROM payments p WHERE p.id = ?1`)
    .bind(id)
    .first();

  const asignado = repartos.reduce((total, r) => total + r.monto, 0);
  return json({ payment: updated, anticipo: monto - asignado, aviso: avisoDeCierre(tocaCajaCerrada) });
}

/**
 * DELETE /api/admin/payments/:id — deshacer un cobro mal registrado.
 *
 * El reparto se va con él por el CASCADE, y las facturas que tocaba vuelven a
 * deber. Solo mientras la jornada siga abierta.
 */
export async function remove(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { tocaCajaCerrada } = await exigirAbierto(env, user, id);

  const { results: tocadas } = await env.DB.prepare(
    `SELECT invoice_id AS invoiceId FROM payment_allocations WHERE payment_id = ?1`,
  )
    .bind(id)
    .all<{ invoiceId: string }>();

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM payments WHERE id = ?1`).bind(id),
    // Después del borrado: el CASCADE ya se llevó las asignaciones, así que la
    // suma que recalcula cada factura ya no las incluye.
    ...tocadas.map((fila) => recalcularStatement(env, fila.invoiceId)),
  ]);

  return json({ ok: true, aviso: avisoDeCierre(tocaCajaCerrada) });
}
