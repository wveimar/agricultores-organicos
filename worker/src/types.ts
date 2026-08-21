/** Bindings declarados en wrangler.jsonc + secretos. */
export interface Env {
  /** Base de datos D1. Única fuente de datos del proyecto, comprobantes incluidos. */
  readonly DB: D1Database;
  /** Assets estáticos del build de Angular (fallback del SPA). */
  readonly ASSETS: Fetcher;
  /**
   * Clave de firma HS256. Se inyecta con `wrangler secret put JWT_SECRET`
   * (o `.dev.vars` en local). **Nunca** va en wrangler.jsonc: ese fichero se
   * versiona.
   */
  readonly JWT_SECRET: string;
  /**
   * Clave **secreta** de Turnstile, para `siteverify`. Opcional: si no está,
   * el login no exige verificación anti-bots (ver `auth/turnstile.ts`).
   *   npx wrangler secret put TURNSTILE_SECRET
   */
  readonly TURNSTILE_SECRET?: string;
  /**
   * Sitekey **pública** de Turnstile. La expone `GET /api/config` para que el
   * navegador pinte el widget sin necesidad de recompilar el frontend.
   * Al ser pública puede ir como `vars` en wrangler.jsonc.
   */
  readonly TURNSTILE_SITE_KEY?: string;
  /**
   * Clave de la API de Resend, para los correos de recuperación. Opcional: sin
   * ella la recuperación sigue respondiendo igual, pero no llega ningún correo
   * y queda el aviso en los logs (ver `auth/email.ts`).
   *   npx wrangler secret put RESEND_API_KEY
   */
  readonly RESEND_API_KEY?: string;
  /**
   * Remitente de los correos, con dominio verificado en el proveedor.
   * Ejemplo: "Agricultores Orgánicos <hola@tudominio.co>".
   */
  readonly EMAIL_FROM?: string;
}

/**
 * Niveles de mayorista. No abren ninguna sección del panel: lo único que
 * cambian es el precio que se le cobra a esa cuenta en la tienda.
 */
export type WholesaleRole = 'MAYORISTA_N1' | 'MAYORISTA_N2' | 'MAYORISTA_N3';

export const WHOLESALE_ROLES: readonly WholesaleRole[] = [
  'MAYORISTA_N1',
  'MAYORISTA_N2',
  'MAYORISTA_N3',
];

export type StaffRole = 'ADMIN_INVENTARIO' | 'GESTOR_PEDIDOS' | 'SUPER_ADMIN' | 'DOMICILIARIO';

export type UserRole = StaffRole | WholesaleRole;

export const ALL_ROLES: readonly UserRole[] = [
  'ADMIN_INVENTARIO',
  'GESTOR_PEDIDOS',
  'SUPER_ADMIN',
  'DOMICILIARIO',
  ...WHOLESALE_ROLES,
];

export function isWholesaleRole(role: string): role is WholesaleRole {
  return (WHOLESALE_ROLES as readonly string[]).includes(role);
}

/** Contenido del JWT ya verificado. */
export interface JwtPayload {
  readonly sub: string;
  readonly email: string;
  readonly nombre: string;
  readonly roles: readonly UserRole[];
  readonly iat: number;
  readonly exp: number;
}

/** Contexto que se pasa a cada handler. */
export interface RequestContext {
  readonly env: Env;
  readonly url: URL;
  readonly params: Record<string, string>;
  /** Solo presente en rutas que pasaron por `requireAuth`. */
  readonly user?: JwtPayload;
}

export type OrderStatus = 'verificacion' | 'pendiente' | 'aprobado' | 'enviado';
export type AbcClass = 'A' | 'B' | 'C';
export type AdminGroup = 'frutas' | 'verduras' | 'agroindustriales';
