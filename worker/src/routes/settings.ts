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
  // Los cuatro interruptores del negocio (plan de modularización). Por
  // defecto en '1': una instalación existente que nunca los toca sigue
  // funcionando exactamente igual que antes de que existieran.
  modulo_pos: {
    descripcion: 'Vender de mostrador desde la Caja.',
    porDefecto: '1',
  },
  modulo_ecommerce: {
    descripcion: 'La tienda pública y su checkout.',
    porDefecto: '1',
  },
  modulo_entregas: {
    descripcion: 'Domicilios: dirección de envío, domiciliario, "enviado".',
    porDefecto: '1',
  },
  modulo_tesoreria: {
    descripcion: 'Caja, movimientos, turnos y cierre.',
    porDefecto: '1',
  },
};

/** Los dos módulos que venden — al menos uno tiene que seguir encendido. */
const CANALES_DE_VENTA = ['modulo_pos', 'modulo_ecommerce'] as const;

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

  // Apagar POS o E-commerce no puede dejar el negocio sin ningún canal de
  // venta: ese estado no tiene con qué generar un pedido, y arrastraría a
  // Entregas y Tesorería a quedarse sin nada que mostrar tampoco. Se valida
  // aquí, contra lo que ya está guardado, no contra lo que el cliente cree
  // que hay — la misma razón por la que el resto del proyecto recalcula en
  // vez de confiar en lo que llega del navegador.
  if ((CANALES_DE_VENTA as readonly string[]).includes(clave) && valor === '0') {
    const otroCanal = CANALES_DE_VENTA.find((c) => c !== clave)!;
    const otroValor = await leerAjuste(env, otroCanal);
    if (otroValor === '0') {
      throw ApiError.conflict(
        'sin-canal-de-venta',
        'POS y E-commerce no se pueden apagar los dos a la vez: el negocio se quedaría sin ninguna forma de vender.',
      );
    }
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
