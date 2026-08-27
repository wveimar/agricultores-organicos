import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Gastos operativos de la jornada: transporte, empaque, servicios.
 *
 * Un gasto nace huérfano (`closing_id IS NULL`) y el cierre de caja lo adopta,
 * exactamente como hace `orders.closing_id` con los pedidos. Esa es toda la
 * mecánica: no hay estados ni aprobaciones, porque un gasto no es una
 * transacción con un tercero que pueda fallar a medias — es una anotación de
 * plata que ya salió.
 *
 * ── Por qué solo GESTOR_PEDIDOS ──
 *
 * Un gasto entra directo en `ganancia` del cierre. Quien puede moverlo es
 * quien ya responde por la caja, el mismo rol que cierra la jornada y que
 * cobra la cartera. ADMIN_INVENTARIO maneja catálogo y stock, que es otra
 * cosa: darle esto sería darle la contabilidad sin pedirlo.
 */

/** Las cuatro del CHECK de la tabla. Fuera de esta lista, D1 lo rechazaría. */
const CATEGORIAS = ['transporte', 'empaque', 'servicios', 'otros'] as const;
type Categoria = (typeof CATEGORIAS)[number];

function requireCategoria(value: unknown): Categoria {
  const categoria = requireString(value, 'categoria', 20);
  if (!CATEGORIAS.includes(categoria as Categoria)) {
    throw ApiError.badRequest(
      'categoria-invalida',
      `"categoria" debe ser una de: ${CATEGORIAS.join(', ')}.`,
    );
  }
  return categoria as Categoria;
}

/**
 * GET /api/admin/expenses — gastos de un cierre, o los de la jornada abierta.
 *
 * Sin `closing_id` devuelve los huérfanos, que son los que todavía se pueden
 * borrar y los que entrarán al próximo cierre. Con `closing_id=<id>` devuelve
 * los ya archivados en ese cierre, para poder auditar de dónde salió su
 * `total_gastos`.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const closingId = url.searchParams.get('closing_id');

  // Dos consultas y no una con OR: `closing_id = ?` y `closing_id IS NULL` no
  // se pueden expresar con el mismo parámetro en SQL — NULL nunca es igual a
  // nada, ni siquiera a sí mismo.
  const statement = closingId
    ? env.DB.prepare(
        `SELECT e.id, e.descripcion, e.monto, e.categoria, e.creado_en AS creadoEn,
                e.closing_id AS closingId, u.nombre AS creadoPor
           FROM expenses e
           LEFT JOIN users u ON u.id = e.creado_por
          WHERE e.closing_id = ?1
          ORDER BY e.creado_en DESC`,
      ).bind(closingId)
    : env.DB.prepare(
        `SELECT e.id, e.descripcion, e.monto, e.categoria, e.creado_en AS creadoEn,
                e.closing_id AS closingId, u.nombre AS creadoPor
           FROM expenses e
           LEFT JOIN users u ON u.id = e.creado_por
          WHERE e.closing_id IS NULL
          ORDER BY e.creado_en DESC`,
      );

  const { results } = await statement.all();

  return json({ gastos: results });
}

/** POST /api/admin/expenses — registra un gasto en la jornada abierta. */
export async function create(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const body = await readJson<{ descripcion?: unknown; monto?: unknown; categoria?: unknown }>(
    request,
  );
  const descripcion = requireString(body.descripcion, 'descripcion', 200);
  // Mínimo 1: el CHECK de la tabla exige > 0 y es mejor decirlo aquí, donde
  // el mensaje puede explicar por qué, que dejar que D1 devuelva un 500 opaco.
  const monto = requireInt(body.monto, 'monto', 1);
  const categoria = requireCategoria(body.categoria);

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO expenses (id, descripcion, monto, categoria, creado_por)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, descripcion, monto, categoria, user.sub)
    .run();

  const gasto = await env.DB.prepare(
    `SELECT e.id, e.descripcion, e.monto, e.categoria, e.creado_en AS creadoEn,
            e.closing_id AS closingId, u.nombre AS creadoPor
       FROM expenses e
       LEFT JOIN users u ON u.id = e.creado_por
      WHERE e.id = ?1`,
  )
    .bind(id)
    .first();

  return json({ gasto }, 201);
}

/**
 * DELETE /api/admin/expenses/:id — borra un gasto de la jornada abierta.
 *
 * El `WHERE closing_id IS NULL` es la regla, no una comprobación previa: un
 * gasto ya archivado forma parte de un `total_gastos` congelado y de la
 * `ganancia` que se reportó ese día. Borrarlo dejaría el cierre diciendo una
 * cifra que sus propias líneas ya no sustentan.
 *
 * Va en el UPDATE y no en un SELECT-y-luego-DELETE porque entre las dos
 * sentencias cabe un cierre de caja: quien borra vería "todavía es huérfano" y
 * el DELETE se llevaría un gasto que acaba de entrar en una cuenta cerrada.
 */
export async function remove(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const result = await env.DB.prepare(
    `DELETE FROM expenses WHERE id = ?1 AND closing_id IS NULL`,
  )
    .bind(id)
    .run();

  if (result.meta.changes === 0) {
    const existe = await env.DB.prepare(`SELECT closing_id FROM expenses WHERE id = ?1`)
      .bind(id)
      .first<{ closing_id: string | null }>();

    if (!existe) {
      throw ApiError.notFound('Ese gasto no existe.');
    }
    throw ApiError.conflict(
      'gasto-cerrado',
      'Este gasto ya entró en un cierre de caja y no se puede borrar.',
    );
  }

  return json({ ok: true });
}
