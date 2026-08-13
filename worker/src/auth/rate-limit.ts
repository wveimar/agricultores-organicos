import { ApiError } from '../http';
import { Env } from '../types';

/**
 * Intentos fallidos consecutivos antes de bloquear.
 *
 * Ocho es holgado para quien de verdad no recuerda su contraseña —el panel lo
 * usan tres personas— y estrecho para un diccionario. Con la ventana de 15
 * minutos, un atacante consigue 32 intentos por hora y por combinación de
 * correo e IP: a ese ritmo, probar un diccionario corto lleva años.
 */
const MAX_INTENTOS = 8;
const VENTANA_MINUTOS = 15;

/**
 * Se cuenta por IP y por la pareja correo+IP. **No** por correo suelto.
 *
 * Contar por correo a secas parecía lo obvio y es una trampa: cualquiera que
 * sepa `admin@agricultores.co` puede fallar ocho veces y dejar al dueño del
 * negocio fuera de su propio panel, repitiéndolo indefinidamente. Se cambia un
 * ataque de fuerza bruta —caro y ruidoso— por uno de denegación de servicio
 * que sale gratis. Lo detectó la prueba de `qa-fuerza-bruta.mjs`, donde la
 * cuenta legítima quedaba bloqueada por los fallos de otra.
 *
 * Con estas dos claves, quien machaca desde una IP se bloquea a sí mismo y el
 * administrador, que entra desde otra, no se entera. La contrapartida honesta:
 * un ataque repartido entre muchas IP contra una sola cuenta tarda más en
 * frenarse. Para un panel de tres personas con contraseñas largas, ese riesgo
 * es menor que el de quedarse fuera en plena jornada.
 */
function claves(email: string, ip: string): readonly string[] {
  return [`ip:${ip}`, `par:${email.toLowerCase()}|${ip}`];
}

/** La IP real del visitante la pone Cloudflare; en local no existe. */
export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'local';
}

/**
 * Corta el paso si se acumulan demasiados fallos recientes.
 *
 * Va **antes** de verificar la contraseña, no después: el PBKDF2 es lo caro
 * (~1 s de CPU del Worker), y comprobarlo primero significaría pagarlo en cada
 * intento del atacante.
 */
export async function assertLoginAllowed(env: Env, email: string, ip: string): Promise<void> {
  const lista = claves(email, ip);
  const marcadores = lista.map((_, i) => `?${i + 1}`).join(', ');

  const fila = await env.DB.prepare(
    `SELECT MAX(intentos) AS intentos
       FROM login_attempts
      WHERE clave IN (${marcadores})
        AND ultimo_en > datetime('now', '-${VENTANA_MINUTOS} minutes')`,
  )
    .bind(...lista)
    .first<{ intentos: number | null }>();

  if ((fila?.intentos ?? 0) >= MAX_INTENTOS) {
    throw new ApiError(
      429,
      'demasiados-intentos',
      `Demasiados intentos fallidos. Espera ${VENTANA_MINUTOS} minutos y vuelve a probar.`,
    );
  }
}

/**
 * Suma un fallo a las dos claves.
 *
 * El `ON CONFLICT` reinicia la cuenta si el último fallo quedó fuera de la
 * ventana: si no, alguien que falla una vez al mes acabaría bloqueado al
 * octavo mes.
 */
export async function registerFailedLogin(env: Env, email: string, ip: string): Promise<void> {
  await env.DB.batch(
    claves(email, ip).map((clave) =>
      env.DB.prepare(
        `INSERT INTO login_attempts (clave, intentos, ultimo_en)
         VALUES (?1, 1, datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET
           intentos = CASE
                        WHEN login_attempts.ultimo_en > datetime('now', '-${VENTANA_MINUTOS} minutes')
                        THEN login_attempts.intentos + 1
                        ELSE 1
                      END,
           ultimo_en = datetime('now')`,
      ).bind(clave),
    ),
  );
}

/** Al entrar bien se borra el contador: la fila solo vive mientras se falla. */
export async function clearLoginAttempts(env: Env, email: string, ip: string): Promise<void> {
  const lista = claves(email, ip);
  const marcadores = lista.map((_, i) => `?${i + 1}`).join(', ');
  await env.DB.prepare(`DELETE FROM login_attempts WHERE clave IN (${marcadores})`)
    .bind(...lista)
    .run();
}

// ─────────────────── Recuperación de contraseña ───────────────────

/**
 * Pedir un enlace de recuperación manda un correo a otra persona, así que el
 * tope es más estrecho que el del login: sin él, cualquiera puede llenar de
 * correos la bandeja de un administrador escribiendo su dirección en bucle, y
 * de paso quemar la cuota del proveedor de envío.
 *
 * Se cuenta solo por IP. Contar por correo dejaría a la víctima sin poder
 * recuperar su propia cuenta, que es la misma trampa que ya se corrigió en el
 * contador del login.
 */
const MAX_RECUPERACIONES = 5;
const VENTANA_RECUPERACION_MINUTOS = 60;

export async function assertRecoveryAllowed(env: Env, ip: string): Promise<void> {
  const fila = await env.DB.prepare(
    `SELECT intentos FROM login_attempts
      WHERE clave = ?1
        AND ultimo_en > datetime('now', '-${VENTANA_RECUPERACION_MINUTOS} minutes')`,
  )
    .bind(`recuperar:${ip}`)
    .first<{ intentos: number }>();

  if ((fila?.intentos ?? 0) >= MAX_RECUPERACIONES) {
    throw new ApiError(
      429,
      'demasiadas-recuperaciones',
      'Ya se pidieron varios enlaces de recuperación desde aquí. Espera un rato antes de volver a intentarlo.',
    );
  }
}

export async function registerRecoveryRequest(env: Env, ip: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_attempts (clave, intentos, ultimo_en)
     VALUES (?1, 1, datetime('now'))
     ON CONFLICT(clave) DO UPDATE SET
       intentos = CASE
                    WHEN login_attempts.ultimo_en > datetime('now', '-${VENTANA_RECUPERACION_MINUTOS} minutes')
                    THEN login_attempts.intentos + 1
                    ELSE 1
                  END,
       ultimo_en = datetime('now')`,
  )
    .bind(`recuperar:${ip}`)
    .run();
}
