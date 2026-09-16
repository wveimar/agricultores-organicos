import { Env } from './types';

/**
 * Sesiones de un producto-servicio: la reserva por fecha y cupo (migración
 * 0038). Es el equivalente de `combos.ts` para el flujo de servicios —
 * mismo motivo de existir como módulo aparte de las rutas: `products.ts`
 * (CRUD del panel), `orders.ts` (reservar al comprar) y `sessions.ts` (rutas
 * admin) necesitan las tres la misma lectura, y duplicarla sería tener dos
 * copias de la misma cuenta de cupo.
 */

/** Fila cruda de `product_sessions`, tal como sale de D1. */
export interface SessionRow {
  id: string;
  product_id: string;
  inicio: string;
  fin: string | null;
  ubicacion: string | null;
  cupo_total: number;
  cupo_reservado: number;
  activo: number;
}

/**
 * Lee sesiones por id, para validar una reserva.
 *
 * Igual que `loadProducts()` en orders.ts: una sola consulta por todas las
 * sesiones que trae el pedido, no una por línea.
 */
export async function loadSessions(
  env: Env,
  ids: readonly string[],
): Promise<Map<string, SessionRow>> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, product_id, inicio, fin, ubicacion, cupo_total, cupo_reservado, activo
       FROM product_sessions
      WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<SessionRow>();

  return new Map(results.map((row) => [row.id, row]));
}

/** Lo que ve el catálogo público: sin `activo` (ya está filtrado). */
export interface PublicSession {
  readonly id: string;
  readonly inicio: string;
  readonly fin: string | null;
  readonly ubicacion: string | null;
  readonly cupoTotal: number;
  readonly cupoDisponible: number;
}

/**
 * Las próximas sesiones activas de cada producto-servicio, para pintar el
 * selector de fecha en la tienda.
 *
 * Solo futuras: una sesión de ayer no se puede reservar y confundiría más
 * que ayudar en el selector. `cupoDisponible` ya viene restado — la tienda
 * no necesita saber `cupo_reservado` para nada.
 */
export async function sesionesFuturasPublicas(
  env: Env,
  productIds: readonly string[],
): Promise<Map<string, PublicSession[]>> {
  if (productIds.length === 0) {
    return new Map();
  }

  const placeholders = productIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, product_id AS productId, inicio, fin, ubicacion,
            cupo_total AS cupoTotal, (cupo_total - cupo_reservado) AS cupoDisponible
       FROM product_sessions
      WHERE activo = 1 AND product_id IN (${placeholders}) AND inicio >= datetime('now')
      ORDER BY inicio ASC`,
  )
    .bind(...productIds)
    .all<PublicSession & { productId: string }>();

  const porProducto = new Map<string, PublicSession[]>();
  for (const { productId, ...sesion } of results) {
    const lista = porProducto.get(productId);
    if (lista) {
      lista.push(sesion);
    } else {
      porProducto.set(productId, [sesion]);
    }
  }
  return porProducto;
}
