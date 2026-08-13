import { ApiError, json, readJson, requireString } from '../http';
import { Env } from '../types';
import { hashPassword } from '../auth/crypto';
import {
  assertRecoveryAllowed,
  clientIp,
  registerRecoveryRequest,
} from '../auth/rate-limit';
import { correoDeRecuperacion, enviarCorreo } from '../auth/email';

/** Vida del enlace. Corta: es una llave que viaja por correo. */
const MINUTOS_VALIDEZ = 60;
const MIN_PASSWORD = 8;

/**
 * Huella del token para guardarlo.
 *
 * SHA-256 a secas y no PBKDF2 como en las contraseñas, a propósito: el token
 * son 32 bytes aleatorios, así que no hay diccionario que probar y el trabajo
 * extra no compraría nada. Lo que importa es que en la base no quede el valor
 * con el que se puede entrar.
 */
async function huella(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /api/auth/recuperar — pide un enlace para restablecer la contraseña.
 *
 * **Responde 200 exista o no la cuenta.** Es lo que impide usar este endpoint
 * como censo de correos registrados: si contestara distinto, cualquiera podría
 * ir probando direcciones hasta dar con las que existen, que es el primer paso
 * de un ataque dirigido. Por el mismo motivo tampoco se cuenta si el correo se
 * envió de verdad.
 */
export async function requestReset(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ email?: unknown }>(request);
  const email = requireString(body.email, 'email', 200).toLowerCase().trim();
  const ip = clientIp(request);

  await assertRecoveryAllowed(env, ip);
  await registerRecoveryRequest(env, ip);

  const user = await env.DB.prepare(
    `SELECT id, nombre, email FROM users WHERE email = ?1 AND activo = 1`,
  )
    .bind(email)
    .first<{ id: string; nombre: string; email: string }>();

  if (user) {
    // Un token por petición, y los anteriores de esa cuenta dejan de valer:
    // pedir un enlace nuevo tiene que invalidar el viejo, o quien interceptó
    // el primero seguiría teniendo una llave buena.
    const token = crypto.getRandomValues(new Uint8Array(32));
    const plano = btoa(String.fromCharCode(...token))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM password_resets WHERE user_id = ?1`).bind(user.id),
      env.DB.prepare(
        `INSERT INTO password_resets (token_hash, user_id, expira_en)
         VALUES (?1, ?2, datetime('now', '+${MINUTOS_VALIDEZ} minutes'))`,
      ).bind(await huella(plano), user.id),
    ]);

    // El origen sale de la propia petición: así el enlace apunta al dominio
    // por el que entró el usuario, sin una variable de entorno más que
    // mantener y que se quedaría vieja al cambiar de dominio.
    const origen = new URL(request.url).origin;
    const enlace = `${origen}/admin/restablecer?token=${plano}`;

    const plantilla = correoDeRecuperacion(user.nombre, enlace, MINUTOS_VALIDEZ);
    const envio = await enviarCorreo(env, { ...plantilla, para: user.email });

    if (!envio.enviado) {
      // El enlace acaba en los logs del Worker, que solo ve quien tiene la
      // cuenta de Cloudflare. Es una salida de emergencia mientras no haya
      // proveedor de correo configurado: sin esto, un administrador que olvide
      // su contraseña y sea el único SUPER_ADMIN se queda fuera para siempre.
      console.warn(
        `[recuperacion] No se pudo enviar (${envio.motivo}). Enlace para ${user.email}: ${enlace}`,
      );
    }
  }

  return json({ ok: true });
}

/**
 * POST /api/auth/restablecer — cambia la contraseña con el token del correo.
 */
export async function performReset(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ token?: unknown; nueva?: unknown }>(request);
  const token = requireString(body.token, 'token', 200);
  const nueva = requireString(body.nueva, 'nueva', 200);

  if (nueva.length < MIN_PASSWORD) {
    throw ApiError.badRequest(
      'password-corta',
      `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`,
    );
  }

  const fila = await env.DB.prepare(
    `SELECT r.token_hash, r.user_id, r.usado_en,
            (r.expira_en > datetime('now')) AS vigente,
            u.email
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ?1 AND u.activo = 1`,
  )
    .bind(await huella(token))
    .first<{ token_hash: string; user_id: string; usado_en: string | null; vigente: number; email: string }>();

  // Un solo mensaje para "no existe", "ya se usó" y "caducó": distinguirlos
  // le diría a quien prueba tokens al azar cuándo ha acertado uno.
  if (!fila || fila.usado_en !== null || fila.vigente !== 1) {
    throw ApiError.badRequest(
      'enlace-invalido',
      'Este enlace ya no sirve. Pide uno nuevo desde la pantalla de entrada.',
    );
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_hash = ?2 WHERE id = ?1`).bind(
      fila.user_id,
      await hashPassword(nueva),
    ),
    // Se marca usado y se retiran los demás enlaces de esa cuenta en el mismo
    // todo-o-nada que el cambio: si el UPDATE de arriba fallara, el enlace
    // tiene que seguir sirviendo.
    env.DB.prepare(`UPDATE password_resets SET usado_en = datetime('now') WHERE token_hash = ?1`)
      .bind(fila.token_hash),
    env.DB.prepare(`DELETE FROM password_resets WHERE user_id = ?1 AND token_hash != ?2`)
      .bind(fila.user_id, fila.token_hash),
    // Quien llega aquí probablemente venía de fallar varias veces al entrar.
    // Dejarle el contador puesto sería devolverle la contraseña y aun así
    // bloquearle la puerta.
    env.DB.prepare(`DELETE FROM login_attempts WHERE clave LIKE ?1`).bind(
      `par:${fila.email}|%`,
    ),
  ]);

  return json({ ok: true });
}
