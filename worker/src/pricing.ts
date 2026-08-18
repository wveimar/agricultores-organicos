import { Env, UserRole, WholesaleRole, WHOLESALE_ROLES, isWholesaleRole } from './types';

/**
 * Precio efectivo de un producto para un nivel de mayorista.
 *
 * ── Por qué esta función existe por duplicado ──
 *
 * La misma fórmula vive en `src/app/core/models/pricing.ts` para que la tienda
 * pueda pintar el precio antes de pedir nada al servidor. Son dos copias de
 * tres líneas, y tienen que dar **exactamente** el mismo entero: si divergen,
 * el cliente ve un precio y se le cobra otro. La prueba
 * `worker/tests/qa-mayoristas.mjs` compara las dos implementaciones sobre los
 * mismos números para que una desincronización se note al ejecutar la QA y no
 * en la primera factura reclamada.
 *
 * El redondeo es al peso más cercano porque el COP no tiene decimales y toda
 * la base guarda dinero como INTEGER. `Math.round` sobre el producto completo
 * —y no sobre cada unidad— evita que el error de redondeo se multiplique por
 * la cantidad pedida: el descuento se aplica al precio unitario una vez, y ese
 * entero es el que se congela en `order_items.precio_unitario`.
 */
export function discountedPrice(listPrice: number, percent: number): number {
  if (percent <= 0) {
    return listPrice;
  }
  const capped = Math.min(percent, 100);
  return Math.round((listPrice * (100 - capped)) / 100);
}

/**
 * Descuentos que aplican a un conjunto de productos para unos roles dados.
 *
 * Devuelve un mapa `productId → porcentaje`. Los productos sin trato especial
 * no aparecen: la ausencia de entrada **es** "precio de lista".
 *
 * ── Dos reglas que no son obvias ──
 *
 * 1. **Solo cuentan los roles de mayorista exactos.** En el resto del código,
 *    `hasRole`/`TokenStore.can` dejan pasar a `SUPER_ADMIN` por cualquier
 *    puerta, que es lo correcto para permisos. Aplicado a precios sería un
 *    error caro: el administrador general acabaría comprando con el mejor
 *    descuento sin pedirlo, y ese pedido entraría en la caja como una venta
 *    normal. Aquí se filtra por pertenencia literal, sin escalada.
 *
 * 2. **Con varios niveles gana el mayor descuento.** Una cuenta puede acabar
 *    con dos niveles por un cambio a medias. Cobrar el más caro de los dos
 *    sería cobrarle de más a alguien a quien se le prometió el otro; se
 *    resuelve a favor del cliente, que además es determinista y no depende
 *    del orden en que estén los roles.
 */
export async function loadDiscounts(
  env: Env,
  productIds: readonly string[],
  roles: readonly UserRole[],
): Promise<Map<string, number>> {
  const wholesale = roles.filter(isWholesaleRole);

  if (wholesale.length === 0 || productIds.length === 0) {
    return new Map();
  }

  const productPlaceholders = productIds.map((_, i) => `?${i + 1}`).join(', ');
  const rolePlaceholders = wholesale
    .map((_, i) => `?${productIds.length + i + 1}`)
    .join(', ');

  const { results } = await env.DB.prepare(
    `SELECT product_id AS productId, MAX(porcentaje_descuento) AS porcentaje
       FROM product_wholesale_discounts
      WHERE product_id IN (${productPlaceholders})
        AND role       IN (${rolePlaceholders})
      GROUP BY product_id`,
  )
    .bind(...productIds, ...wholesale)
    .all<{ productId: string; porcentaje: number }>();

  return new Map(results.map((row) => [row.productId, row.porcentaje]));
}

/**
 * Roles vigentes de una cuenta, leídos de la base y no del JWT.
 *
 * El token va firmado, así que su lista de roles no se puede falsificar — pero
 * dura 8 horas. Para decidir qué se pinta, esa ventana es aceptable; para
 * decidir **cuánto se cobra**, no: a una cuenta a la que se le retiró el nivel
 * de mayorista se le seguiría facturando con descuento el resto del día, y esa
 * diferencia acaba en el cierre de caja. Un viaje extra a D1 por pedido es
 * barato al lado de eso.
 */
export async function loadUserRoles(env: Env, userId: string): Promise<readonly UserRole[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.role
       FROM user_roles r
       JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ?1 AND u.activo = 1`,
  )
    .bind(userId)
    .all<{ role: UserRole }>();

  return results.map((row) => row.role);
}

/** El nivel de mayorista de mayor descuento que tenga la cuenta, si alguno. */
export function topWholesaleRole(roles: readonly UserRole[]): WholesaleRole | null {
  // `WHOLESALE_ROLES` va de menor a mayor nivel, así que se recorre al revés.
  for (let i = WHOLESALE_ROLES.length - 1; i >= 0; i--) {
    if (roles.includes(WHOLESALE_ROLES[i])) {
      return WHOLESALE_ROLES[i];
    }
  }
  return null;
}
