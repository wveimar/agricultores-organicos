export type UserRole = 'ADMIN_INVENTARIO' | 'GESTOR_PEDIDOS' | 'SUPER_ADMIN';

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  ADMIN_INVENTARIO: 'Administración de inventario',
  GESTOR_PEDIDOS: 'Gestión de pedidos',
  SUPER_ADMIN: 'Administración general',
};

/**
 * Todos los roles, para pintar el selector del alta de usuarios.
 *
 * Se deriva de `ROLE_LABELS` en vez de escribirse aparte: así añadir un rol
 * es tocar un solo sitio y no puede quedar uno sin etiqueta o una etiqueta sin
 * rol. El servidor tiene su propia lista en `worker/src/types.ts`, que es la
 * que decide de verdad — esta solo dibuja.
 */
export const ALL_ROLES = Object.keys(ROLE_LABELS) as readonly UserRole[];

export interface AuthUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly roles: readonly UserRole[];
}

export interface Session {
  readonly user: AuthUser;
  /** JWT **simulado**. Ver la advertencia en `auth.service.ts`. */
  readonly token: string;
  /** Epoch en milisegundos. */
  readonly expiresAt: number;
}

/**
 * SUPER_ADMIN abre cualquier puerta; el resto necesita el rol exacto.
 * Se centraliza aquí para que guards y plantillas apliquen la misma regla.
 */
export function hasRole(user: AuthUser | null, ...allowed: readonly UserRole[]): boolean {
  if (!user) {
    return false;
  }
  if (user.roles.includes('SUPER_ADMIN')) {
    return true;
  }
  return allowed.some((role) => user.roles.includes(role));
}
