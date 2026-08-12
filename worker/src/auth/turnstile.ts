import { ApiError } from '../http';
import { Env } from '../types';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Valida el token de Turnstile contra Cloudflare.
 *
 * Sin esta llamada el widget es decoración: vive entero en el navegador, y
 * enviar el formulario con `curl` lo salta sin enterarse. La verificación solo
 * cuenta si la hace el servidor, que es quien conoce la clave secreta.
 *
 * ── Cuándo se aplica ──
 *
 * Si `TURNSTILE_SECRET` no está configurado, se omite. Es deliberado, y la
 * alternativa era peor: exigirlo siempre dejaría el panel inaccesible en
 * cuanto alguien despliegue sin haber puesto el secreto todavía, incluido el
 * desarrollo local. Configurarlo es un comando:
 *
 *   npx wrangler secret put TURNSTILE_SECRET
 *
 * En cuanto existe, la verificación pasa a ser obligatoria y un login sin
 * token válido responde 403. No hay término medio: o está configurado y se
 * exige, o no lo está y se registra que no se está exigiendo.
 */
export async function verifyTurnstile(
  env: Env,
  token: unknown,
  ip: string,
): Promise<void> {
  const secreto = env.TURNSTILE_SECRET;

  if (!secreto) {
    console.warn(
      'TURNSTILE_SECRET no configurado: el login acepta peticiones sin verificación anti-bots.',
    );
    return;
  }

  if (typeof token !== 'string' || token.trim() === '') {
    throw ApiError.forbidden('Falta la verificación anti-bots.');
  }

  const cuerpo = new FormData();
  cuerpo.append('secret', secreto);
  cuerpo.append('response', token);
  if (ip !== 'local') {
    cuerpo.append('remoteip', ip);
  }

  let resultado: { success?: boolean; 'error-codes'?: string[] };
  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: cuerpo });
    resultado = await res.json();
  } catch {
    // Si Cloudflare no responde se falla cerrado. Dejar pasar ante un fallo de
    // red convertiría la protección en algo que se apaga tirando del cable.
    throw ApiError.forbidden('No se pudo verificar el desafío anti-bots. Inténtalo de nuevo.');
  }

  if (!resultado.success) {
    throw ApiError.forbidden('La verificación anti-bots no fue válida. Recarga e inténtalo de nuevo.');
  }
}
