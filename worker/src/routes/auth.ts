import { ApiError, json, readJson, requireString } from '../http';
import { Env, JwtPayload, UserRole } from '../types';
import { signJwt, verifyPassword } from '../auth/crypto';

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

interface UserRow {
  id: string;
  email: string;
  nombre: string;
  password_hash: string;
  roles: string | null;
}

/**
 * POST /api/auth/login
 *
 * Devuelve un JWT firmado de verdad. Con esto el frontend deja de fabricarse
 * su propia sesión: el token solo puede emitirlo quien conoce JWT_SECRET.
 */
export async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<LoginBody>(request);
  const email = requireString(body.email, 'email', 200).toLowerCase();
  const password = requireString(body.password, 'password', 200);

  // group_concat evita una segunda consulta para los roles.
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.nombre, u.password_hash,
            (SELECT group_concat(r.role) FROM user_roles r WHERE r.user_id = u.id) AS roles
       FROM users u
      WHERE u.email = ?1 AND u.activo = 1`,
  )
    .bind(email)
    .first<UserRow>();

  // Mismo error y mismo coste para "no existe" que para "clave incorrecta":
  // responder distinto permitiría enumerar qué correos están registrados.
  if (!user) {
    // Se gasta el tiempo de un PBKDF2 igualmente para no delatar por latencia.
    await verifyPassword(password, 'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    throw ApiError.unauthorized('Correo o contraseña incorrectos.');
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw ApiError.unauthorized('Correo o contraseña incorrectos.');
  }

  const roles = (user.roles?.split(',') ?? []) as UserRole[];
  const { token, expiresAt } = await signJwt(
    { sub: user.id, email: user.email, nombre: user.nombre, roles },
    env.JWT_SECRET,
  );

  return json({
    token,
    expiresAt,
    user: { id: user.id, email: user.email, nombre: user.nombre, roles },
  });
}

/** GET /api/auth/me — confirma que el token sigue vivo y devuelve el perfil. */
export function me(user: JwtPayload): Response {
  return json({
    user: { id: user.sub, email: user.email, nombre: user.nombre, roles: user.roles },
    expiresAt: user.exp * 1000,
  });
}
