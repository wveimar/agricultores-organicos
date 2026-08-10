/** Bindings declarados en wrangler.jsonc + secretos. */
export interface Env {
  /** Base de datos D1. */
  readonly DB: D1Database;
  /** Assets estáticos del build de Angular (fallback del SPA). */
  readonly ASSETS: Fetcher;
  /**
   * Clave de firma HS256. Se inyecta con `wrangler secret put JWT_SECRET`
   * (o `.dev.vars` en local). **Nunca** va en wrangler.jsonc: ese fichero se
   * versiona.
   */
  readonly JWT_SECRET: string;
}

export type UserRole = 'ADMIN_INVENTARIO' | 'GESTOR_PEDIDOS' | 'SUPER_ADMIN';

export const ALL_ROLES: readonly UserRole[] = [
  'ADMIN_INVENTARIO',
  'GESTOR_PEDIDOS',
  'SUPER_ADMIN',
];

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
