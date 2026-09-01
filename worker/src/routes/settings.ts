import { ApiError, json, readJson, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Ajustes de operación — banderas que se cambian en vivo desde el panel.
 *
 * Clave-valor y no una columna por ajuste: son opciones de cómo se opera, no
 * entidades del negocio, y añadir la siguiente no puede costar una migración.
 *
 * La lista blanca de abajo no es burocracia: sin ella, este endpoint sería un
 * almacén de texto arbitrario donde cualquiera con sesión podría escribir lo
 * que quisiera, y nadie sabría al leer el código qué ajustes existen de verdad.
 */
const AJUSTES: Record<string, { descripcion: string; porDefecto: string }> = {
  pos_recibo_por_defecto: {
    descripcion: 'Si la caja marca "imprimir recibo" al abrir una venta nueva.',
    porDefecto: '1',
  },
};

/** Lee un ajuste con su valor por defecto si nadie lo ha tocado nunca. */
export async function leerAjuste(env: Env, clave: string): Promise<string> {
  const fila = await env.DB.prepare(`SELECT valor FROM app_settings WHERE clave = ?1`)
    .bind(clave)
    .first<{ valor: string }>();

  return fila?.valor ?? AJUSTES[clave]?.porDefecto ?? '';
}

/** GET /api/admin/settings — todos los ajustes conocidos, con su valor actual. */
export async function list(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS');

  const { results } = await env.DB.prepare(`SELECT clave, valor FROM app_settings`).all<{
    clave: string;
    valor: string;
  }>();

  const guardados = new Map(results.map((r) => [r.clave, r.valor]));

  // Se responde la lista completa de ajustes conocidos, no solo los que tienen
  // fila: así el panel puede pintar uno recién añadido sin que nadie lo haya
  // guardado todavía.
  const ajustes = Object.entries(AJUSTES).map(([clave, meta]) => ({
    clave,
    descripcion: meta.descripcion,
    valor: guardados.get(clave) ?? meta.porDefecto,
  }));

  return json({ ajustes });
}

/**
 * PUT /api/admin/settings — cambia un ajuste.
 *
 * `SUPER_ADMIN`: esto cambia cómo se comporta el sistema para todo el mundo, no
 * es una preferencia personal de quien está en la caja.
 */
export async function update(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const body = await readJson<{ clave?: unknown; valor?: unknown }>(request);
  const clave = requireString(body.clave, 'clave', 60);
  const valor = requireString(body.valor, 'valor', 500);

  if (!(clave in AJUSTES)) {
    throw ApiError.badRequest('ajuste-desconocido', `No existe un ajuste llamado "${clave}".`);
  }

  await env.DB.prepare(
    `INSERT INTO app_settings (clave, valor, actualizado_en)
     VALUES (?1, ?2, datetime('now'))
     ON CONFLICT (clave) DO UPDATE SET valor = ?2, actualizado_en = datetime('now')`,
  )
    .bind(clave, valor)
    .run();

  return json({ clave, valor });
}
