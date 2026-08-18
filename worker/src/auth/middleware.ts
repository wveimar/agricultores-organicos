import { ApiError } from '../http';
import { Env, JwtPayload, UserRole } from '../types';
import { verifyJwt } from './crypto';

/**
 * Extrae y verifica el JWT del encabezado Authorization.
 *
 * Corre en el nodo edge más cercano al usuario y no toca D1: la verificación
 * es puramente criptográfica sobre el token. Por eso las rutas protegidas no
 * pagan una consulta extra a la base solo para saber quién eres.
 *
 * La contrapartida honesta: si a un usuario se le revoca un rol, su token
 * sigue siendo válido hasta que expire (8 h). Para revocación inmediata haría
 * falta una lista de sesiones en KV, consultada en cada petición.
 */
export async function requireAuth(request: Request, env: Env): Promise<JwtPayload> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized();
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw ApiError.unauthorized();
  }

  return verifyJwt(token, env.JWT_SECRET);
}

/**
 * Igual que `requireAuth`, pero devuelve `null` en vez de rechazar.
 *
 * Para la tienda, que se compra sin cuenta. Un token ausente o inválido no es
 * un error —es una compra de invitado—, así que se sigue adelante sin sesión.
 * Lo importante es que un token **manipulado** tampoco pase por bueno: si la
 * firma no cuadra, `verifyJwt` lanza y aquí se traduce a "sin sesión", nunca a
 * "sesión con los roles que venían escritos dentro".
 */
export async function optionalAuth(request: Request, env: Env): Promise<JwtPayload | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }

  try {
    return await verifyJwt(token, env.JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * SUPER_ADMIN abre cualquier puerta; el resto necesita el rol exacto.
 * Es la misma regla que aplica el frontend, escrita una sola vez aquí, que es
 * donde de verdad se decide.
 */
export function hasRole(user: JwtPayload, allowed: readonly UserRole[]): boolean {
  if (user.roles.includes('SUPER_ADMIN')) {
    return true;
  }
  return allowed.some((role) => user.roles.includes(role));
}

export function requireRole(user: JwtPayload, ...allowed: readonly UserRole[]): void {
  if (!hasRole(user, allowed)) {
    throw ApiError.forbidden(
      `Esta acción requiere uno de estos roles: ${allowed.join(', ')}.`,
    );
  }
}
