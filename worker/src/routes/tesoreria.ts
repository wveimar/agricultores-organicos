import { ApiError, json, optionalString, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { verifyPassword } from '../auth/crypto';

/**
 * Tesorería — dónde está la plata y a dónde se va.
 *
 * ── La decisión que ordena todo el módulo ──
 *
 * No hay un libro de movimientos que lo registre todo. Un cobro ya vive en
 * `payments`, un gasto en `expenses` y un giro a una finca en
 * `provider_purchases`; copiarlos a una tabla propia sería una SEGUNDA verdad
 * sobre el mismo hecho, y se rompería el día que alguien escriba un pago por
 * otro camino —el POS, por ejemplo, que cobra desde `pos.sell()`—.
 *
 * En su lugar, cada una de esas tablas dice en qué cuenta movió la plata, y
 * aquí se leen las cuatro juntas:
 *
 *   payments            → entra
 *   expenses            → sale
 *   provider_purchases  → sale (solo las ya pagadas)
 *   invoice_refunds     → sale (devoluciones atadas a una nota crédito)
 *   treasury_movements  → ingresos, egresos y traslados sueltos
 *
 * El saldo de una cuenta es esa suma más su saldo inicial. Calculado, no
 * guardado: un saldo guardado se desincroniza y nadie se entera hasta que el
 * arqueo no cuadra. Es el mismo criterio con el que el stock de una canasta no
 * se guarda en ninguna columna (ver `stockDeCanastas()` en combos.ts).
 *
 * ── Turnos y cierre de jornada son cosas distintas ──
 *
 * El turno responde «¿cuadró el cajón de este cajero?»: fondo de apertura,
 * efectivo contado, diferencia y entrega firmada. El cierre de jornada
 * (reports.ts) responde «¿cuánto se ganó hoy?». No se pisan, y dentro de una
 * jornada caben varios turnos.
 */

/** La hora de Colombia. El resto del panel usa el mismo desfase para "hoy". */
const HOY = `date('now', '-5 hours')`;

/**
 * El SELECT que unifica las cinco fuentes de movimiento.
 *
 * Se escribe una sola vez y se reutiliza en el listado, en los saldos y en el
 * arqueo del turno. Si se copiara, bastaría con que una copia se quedara sin
 * `treasury_movements` para que el saldo y la lista dijeran cosas distintas
 * sobre la misma plata — que es exactamente el problema que este módulo evita.
 *
 * `entra` y `sale` en vez de un monto con signo: la pantalla los pinta en dos
 * columnas, y un signo obliga a decidir en cada consulta de qué lado va.
 */
const MOVIMIENTOS_SQL = `
  SELECT p.id                                   AS id,
         p.recibido_en                          AS fecha,
         p.cuenta_id                            AS cuentaId,
         'cobro'                                AS tipo,
         COALESCE(p.nota, 'Cobro')              AS concepto,
         p.cliente_nombre                       AS tercero,
         p.referencia                           AS referencia,
         p.monto                                AS entra,
         0                                      AS sale
    FROM payments p
   WHERE p.cuenta_id IS NOT NULL

  UNION ALL

  SELECT g.id, g.creado_en, g.cuenta_id, 'gasto',
         g.descripcion, NULL, NULL, 0, g.monto
    FROM expenses g
   WHERE g.cuenta_id IS NOT NULL

  UNION ALL

  -- Cada abono a una finca, uno por fila (migración 0036).
  --
  -- Antes se leía la compra entera cuando quedaba en 'pagado'. Con abonos
  -- parciales eso ya no sirve: una compra a medio girar sigue 'pendiente' y su
  -- primer abono YA salió de una cuenta. Leer los abonos —y no la compra— es
  -- lo que hace que el saldo cuadre contra el cajón en todo momento, y de paso
  -- deja que dos abonos de la misma compra salgan de bolsillos distintos.
  SELECT pp.id, pp.pagado_en, pp.cuenta_id, 'pago_proveedor',
         COALESCE(pp.nota, 'Pago a proveedor'), c.origen, NULL, 0, pp.monto
    FROM provider_payments pp
    JOIN provider_purchases c ON c.id = pp.purchase_id
   WHERE pp.cuenta_id IS NOT NULL

  UNION ALL

  -- Cada devolución de dinero, atada a la nota crédito que la autoriza
  -- (migración 0037). Es la contraparte de un cobro: un cobro entra por una
  -- FACTURA, una devolución sale por una NOTA CRÉDITO — y por eso puede
  -- pasar sobre una factura que ya estaba pagada del todo.
  SELECT r.id, r.devuelto_en, r.cuenta_id, 'devolucion',
         COALESCE(r.observaciones, 'Devolución ' || n.numero), n.cliente_nombre, n.numero, 0, r.monto
    FROM invoice_refunds r
    JOIN invoices n ON n.id = r.nota_credito_id
   WHERE r.cuenta_id IS NOT NULL

  UNION ALL

  -- Ingresos, egresos y traslados sueltos — las dos caras de un traslado en
  -- UN solo término, no dos.
  --
  -- Sin acentos graves en este comentario: va DENTRO de una plantilla de JS
  -- y uno solo la cortaría en seco.
  --
  -- Antes eran dos ramas separadas por UNION ALL (origen y destino del
  -- traslado). D1 rechaza un SELECT compuesto de más de cinco términos
  -- (el error dice literalmente "too many terms in compound SELECT"), y con
  -- la devolución de arriba ya se llegaba a seis. La salida de un traslado
  -- sale de SU cuenta y entra en la de destino: son el mismo hecho visto dos
  -- veces, así que se generan con un CROSS JOIN a una tabla de dos filas
  -- (lado.n en 0 y 1) en vez de dos SELECT — mismo resultado, un término
  -- menos aquí arriba. Ese "lado" SÍ es un SELECT de dos términos, pero va en
  -- SU PROPIO subquery (una tabla derivada, no una rama de este UNION), así
  -- que no cuenta contra el límite de esta consulta. Ojo con la sintaxis:
  -- D1 no admite nombrar las columnas al alias de una tabla derivada
  -- (rechaza "AS lado(n)"), así que el subquery le da el nombre a la columna
  -- por sí mismo con "AS n" y el alias de la tabla no lleva paréntesis.
  SELECT
    m.id || CASE WHEN lado.n = 1 THEN '-destino' ELSE '' END           AS id,
    m.creado_en                                                        AS fecha,
    CASE WHEN lado.n = 1 THEN m.cuenta_destino_id ELSE m.cuenta_id END AS cuentaId,
    CASE
      WHEN lado.n = 1           THEN 'traslado_entrada'
      WHEN m.tipo = 'traslado'  THEN 'traslado_salida'
      ELSE m.tipo
    END                                                                AS tipo,
    m.concepto, m.tercero, m.referencia,
    CASE
      WHEN lado.n = 1           THEN m.monto
      WHEN m.tipo = 'ingreso'   THEN m.monto
      ELSE 0
    END                                                                AS entra,
    CASE
      WHEN lado.n = 1           THEN 0
      WHEN m.tipo = 'ingreso'   THEN 0
      ELSE m.monto
    END                                                                AS sale
    FROM treasury_movements m
    CROSS JOIN (SELECT 0 AS n UNION ALL SELECT 1) AS lado
   -- El lado 1 (destino) solo existe para un traslado: un ingreso o un
   -- egreso no tienen "otra cuenta" a la que entrarle.
   WHERE lado.n = 0 OR m.tipo = 'traslado'
`;

/** Una cuenta con su saldo ya resuelto, tal como sale de la consulta. */
interface CuentaConSaldo {
  id: string;
  nombre: string;
  tipo: 'efectivo' | 'banco';
  descripcion: string | null;
  saldoInicial: number;
  orden: number;
  saldo: number;
  entraHoy: number;
  saleHoy: number;
}

/** Cuentas activas con su saldo ya calculado. */
async function cuentasConSaldo(env: Env): Promise<CuentaConSaldo[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nombre, c.tipo, c.descripcion, c.saldo_inicial AS saldoInicial, c.orden,
            c.saldo_inicial
              + COALESCE((SELECT SUM(m.entra - m.sale) FROM (${MOVIMIENTOS_SQL}) m
                           WHERE m.cuentaId = c.id), 0) AS saldo,
            COALESCE((SELECT SUM(m.entra) FROM (${MOVIMIENTOS_SQL}) m
                       WHERE m.cuentaId = c.id AND date(m.fecha, '-5 hours') = ${HOY}), 0) AS entraHoy,
            COALESCE((SELECT SUM(m.sale) FROM (${MOVIMIENTOS_SQL}) m
                       WHERE m.cuentaId = c.id AND date(m.fecha, '-5 hours') = ${HOY}), 0) AS saleHoy
       FROM treasury_accounts c
      WHERE c.activo = 1
      ORDER BY c.orden, c.nombre`,
  ).all<CuentaConSaldo>();

  return results;
}

/**
 * GET /api/admin/tesoreria/resumen — la pestaña de arranque.
 *
 * Junta lo que hay, lo que va a entrar y lo que hay que pagar. La «posición
 * neta» es disponible + por cobrar − por pagar: es la cifra que dice si el
 * negocio está bien aunque hoy el cajón esté flaco.
 */
export async function resumen(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const cuentas = await cuentasConSaldo(env);

  const [cobrar, pagar, devolver, hoy] = await env.DB.batch([
    // Por cobrar: el saldo vivo de las facturas, y cuánto de eso ya se venció.
    env.DB.prepare(
      `SELECT COALESCE(SUM(saldo), 0) AS total,
              COALESCE(SUM(CASE WHEN vence_en IS NOT NULL AND date(vence_en) < ${HOY}
                                THEN saldo ELSE 0 END), 0) AS vencido,
              COUNT(DISTINCT contact_id) AS clientes
         FROM invoices
        WHERE tipo = 'factura' AND estado <> 'anulada' AND saldo > 0`,
    ),
    // Por pagar: lo que se le debe a las fincas.
    env.DB.prepare(
      // `total_pago - monto_pagado` y no `total_pago`: desde que hay abonos
      // parciales (migración 0036), una compra a medio girar debe lo que
      // falta, no lo que costó.
      `SELECT COALESCE(SUM(total_pago - monto_pagado), 0) AS total,
              COUNT(*) AS cuentas
         FROM provider_purchases
        WHERE estado = 'pendiente' AND total_pago > monto_pagado`,
    ),
    // Por devolver: notas crédito con plata todavía sin salir (migración
    // 0037). Es plata que el negocio debe, igual que «por pagar» — por eso
    // entra con signo negativo en `posicionNeta` más abajo.
    env.DB.prepare(
      `SELECT COALESCE(SUM(total - monto_devuelto), 0) AS total,
              COUNT(*) AS notas
         FROM invoices
        WHERE tipo = 'nota_credito' AND estado <> 'anulada' AND total > monto_devuelto`,
    ),
    env.DB.prepare(
      `SELECT COALESCE(SUM(entra), 0) AS entra, COALESCE(SUM(sale), 0) AS sale
         FROM (${MOVIMIENTOS_SQL}) WHERE date(fecha, '-5 hours') = ${HOY}`,
    ),
  ]);

  const porCobrar = (cobrar.results[0] ?? {}) as Record<string, number>;
  const porPagar = (pagar.results[0] ?? {}) as Record<string, number>;
  const porDevolver = (devolver.results[0] ?? {}) as Record<string, number>;
  const delDia = (hoy.results[0] ?? {}) as Record<string, number>;

  const disponible = cuentas.reduce((suma, c) => suma + c.saldo, 0);

  return json({
    cuentas,
    disponible,
    porCobrar,
    porPagar,
    porDevolver,
    hoy: { ...delDia, neto: (delDia['entra'] ?? 0) - (delDia['sale'] ?? 0) },
    // Disponible + lo que entra − lo que sale − lo que hay que devolver. Las
    // dos últimas son plata que el negocio debe, aunque por caminos
    // distintos: una a un proveedor, la otra a un cliente al que se le cobró
    // de más.
    posicionNeta:
      disponible + (porCobrar['total'] ?? 0) - (porPagar['total'] ?? 0) - (porDevolver['total'] ?? 0),
  });
}

/**
 * GET /api/admin/tesoreria/movimientos — el libro, con filtros.
 *
 * `?cuenta=`, `?tipo=` y `?q=` (concepto, tercero o referencia). El límite es
 * alto pero existe: sin él, el día que haya diez mil movimientos la pantalla se
 * los bajaría todos para pintar los veinte primeros.
 */
export async function movimientos(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const filtros: string[] = [];
  const bindings: unknown[] = [];

  const cuenta = url.searchParams.get('cuenta');
  const tipo = url.searchParams.get('tipo');
  const q = url.searchParams.get('q');

  // Los nombres van con el prefijo `m.` desde que se escriben: el subselect y
  // la tabla de cuentas comparten los nombres `tipo` y `nombre`, así que sin
  // calificar la columna SQLite no sabría de cuál de las dos se habla.
  if (cuenta) {
    bindings.push(cuenta);
    filtros.push(`m.cuentaId = ?${bindings.length}`);
  }
  if (tipo) {
    bindings.push(tipo);
    filtros.push(`m.tipo = ?${bindings.length}`);
  }
  if (q && q.trim() !== '') {
    const patron = `%${q.trim().toLowerCase()}%`;
    bindings.push(patron, patron, patron);
    filtros.push(
      `(LOWER(m.concepto) LIKE ?${bindings.length - 2}` +
        ` OR LOWER(COALESCE(m.tercero, '')) LIKE ?${bindings.length - 1}` +
        ` OR LOWER(COALESCE(m.referencia, '')) LIKE ?${bindings.length})`,
    );
  }

  const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.fecha, m.cuentaId, m.tipo, m.concepto, m.tercero, m.referencia,
            m.entra, m.sale,
            c.nombre AS cuentaNombre, c.tipo AS cuentaTipo
       FROM (${MOVIMIENTOS_SQL}) m
       LEFT JOIN treasury_accounts c ON c.id = m.cuentaId
       ${where}
      ORDER BY m.fecha DESC
      LIMIT 300`,
  )
    .bind(...bindings)
    .all();

  const totales = results.reduce(
    (acumulado: { entra: number; sale: number }, fila) => {
      const f = fila as Record<string, number>;
      return { entra: acumulado.entra + (f['entra'] ?? 0), sale: acumulado.sale + (f['sale'] ?? 0) };
    },
    { entra: 0, sale: 0 },
  );

  return json({ movimientos: results, totales });
}

/**
 * GET /api/admin/tesoreria/antiguedad — cuánto lleva vencido lo que se debe.
 *
 * Los mismos cuatro tramos para lo que entra y lo que sale. Un saldo sin fecha
 * de vencimiento cuenta como «al día»: no se puede decir que esté vencido algo
 * a lo que nunca se le puso plazo.
 */
export async function antiguedad(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const tramo = (campo: string) => `
    CASE
      WHEN ${campo} IS NULL OR date(${campo}) >= ${HOY} THEN 'al_dia'
      WHEN julianday(${HOY}) - julianday(date(${campo})) <= 7  THEN 'd1_7'
      WHEN julianday(${HOY}) - julianday(date(${campo})) <= 30 THEN 'd8_30'
      ELSE 'd30_mas'
    END`;

  const [cobrar, pagar] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${tramo('vence_en')} AS tramo, COALESCE(SUM(saldo), 0) AS total, COUNT(*) AS cuantos
         FROM invoices
        WHERE tipo = 'factura' AND estado <> 'anulada' AND saldo > 0
        GROUP BY tramo`,
    ),
    // Las compras a fincas no llevan fecha de vencimiento propia: se toma la
    // de creación, que es cuando nació la deuda con el agricultor.
    env.DB.prepare(
      `SELECT ${tramo('creado_en')} AS tramo,
              COALESCE(SUM(total_pago - monto_pagado), 0) AS total,
              COUNT(*) AS cuantos
         FROM provider_purchases
        WHERE estado = 'pendiente' AND total_pago > monto_pagado
        GROUP BY tramo`,
    ),
  ]);

  return json({ porCobrar: cobrar.results, porPagar: pagar.results });
}

/**
 * GET /api/admin/tesoreria/proyeccion — cómo queda la caja en 30 días.
 *
 * Cortes a 7, 14, 21 y 30 días: en cada uno, lo que entra por facturas que
 * vencen antes de esa fecha menos lo que sale por compras pendientes, partiendo
 * del disponible de hoy.
 *
 * Es una proyección, no una promesa: supone que todo el mundo paga el día que
 * dijo. Sirve para ver el mes que viene, no para prometerle nada a nadie.
 */
export async function proyeccion(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const cuentas = await cuentasConSaldo(env);
  const disponible = cuentas.reduce((suma, c) => suma + c.saldo, 0);

  const cortes = [7, 14, 21, 30];
  const filas = [];
  let acumulado = disponible;

  for (const [i, dias] of cortes.entries()) {
    const desde = i === 0 ? 0 : cortes[i - 1];

    const fila = await env.DB.prepare(
      `SELECT
         COALESCE((SELECT SUM(saldo) FROM invoices
                    WHERE tipo = 'factura' AND estado <> 'anulada' AND saldo > 0
                      AND vence_en IS NOT NULL
                      AND date(vence_en) >  date(${HOY}, '+' || ?1 || ' days')
                      AND date(vence_en) <= date(${HOY}, '+' || ?2 || ' days')), 0) AS entra,
         COALESCE((SELECT SUM(total_pago - monto_pagado) FROM provider_purchases
                    WHERE estado = 'pendiente' AND total_pago > monto_pagado
                      AND date(creado_en) >  date(${HOY}, '+' || ?1 || ' days')
                      AND date(creado_en) <= date(${HOY}, '+' || ?2 || ' days')), 0) AS sale`,
    )
      .bind(desde, dias)
      .first<{ entra: number; sale: number }>();

    const entra = fila?.entra ?? 0;
    const sale = fila?.sale ?? 0;
    acumulado += entra - sale;

    filas.push({ dias, entra, sale, neto: entra - sale, proyectada: acumulado });
  }

  return json({ disponible, cortes: filas });
}

interface MovimientoBody {
  tipo?: unknown;
  cuentaId?: unknown;
  cuentaDestinoId?: unknown;
  monto?: unknown;
  concepto?: unknown;
  tercero?: unknown;
  referencia?: unknown;
}

/**
 * POST /api/admin/tesoreria/movimientos — ingreso, egreso o traslado.
 *
 * Un traslado es UNA fila con dos cuentas, no dos filas enfrentadas: así no
 * puede quedar media transferencia registrada si algo falla entre una y otra.
 * Al leer se abre en dos (ver `MOVIMIENTOS_SQL`), que es como lo necesita
 * la pantalla.
 *
 * No se deja sacar de una cuenta más de lo que tiene: un saldo negativo en el
 * cajón no significa nada — o alguien contó mal, o falta registrar un ingreso.
 */
export async function crearMovimiento(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<MovimientoBody>(request);

  const tipo = body.tipo;
  if (tipo !== 'ingreso' && tipo !== 'egreso' && tipo !== 'traslado') {
    throw ApiError.badRequest(
      'tipo-invalido',
      'El movimiento tiene que ser un ingreso, un egreso o un traslado.',
    );
  }

  const cuentaId = requireString(body.cuentaId, 'cuentaId', 64);
  const monto = requireInt(body.monto, 'monto', 1);
  const concepto = requireString(body.concepto, 'concepto', 200);

  const tercero =
    body.tercero === undefined || body.tercero === null || body.tercero === ''
      ? null
      : requireString(body.tercero, 'tercero', 160);
  const referencia =
    body.referencia === undefined || body.referencia === null || body.referencia === ''
      ? null
      : requireString(body.referencia, 'referencia', 80);

  let cuentaDestinoId: string | null = null;
  if (tipo === 'traslado') {
    cuentaDestinoId = requireString(body.cuentaDestinoId, 'cuentaDestinoId', 64);
    if (cuentaDestinoId === cuentaId) {
      throw ApiError.badRequest(
        'traslado-circular',
        'Un traslado tiene que ir a una cuenta distinta de la de origen.',
      );
    }
  }

  const cuentas = await cuentasConSaldo(env);
  const origen = cuentas.find((c) => c.id === cuentaId);
  if (!origen) {
    throw ApiError.badRequest('cuenta-invalida', 'Esa cuenta no existe o está desactivada.');
  }
  if (cuentaDestinoId && !cuentas.some((c) => c.id === cuentaDestinoId)) {
    throw ApiError.badRequest('cuenta-invalida', 'La cuenta de destino no existe o está desactivada.');
  }

  // Solo el TRASLADO exige saldo. La diferencia no es caprichosa:
  //
  //   · Un traslado es una INSTRUCCIÓN: mover plata de un bolsillo a otro. No
  //     se puede mover lo que no está, así que se rechaza y punto.
  //   · Un egreso —como un gasto— es el REGISTRO de algo que ya pasó. Si
  //     alguien ya sacó la plata, negarse a anotarlo no la devuelve: solo hace
  //     que los libros mientan más. Se anota, y si el saldo queda en negativo,
  //     ese número rojo ES la alarma: significa que falta registrar de dónde
  //     entró algo. Taparlo sería perder justamente la señal.
  //
  // Esta es también la razón de que `expenses` no valide saldo: un gasto ya
  // ocurrió cuando alguien lo escribe.
  if (tipo === 'traslado' && origen.saldo < monto) {
    throw ApiError.conflict(
      'saldo-insuficiente',
      `En "${origen.nombre}" hay ${origen.saldo} y estás trasladando ${monto}. ` +
        `No se puede mover plata que no está: registra primero de dónde entró.`,
    );
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO treasury_movements
       (id, tipo, cuenta_id, cuenta_destino_id, monto, concepto, tercero, referencia, creado_por)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, tipo, cuentaId, cuentaDestinoId, monto, concepto, tercero, referencia, user.sub)
    .run();

  return json({ movimiento: { id, tipo, cuentaId, cuentaDestinoId, monto, concepto } }, 201);
}

// ─────────────────────────── Turnos de cajero ───────────────────────────

/** El turno abierto de una cuenta, si lo hay. Solo puede haber uno. */
async function turnoAbierto(env: Env, cuentaId: string): Promise<Record<string, unknown> | null> {
  const fila = await env.DB.prepare(
    `SELECT id, referencia, cuenta_id AS cuentaId, cajero_nombre AS cajeroNombre,
            abierto_en AS abiertoEn, fondo_apertura AS fondoApertura
       FROM cashier_shifts
      WHERE cuenta_id = ?1 AND cerrado_en IS NULL
      ORDER BY abierto_en DESC LIMIT 1`,
  )
    .bind(cuentaId)
    .first<Record<string, unknown>>();

  return fila ?? null;
}

/**
 * Lo que debería haber en el cajón según el sistema.
 *
 * Fondo de apertura más todo lo que entró y salió de esa cuenta desde que se
 * abrió el turno. Se calcula sobre el mismo `MOVIMIENTOS_SQL` que el resto del
 * módulo: si el arqueo tuviera su propia cuenta aparte, el día que no cuadrara
 * nadie sabría si falta plata o si las dos consultas ya no dicen lo mismo.
 */
async function esperadoDelTurno(
  env: Env,
  turno: Record<string, unknown>,
): Promise<{ esperado: number; entra: number; sale: number; cobros: number }> {
  const fila = await env.DB.prepare(
    `SELECT COALESCE(SUM(entra), 0) AS entra,
            COALESCE(SUM(sale), 0)  AS sale,
            COUNT(*)                AS cobros
       FROM (${MOVIMIENTOS_SQL})
      WHERE cuentaId = ?1 AND fecha >= ?2`,
  )
    .bind(turno['cuentaId'], turno['abiertoEn'])
    .first<{ entra: number; sale: number; cobros: number }>();

  const entra = fila?.entra ?? 0;
  const sale = fila?.sale ?? 0;

  return {
    esperado: Number(turno['fondoApertura'] ?? 0) + entra - sale,
    entra,
    sale,
    cobros: fila?.cobros ?? 0,
  };
}

/** GET /api/admin/tesoreria/turno?cuenta= — el turno abierto y su arqueo. */
export async function turno(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const cuentaId = url.searchParams.get('cuenta') ?? 'caja-efectivo';
  const abierto = await turnoAbierto(env, cuentaId);

  if (!abierto) {
    const { results } = await env.DB.prepare(
      `SELECT id, referencia, cajero_nombre AS cajeroNombre, abierto_en AS abiertoEn,
              cerrado_en AS cerradoEn, fondo_apertura AS fondoApertura,
              efectivo_contado AS efectivoContado, efectivo_esperado AS efectivoEsperado,
              diferencia, notas, recibido_por_nombre AS recibidoPor
         FROM cashier_shifts
        WHERE cuenta_id = ?1 AND cerrado_en IS NOT NULL
        ORDER BY cerrado_en DESC LIMIT 10`,
    )
      .bind(cuentaId)
      .all();

    return json({ turno: null, historial: results });
  }

  const arqueo = await esperadoDelTurno(env, abierto);
  return json({ turno: { ...abierto, ...arqueo }, historial: [] });
}

/**
 * POST /api/admin/tesoreria/turno/abrir — empieza el turno.
 *
 * El fondo de apertura es lo que queda en el cajón para dar vueltas. No se
 * registra como un ingreso: no es plata que entró al negocio, es la misma que
 * quedó del turno anterior.
 */
export async function abrirTurno(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<{ cuentaId?: unknown; fondoApertura?: unknown }>(request);
  const cuentaId =
    body.cuentaId === undefined || body.cuentaId === null || body.cuentaId === ''
      ? 'caja-efectivo'
      : requireString(body.cuentaId, 'cuentaId', 64);
  const fondo = body.fondoApertura === undefined ? 0 : requireInt(body.fondoApertura, 'fondoApertura', 0);

  if (await turnoAbierto(env, cuentaId)) {
    throw ApiError.conflict(
      'turno-abierto',
      'Esa caja ya tiene un turno abierto. Ciérralo antes de abrir otro.',
    );
  }

  const id = crypto.randomUUID();

  // TRN-AAAAMMDD-N, con N contando TODOS los turnos del día, de cualquier caja.
  //
  // Contarlos por caja parece más ordenado y está mal: `referencia` es UNIQUE
  // a secas, no UNIQUE por cuenta. Con el contador por caja, el primer turno
  // del banco y el primero del cajón daban los dos «TRN-20260903-1» y el
  // segundo reventaba con un 500. La numeración es del día, no del cajón.
  try {
    await env.DB.prepare(
      `INSERT INTO cashier_shifts (id, referencia, cuenta_id, cajero_id, cajero_nombre, fondo_apertura)
       SELECT ?1,
              'TRN-' || strftime('%Y%m%d', ${HOY}) || '-' ||
                (SELECT COUNT(*) + 1 FROM cashier_shifts
                  WHERE date(abierto_en, '-5 hours') = ${HOY}),
              ?2, ?3, ?4, ?5`,
    )
      .bind(id, cuentaId, user.sub, user.nombre, fondo)
      .run();
  } catch (error) {
    // Dos aperturas en el mismo instante calculan el mismo N y una choca. Es
    // rarísimo, pero cuando pase tiene que decir qué hacer en vez de soltar un
    // «Ocurrió un error inesperado» delante del cajero.
    const mensaje = error instanceof Error ? error.message : String(error);
    if (mensaje.includes('UNIQUE constraint failed') && mensaje.includes('referencia')) {
      throw ApiError.conflict(
        'referencia-ocupada',
        'Alguien abrió otro turno en este mismo instante. Vuelve a intentarlo.',
      );
    }
    throw error;
  }

  const abierto = await turnoAbierto(env, cuentaId);
  return json({ turno: abierto }, 201);
}

/**
 * POST /api/admin/tesoreria/turno/cerrar — el arqueo y la entrega.
 *
 * Quien recibe el turno confirma con su usuario y su clave. Esa verificación es
 * lo que convierte la entrega en algo que dos personas firmaron: sin ella,
 * cualquiera podría cerrar un cajón que no contó y dejarle el faltante al
 * siguiente.
 *
 * La diferencia se guarda tal cual, sobre o falta. Un arqueo que solo admitiera
 * el cuadre exacto obligaría a maquillar la cifra, y entonces no serviría para
 * detectar nada.
 */
export async function cerrarTurno(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<{
    cuentaId?: unknown;
    efectivoContado?: unknown;
    vouchersContados?: unknown;
    notas?: unknown;
    recibeUsuario?: unknown;
    recibeClave?: unknown;
  }>(request);

  const cuentaId =
    body.cuentaId === undefined || body.cuentaId === null || body.cuentaId === ''
      ? 'caja-efectivo'
      : requireString(body.cuentaId, 'cuentaId', 64);

  const abierto = await turnoAbierto(env, cuentaId);
  if (!abierto) {
    throw ApiError.conflict('sin-turno', 'Esa caja no tiene ningún turno abierto.');
  }

  const contado = requireInt(body.efectivoContado, 'efectivoContado', 0);
  const vouchers = body.vouchersContados === undefined ? 0 : requireInt(body.vouchersContados, 'vouchersContados', 0);
  const notas =
    body.notas === undefined || body.notas === null || body.notas === ''
      ? null
      : requireString(body.notas, 'notas', 500);

  // Quién recibe. Se busca por correo y se verifica la clave: es el punto del
  // módulo donde alguien se hace responsable de una plata que va a contar otro.
  const correo = requireString(body.recibeUsuario, 'recibeUsuario', 160).toLowerCase();
  const clave = requireString(body.recibeClave, 'recibeClave', 200);

  const recibe = await env.DB.prepare(
    `SELECT id, nombre, password_hash AS hash FROM users WHERE LOWER(email) = ?1`,
  )
    .bind(correo)
    .first<{ id: string; nombre: string; hash: string }>();

  if (!recibe || !(await verifyPassword(clave, recibe.hash))) {
    // El mismo mensaje para "no existe" y "clave mala", como en el login: decir
    // cuál de las dos falló le regala información a quien esté probando.
    throw ApiError.badRequest(
      'entrega-no-confirmada',
      'El usuario o la clave de quien recibe el turno no coinciden.',
    );
  }

  const arqueo = await esperadoDelTurno(env, abierto);
  const diferencia = contado - arqueo.esperado;

  await env.DB.prepare(
    `UPDATE cashier_shifts
        SET cerrado_en = datetime('now'),
            efectivo_contado = ?2,
            vouchers_contados = ?3,
            efectivo_esperado = ?4,
            diferencia = ?5,
            notas = ?6,
            recibido_por = ?7,
            recibido_por_nombre = ?8
      WHERE id = ?1 AND cerrado_en IS NULL`,
  )
    .bind(
      abierto['id'],
      contado,
      vouchers,
      arqueo.esperado,
      diferencia,
      notas,
      recibe.id,
      recibe.nombre,
    )
    .run();

  return json({
    turno: {
      id: abierto['id'],
      referencia: abierto['referencia'],
      esperado: arqueo.esperado,
      contado,
      diferencia,
      recibidoPor: recibe.nombre,
    },
  });
}

/** GET /api/admin/tesoreria/cuentas — para los selectores de la pantalla. */
export async function cuentas(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');
  return json({ cuentas: await cuentasConSaldo(env) });
}

/**
 * GET /api/admin/tesoreria/devoluciones — notas crédito con plata sin salir.
 *
 * Es la pestaña «Devoluciones»: la cartera del cliente, pero al revés — no lo
 * que él debe, sino lo que el negocio le quedó debiendo a él. Se lista por
 * NOTA y no por factura, porque una factura puede tener varias notas (como en
 * el caso que originó esto: dos notas sobre la misma factura ya pagada) y
 * cada una se devuelve por separado, con su propia trazabilidad.
 */
export async function porDevolver(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { results } = await env.DB.prepare(
    `SELECT n.id, n.numero, n.total, n.monto_devuelto AS montoDevuelto,
            (n.total - n.monto_devuelto)   AS saldo,
            n.emitida_en                   AS emitidaEn,
            n.motivo_anulacion             AS motivo,
            n.contact_id                   AS contactId,
            n.cliente_nombre               AS clienteNombre,
            n.cliente_telefono             AS clienteTelefono,
            f.id                           AS facturaId,
            f.numero                       AS facturaNumero
       FROM invoices n
       JOIN invoices f ON f.id = n.invoice_origen_id
      WHERE n.tipo = 'nota_credito' AND n.estado <> 'anulada' AND n.total > n.monto_devuelto
      ORDER BY n.emitida_en`,
  ).all();

  return json({ devoluciones: results });
}

interface DevolucionBody {
  monto?: unknown;
  metodo?: unknown;
  observaciones?: unknown;
}

/**
 * Por dónde sale la plata de una devolución. Solo dos, igual que en los
 * abonos a una finca: lo que de verdad importa es de qué cuenta salió.
 */
function leerMetodoDevolucion(valor: unknown): 'efectivo' | 'transferencia' {
  return valor === 'transferencia' ? 'transferencia' : 'efectivo';
}

/**
 * POST /api/admin/tesoreria/devoluciones/:notaId — se le devuelve plata al
 * cliente por una nota crédito.
 *
 * Sin `monto` se devuelve todo lo que falta — igual que el «Pagar» de
 * Compras, que gira el saldo entero cuando no se le dice cuánto.
 *
 * Guardia de concurrencia idéntica a `purchases.markPaid()`: el INSERT lleva
 * su propia condición dentro del SELECT, así que dos clics a la vez no pueden
 * devolver de más; y la caché se RECALCULA desde `invoice_refunds`, nunca se
 * incrementa a ciegas.
 */
export async function registrarDevolucion(
  request: Request,
  env: Env,
  user: JwtPayload,
  notaId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<DevolucionBody>(request).catch(() => ({}) as DevolucionBody);

  const nota = await env.DB.prepare(
    `SELECT id, numero, tipo, estado, total, monto_devuelto AS montoDevuelto,
            cliente_nombre AS clienteNombre
       FROM invoices WHERE id = ?1`,
  )
    .bind(notaId)
    .first<{
      id: string;
      numero: string;
      tipo: string;
      estado: string;
      total: number;
      montoDevuelto: number;
      clienteNombre: string;
    }>();

  if (!nota) {
    throw ApiError.notFound('Esa nota crédito no existe.');
  }
  if (nota.tipo !== 'nota_credito') {
    throw ApiError.badRequest('origen-invalido', 'Solo se le registran devoluciones a una nota crédito.');
  }

  const saldo = nota.total - nota.montoDevuelto;
  if (nota.estado === 'anulada' || saldo <= 0) {
    throw ApiError.conflict('nada-que-devolver', 'Esta nota ya no tiene plata pendiente por devolver.');
  }

  const monto = body.monto === undefined || body.monto === null ? saldo : requireInt(body.monto, 'monto', 1);

  if (monto > saldo) {
    throw ApiError.badRequest(
      'devolucion-mayor-al-saldo',
      `A ${nota.clienteNombre} solo le falta ${saldo} por devolver de ${nota.numero}; no se puede devolver ${monto}.`,
    );
  }

  const metodo = leerMetodoDevolucion(body.metodo);
  const observaciones = optionalString(body.observaciones, 'observaciones', 200);
  // Deducida del método, igual que en cobros y abonos: efectivo sale del
  // cajón, transferencia del banco. No se pide aparte para que las dos nunca
  // puedan quedar diciendo cosas distintas.
  const cuentaId = metodo === 'efectivo' ? 'caja-efectivo' : 'cuenta-bancaria';

  const id = `ref-${crypto.randomUUID()}`;

  const [insertado] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoice_refunds (id, nota_credito_id, monto, metodo, cuenta_id, observaciones, devuelto_por)
       SELECT ?1, n.id, ?3, ?4, ?5, ?6, ?7
         FROM invoices n
        WHERE n.id = ?2
          AND n.tipo = 'nota_credito'
          AND n.estado <> 'anulada'
          AND n.monto_devuelto + ?3 <= n.total`,
    ).bind(id, notaId, monto, metodo, cuentaId, observaciones, user.sub),

    env.DB.prepare(
      `UPDATE invoices
          SET monto_devuelto = (SELECT COALESCE(SUM(monto), 0)
                                  FROM invoice_refunds WHERE nota_credito_id = ?1)
        WHERE id = ?1`,
    ).bind(notaId),
  ]);

  if (insertado.meta.changes === 0) {
    throw ApiError.conflict(
      'devolucion-rechazada',
      'Esa devolución ya no cabe en la nota. Vuelve a abrirla para ver cuánto falta.',
    );
  }

  const actualizada = await env.DB.prepare(
    `SELECT id, numero, total, monto_devuelto AS montoDevuelto, (total - monto_devuelto) AS saldo
       FROM invoices WHERE id = ?1`,
  )
    .bind(notaId)
    .first();

  return json({ nota: actualizada });
}
