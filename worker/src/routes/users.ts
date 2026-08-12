import { ApiError, json, readJson, requireString } from '../http';
import { Env, JwtPayload, UserRole, ALL_ROLES } from '../types';
import { requireRole } from '../auth/middleware';
import { hashPassword, verifyPassword } from '../auth/crypto';

/**
 * Columnas que se devuelven. `password_hash` **nunca** sale de aquí: no hace
 * falta para nada en el panel, y un hash filtrado es un hash que alguien puede
 * atacar sin límite de intentos y sin dejar rastro.
 */
const USER_COLUMNS = `
  u.id, u.email, u.nombre, u.activo, u.creado_en AS creadoEn,
  (SELECT group_concat(r.role) FROM user_roles r WHERE r.user_id = u.id) AS roles
`;

/** Mínimo de la contraseña. Coincide con lo que ya exige el formulario de login. */
const MIN_PASSWORD = 8;

interface UserRow {
  id: string;
  email: string;
  nombre: string;
  activo: number;
  creadoEn: string;
  roles: string | null;
}

const toUser = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  nombre: row.nombre,
  activo: row.activo,
  creadoEn: row.creadoEn,
  roles: (row.roles?.split(',') ?? []) as UserRole[],
});

function validarPassword(value: unknown, campo: string): string {
  const password = requireString(value, campo, 200);
  if (password.length < MIN_PASSWORD) {
    throw ApiError.badRequest(
      'password-corta',
      `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`,
    );
  }
  return password;
}

function validarRoles(value: unknown): UserRole[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest('roles-requeridos', 'Asigna al menos un rol.');
  }
  const roles = value.filter((r): r is UserRole => ALL_ROLES.includes(r as UserRole));
  if (roles.length !== value.length) {
    throw ApiError.badRequest('rol-invalido', `Los roles válidos son: ${ALL_ROLES.join(', ')}.`);
  }
  return [...new Set(roles)];
}

/**
 * Cuenta los SUPER_ADMIN activos que quedarían si se excluye a `exceptoId`.
 *
 * Se usa antes de desactivar a alguien o de quitarle el rol: quedarse sin
 * ningún SUPER_ADMIN activo deja el sistema sin nadie que pueda crear
 * usuarios, y no hay forma de arreglarlo desde el panel. Habría que entrar a
 * la base de datos a mano.
 */
async function otrosSuperAdmins(env: Env, exceptoId: string): Promise<number> {
  const fila = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM users u
       JOIN user_roles r ON r.user_id = u.id
      WHERE r.role = 'SUPER_ADMIN' AND u.activo = 1 AND u.id != ?1`,
  )
    .bind(exceptoId)
    .first<{ n: number }>();
  return fila?.n ?? 0;
}

/** GET /api/admin/users — solo para SUPER_ADMIN. */
export async function list(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const { results } = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users u ORDER BY u.activo DESC, u.nombre COLLATE NOCASE`,
  ).all<UserRow>();

  return json({ users: results.map(toUser) });
}

interface CreateBody {
  email?: unknown;
  nombre?: unknown;
  password?: unknown;
  roles?: unknown;
}

/** POST /api/admin/users — alta de una cuenta del panel. */
export async function create(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const body = await readJson<CreateBody>(request);
  const email = requireString(body.email, 'email', 200).toLowerCase().trim();
  const nombre = requireString(body.nombre, 'nombre', 120).trim();
  const password = validarPassword(body.password, 'password');
  const roles = validarRoles(body.roles);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw ApiError.badRequest('email-invalido', 'Escribe un correo con formato válido.');
  }

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);

  try {
    // Usuario y roles en el mismo batch: una cuenta sin roles no puede entrar
    // a ninguna pantalla, y quedaría ahí ocupando el correo sin servir de nada.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, nombre, password_hash) VALUES (?1, ?2, ?3, ?4)`,
      ).bind(id, email, nombre, hash),
      ...roles.map((role) =>
        env.DB.prepare(`INSERT INTO user_roles (user_id, role) VALUES (?1, ?2)`).bind(id, role),
      ),
    ]);
  } catch (error) {
    if ((error as Error).message.includes('UNIQUE constraint failed: users.email')) {
      throw ApiError.badRequest('email-duplicado', 'Ya existe una cuenta con ese correo.');
    }
    throw error;
  }

  const creado = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`)
    .bind(id)
    .first<UserRow>();

  return json({ user: toUser(creado!) }, 201);
}

interface UpdateBody {
  nombre?: unknown;
  password?: unknown;
  roles?: unknown;
  activo?: unknown;
}

/** PATCH /api/admin/users/:id — nombre, contraseña, roles o alta/baja. */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  userId: string,
): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const body = await readJson<UpdateBody>(request);
  const existe = await env.DB.prepare(`SELECT id FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ id: string }>();

  if (!existe) {
    throw ApiError.notFound('Esa cuenta no existe.');
  }

  const sets: string[] = [];
  const bindings: unknown[] = [];
  const push = (columna: string, valor: unknown) => {
    bindings.push(valor);
    sets.push(`${columna} = ?${bindings.length}`);
  };

  if (body.nombre !== undefined) {
    push('nombre', requireString(body.nombre, 'nombre', 120).trim());
  }

  if (body.password !== undefined) {
    push('password_hash', await hashPassword(validarPassword(body.password, 'password')));
  }

  if (body.activo !== undefined) {
    if (body.activo !== 0 && body.activo !== 1) {
      throw ApiError.badRequest('activo-invalido', 'El campo "activo" debe ser 0 o 1.');
    }
    // Desactivarse a uno mismo cierra la sesión propia sin poder revertirlo.
    if (body.activo === 0 && userId === user.sub) {
      throw ApiError.badRequest(
        'auto-desactivacion',
        'No puedes desactivar tu propia cuenta.',
      );
    }
    if (body.activo === 0 && (await otrosSuperAdmins(env, userId)) === 0) {
      throw ApiError.badRequest(
        'ultimo-super-admin',
        'Es la única cuenta de administración general activa. Crea otra antes de desactivarla.',
      );
    }
    push('activo', body.activo);
  }

  const rolesNuevos = body.roles !== undefined ? validarRoles(body.roles) : null;

  if (rolesNuevos && !rolesNuevos.includes('SUPER_ADMIN')) {
    if (userId === user.sub) {
      throw ApiError.badRequest(
        'auto-degradacion',
        'No puedes quitarte a ti mismo la administración general.',
      );
    }
    if ((await otrosSuperAdmins(env, userId)) === 0) {
      throw ApiError.badRequest(
        'ultimo-super-admin',
        'Es la única cuenta de administración general. Asigna ese rol a otra antes de quitárselo.',
      );
    }
  }

  if (sets.length === 0 && !rolesNuevos) {
    throw ApiError.badRequest('sin-cambios', 'No enviaste ningún campo para actualizar.');
  }

  const sentencias = [];

  if (sets.length > 0) {
    bindings.push(userId);
    sentencias.push(
      env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${bindings.length}`).bind(
        ...bindings,
      ),
    );
  }

  if (rolesNuevos) {
    // Se reemplazan enteros en el mismo batch: un borrado que triunfe y una
    // inserción que falle dejaría la cuenta sin ningún rol.
    sentencias.push(env.DB.prepare(`DELETE FROM user_roles WHERE user_id = ?1`).bind(userId));
    sentencias.push(
      ...rolesNuevos.map((role) =>
        env.DB.prepare(`INSERT INTO user_roles (user_id, role) VALUES (?1, ?2)`).bind(userId, role),
      ),
    );
  }

  await env.DB.batch(sentencias);

  const actualizado = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?1`)
    .bind(userId)
    .first<UserRow>();

  return json({ user: toUser(actualizado!) });
}

interface PasswordBody {
  actual?: unknown;
  nueva?: unknown;
}

/**
 * POST /api/auth/password — cambiar la contraseña propia.
 *
 * No pide rol: cualquiera con sesión puede cambiar la suya. Sí pide la
 * contraseña actual, y esa es la parte importante — sin ella, quien se hiciera
 * con un token robado podría cambiar la contraseña y quedarse con la cuenta
 * para siempre, mientras que el token por sí solo caduca en ocho horas.
 */
export async function changeOwnPassword(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  const body = await readJson<PasswordBody>(request);
  const actual = requireString(body.actual, 'actual', 200);
  const nueva = validarPassword(body.nueva, 'nueva');

  if (actual === nueva) {
    throw ApiError.badRequest('password-igual', 'La contraseña nueva es igual a la actual.');
  }

  const fila = await env.DB.prepare(
    `SELECT password_hash FROM users WHERE id = ?1 AND activo = 1`,
  )
    .bind(user.sub)
    .first<{ password_hash: string }>();

  if (!fila || !(await verifyPassword(actual, fila.password_hash))) {
    throw ApiError.unauthorized('La contraseña actual no es correcta.');
  }

  await env.DB.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2`)
    .bind(await hashPassword(nueva), user.sub)
    .run();

  return json({ ok: true });
}
