/** Roles que abren secciones del panel. */
export type StaffRole = 'ADMIN_INVENTARIO' | 'GESTOR_PEDIDOS' | 'SUPER_ADMIN' | 'DOMICILIARIO';

/**
 * Niveles de mayorista. **No** dan acceso a ninguna sección del panel: lo
 * único que cambian es el precio que se le cobra a esa cuenta en la tienda.
 * Ordenados de menor a mayor nivel.
 */
export type WholesaleRole = 'MAYORISTA_N1' | 'MAYORISTA_N2' | 'MAYORISTA_N3';

export type UserRole = StaffRole | WholesaleRole;

export const WHOLESALE_ROLES: readonly WholesaleRole[] = [
  'MAYORISTA_N1',
  'MAYORISTA_N2',
  'MAYORISTA_N3',
];

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  ADMIN_INVENTARIO: 'Administración de inventario',
  GESTOR_PEDIDOS: 'Gestión de pedidos',
  SUPER_ADMIN: 'Administración general',
  DOMICILIARIO: 'Domiciliario',
  MAYORISTA_N1: 'Mayorista Bronce',
  MAYORISTA_N2: 'Mayorista Plata',
  MAYORISTA_N3: 'Mayorista Oro',
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

export function isWholesaleRole(role: UserRole): role is WholesaleRole {
  return (WHOLESALE_ROLES as readonly string[]).includes(role);
}

/** Los que abren secciones del panel. Derivados, para no listarlos dos veces. */
export const STAFF_ROLES = ALL_ROLES.filter(
  (role): role is StaffRole => !isWholesaleRole(role),
);

/**
 * Qué concede cada rol, en una línea.
 *
 * Va junto a la casilla al asignarlo. Las etiquetas por sí solas no distinguen
 * lo que abre el panel de lo que solo cambia un precio, y en una lista de seis
 * casillas iguales esa diferencia es un clic.
 */
export const ROLE_HINTS: Readonly<Record<UserRole, string>> = {
  ADMIN_INVENTARIO: 'Precios, existencias y catálogo',
  GESTOR_PEDIDOS: 'Aprobar pedidos, despachos y cierre de caja',
  SUPER_ADMIN: 'Todo el panel, incluidas cuentas y tarifas',
  DOMICILIARIO: 'Cobrar pedidos contra entrega desde el celular',
  MAYORISTA_N1: 'Precios del nivel Bronce en la tienda',
  MAYORISTA_N2: 'Precios del nivel Plata en la tienda',
  MAYORISTA_N3: 'Precios del nivel Oro en la tienda',
};

/**
 * Una cuenta es de cliente mayorista cuando **solo** tiene niveles de
 * mayorista: no entra al panel, únicamente compra más barato.
 *
 * Se comprueba con `every` y no con `some` a propósito. Una cuenta que además
 * lleva `GESTOR_PEDIDOS` es personal de la cooperativa que encima tiene tarifa,
 * y tratarla como "cliente" la escondería del filtro donde se revisa quién
 * tiene acceso al panel — justo la lista que hay que poder auditar.
 */
export function isWholesaleOnly(roles: readonly UserRole[]): boolean {
  return roles.length > 0 && roles.every(isWholesaleRole);
}

/**
 * El nivel de mayorista más alto de una cuenta, si tiene alguno.
 *
 * Se busca por pertenencia literal, sin la escalada de `hasRole`: un
 * `SUPER_ADMIN` no es mayorista de nada. Confundirlo aquí le pondría el mejor
 * descuento a la cuenta del administrador sin que nadie lo pidiera.
 */
export function topWholesaleRole(roles: readonly UserRole[]): WholesaleRole | null {
  for (let i = WHOLESALE_ROLES.length - 1; i >= 0; i--) {
    if (roles.includes(WHOLESALE_ROLES[i])) {
      return WHOLESALE_ROLES[i];
    }
  }
  return null;
}

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
