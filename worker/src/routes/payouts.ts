import { ApiError, json } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Cuentas por pagar a las fincas.
 *
 * Las filas no se crean aquí: las escribe `closeCash()` en el mismo batch que
 * congela la jornada (ver `calcularPagosAFincas()` en reports.ts). Este módulo
 * solo las lee y las marca pagadas — el reparto es una consecuencia del
 * cierre, no algo que alguien teclee después.
 */

/**
 * GET /api/admin/payouts — lo que se le debe a cada finca.
 *
 * Sin parámetros trae lo pendiente de todas las jornadas, que es la pregunta
 * de "¿a quién le debo?". Con `closing_id=<id>` trae el reparto completo de
 * esa jornada, pagados incluidos, que es la de "¿qué pasó con este cierre?".
 *
 * `estado=pendiente` va como filtro aparte y no como dos endpoints porque la
 * pantalla alterna entre las dos vistas sin cambiar de ruta.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const closingId = url.searchParams.get('closing_id');
  const soloPendientes = url.searchParams.get('estado') === 'pendiente';

  const filtros: string[] = [];
  const bindings: unknown[] = [];

  if (closingId) {
    bindings.push(closingId);
    filtros.push(`p.closing_id = ?${bindings.length}`);
  }
  if (soloPendientes) {
    filtros.push(`p.estado = 'pendiente'`);
  }

  const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  // Se une con `cash_closings` para traer la referencia y la fecha de la
  // jornada: sin ellas, una lista de fincas y montos no dice de qué semana
  // es, que es justo lo que hay que saber antes de girar.
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.origen, p.monto_pago AS montoPago, p.estado,
            p.closing_id AS closingId, p.pagado_en AS pagadoEn,
            u.nombre AS pagadoPor,
            c.referencia AS closingReferencia, c.cerrado_en AS closingCerradoEn
       FROM provider_payouts p
       JOIN cash_closings c ON c.id = p.closing_id
       LEFT JOIN users u ON u.id = p.pagado_por
       ${where}
      ORDER BY c.cerrado_en DESC, p.monto_pago DESC`,
  )
    .bind(...bindings)
    .all();

  return json({ pagos: results });
}

/**
 * POST /api/admin/payouts/:id/pagar — se le giró a la finca.
 *
 * Mismo patrón que markPaid()/settleCash() en orders.ts: una sola columna
 * cambia y la guardia va dentro del UPDATE, no en un SELECT previo. Sin token
 * de idempotencia porque no mueve stock ni dinero de nadie más — dos clics
 * simultáneos hacen que el segundo afecte 0 filas y ahí muere.
 *
 * No hay vuelta atrás a 'pendiente' a propósito: si se marcó por error, es un
 * problema de contabilidad que se arregla mirando el giro real, no
 * destapando la fila y volviéndola a cerrar sin dejar rastro.
 */
export async function markPaid(
  env: Env,
  user: JwtPayload,
  payoutId: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const result = await env.DB.prepare(
    `UPDATE provider_payouts
        SET estado = 'pagado', pagado_por = ?2, pagado_en = datetime('now')
      WHERE id = ?1 AND estado = 'pendiente'`,
  )
    .bind(payoutId, user.sub)
    .run();

  if (result.meta.changes === 0) {
    const actual = await env.DB.prepare(
      `SELECT estado FROM provider_payouts WHERE id = ?1`,
    )
      .bind(payoutId)
      .first<{ estado: string }>();

    if (!actual) {
      throw ApiError.notFound('Ese pago a finca no existe.');
    }
    throw ApiError.conflict(
      'ya-pagado',
      'Este pago ya estaba marcado como girado por otra persona.',
    );
  }

  const pago = await env.DB.prepare(
    `SELECT p.id, p.origen, p.monto_pago AS montoPago, p.estado,
            p.closing_id AS closingId, p.pagado_en AS pagadoEn,
            u.nombre AS pagadoPor,
            c.referencia AS closingReferencia, c.cerrado_en AS closingCerradoEn
       FROM provider_payouts p
       JOIN cash_closings c ON c.id = p.closing_id
       LEFT JOIN users u ON u.id = p.pagado_por
      WHERE p.id = ?1`,
  )
    .bind(payoutId)
    .first();

  return json({ pago });
}
