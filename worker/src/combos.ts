import { Env } from './types';

/**
 * Canastas, combos y mixes: productos que al venderse descuentan el stock de
 * otros.
 *
 * ── La idea central ──
 *
 * Un pedido dice qué **compró** el cliente («1 Canasta Pequeña»). El inventario
 * necesita saber qué **sale de la bodega** («1 kg de papa, 1 kg de tomate, 1
 * aguacate»). No son la misma lista, y confundirlas es donde esta función se
 * gana el sueldo: `expandir()` traduce la primera en la segunda.
 *
 * ── Por qué todo el stock pasa por aquí ──
 *
 * El inventario se mueve en cinco sitios —crear, aprobar, cancelar, editar
 * líneas y borrar pedido—. Si solo crear supiera abrir canastas, cancelar
 * devolvería el stock a la fila de la canasta —que debe quedarse en 0— y la
 * papa no volvería nunca al inventario. Sería una fuga invisible hasta el
 * siguiente conteo físico. Por eso los cinco llaman a `expandir()` y ninguno
 * escribe `stock_actual` por su cuenta.
 */

/** Un producto dentro de una canasta, con cuánto entra por canasta. */
export interface Componente {
  readonly childId: string;
  readonly cantidad: number;
}

/** Qué lleva cada canasta. Lo que no aparece aquí es un producto simple. */
export type Recetas = ReadonlyMap<string, readonly Componente[]>;

function agrupar(filas: readonly { parent: string; child: string; cantidad: number }[]): Recetas {
  const recetas = new Map<string, Componente[]>();
  for (const fila of filas) {
    const lista = recetas.get(fila.parent);
    const componente = { childId: fila.child, cantidad: fila.cantidad };
    if (lista) {
      lista.push(componente);
    } else {
      recetas.set(fila.parent, [componente]);
    }
  }
  return recetas;
}

/**
 * La receta de **hoy**, desde el catálogo.
 *
 * Se usa al vender y al añadir una línea nueva: es la que se congela en el
 * pedido. Para mover el stock de un pedido que ya existe hay que usar
 * `recetasDelPedido()`, que devuelve la que estaba vigente aquel día.
 */
export async function recetasActuales(env: Env, ids: readonly string[]): Promise<Recetas> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT parent_product_id AS parent, child_product_id AS child, cantidad_requerida AS cantidad
       FROM product_components
      WHERE parent_product_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ parent: string; child: string; cantidad: number }>();

  return agrupar(results);
}

/**
 * La receta **congelada** en un pedido, tal como estaba el día que se vendió.
 *
 * Si a la canasta se le quitó el aguacate después de la compra, devolver según
 * la receta nueva dejaría un aguacate descontado que nadie devuelve jamás. El
 * descuento y su devolución tienen que leer exactamente la misma lista, y esa
 * lista es esta.
 */
export async function recetasDelPedido(env: Env, orderId: string): Promise<Recetas> {
  const { results } = await env.DB.prepare(
    `SELECT parent_product_id AS parent, child_product_id AS child, cantidad_requerida AS cantidad
       FROM order_item_components
      WHERE order_id = ?1`,
  )
    .bind(orderId)
    .all<{ parent: string; child: string; cantidad: number }>();

  return agrupar(results);
}

/**
 * Traduce lo pedido a lo que de verdad sale del inventario.
 *
 * Es una función pura —sin base de datos— porque aquí vive el detalle que hace
 * que la cuenta cuadre: **suma**. Si alguien compra una canasta que lleva 1 kg
 * de papa y además 2 kg de papa sueltos, salen 3 kg en un solo movimiento. Con
 * dos restas separadas, cada una pasaría su comprobación por su cuenta y entre
 * las dos se llevarían más papa de la que hay — el mismo agujero que `aggregate`
 * cierra un nivel más arriba, con las líneas repetidas del carrito.
 *
 * Un producto sin receta se devuelve tal cual: la expansión no distingue entre
 * "no es canasta" y "no hay que tocarla", porque son lo mismo.
 */
export function expandir(
  pedido: ReadonlyMap<string, number>,
  recetas: Recetas,
): Map<string, number> {
  const salida = new Map<string, number>();
  const sumar = (id: string, cantidad: number) =>
    salida.set(id, (salida.get(id) ?? 0) + cantidad);

  for (const [productId, cantidad] of pedido) {
    const receta = recetas.get(productId);
    if (!receta) {
      sumar(productId, cantidad);
      continue;
    }
    for (const componente of receta) {
      sumar(componente.childId, componente.cantidad * cantidad);
    }
  }

  return salida;
}

/**
 * Cuántas canastas se pueden armar ahora mismo, por el componente que primero
 * se agote.
 *
 * No se guarda en ninguna columna: `products.stock_actual` de una canasta se
 * queda en 0 para siempre. Tener el número escrito además de calculable serían
 * dos verdades sobre el mismo inventario, y la escrita a mano siempre acaba
 * mintiendo.
 *
 * Un componente desactivado deja la canasta en 0 aunque le sobre stock: si una
 * de sus partes ya no se ofrece, la canasta no se puede armar completa.
 */
export async function stockDeCanastas(
  env: Env,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    // La división entera de SQLite trunca hacia abajo con enteros positivos,
    // que es el FLOOR que hace falta: con 5 kg de papa y 2 kg por canasta
    // salen 2 canastas, no 2,5.
    `SELECT pc.parent_product_id AS id,
            MIN(CASE WHEN h.activo = 1
                     THEN h.stock_actual / pc.cantidad_requerida
                     ELSE 0 END) AS disponibles
       FROM product_components pc
       JOIN products h ON h.id = pc.child_product_id
      WHERE pc.parent_product_id IN (${placeholders})
      GROUP BY pc.parent_product_id`,
  )
    .bind(...ids)
    .all<{ id: string; disponibles: number }>();

  return new Map(results.map((row) => [row.id, row.disponibles]));
}

/**
 * Cuáles de estos productos son canastas. Una sola consulta, para no preguntar
 * producto por producto en los bucles de validación.
 */
export async function cualesSonCanastas(
  env: Env,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT parent_product_id AS id
       FROM product_components
      WHERE parent_product_id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string }>();

  return new Set(results.map((row) => row.id));
}

/** Lo que el cliente puede saber de lo que lleva una canasta. */
export interface ContenidoPublico {
  readonly nombre: string;
  readonly cantidad: number;
  readonly unidad: string;
  readonly cantidadUnidad: number;
}

/**
 * Qué lleva cada canasta, para pintarlo en la tienda.
 *
 * Viaja en la misma respuesta del catálogo y no en un endpoint por tarjeta, por
 * la misma razón que las variantes: son unas pocas filas y pedirlas al abrir
 * cada canasta serían tantas peticiones como canastas se miren.
 *
 * Va aparte de `recetasActuales` porque lo que se enseña no es lo que se
 * descuenta: aquí no hay ids ni stock, solo el nombre y cuánto entra. El
 * inventario de cada componente es información de la finca, no del cliente.
 */
export async function contenidoPublico(
  env: Env,
  ids: readonly string[],
): Promise<Map<string, ContenidoPublico[]>> {
  if (ids.length === 0) {
    return new Map();
  }

  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT pc.parent_product_id AS parent,
            p.nombre,
            pc.cantidad_requerida AS cantidad,
            p.unidad,
            p.cantidad_unidad     AS cantidadUnidad
       FROM product_components pc
       JOIN products p ON p.id = pc.child_product_id
      WHERE pc.parent_product_id IN (${placeholders})
      ORDER BY p.nombre COLLATE NOCASE`,
  )
    .bind(...ids)
    .all<{ parent: string } & ContenidoPublico>();

  const porCanasta = new Map<string, ContenidoPublico[]>();
  for (const { parent, ...contenido } of results) {
    const lista = porCanasta.get(parent);
    if (lista) {
      lista.push(contenido);
    } else {
      porCanasta.set(parent, [contenido]);
    }
  }
  return porCanasta;
}

/**
 * Qué llevaba cada canasta de un pedido, según la receta **congelada** el día
 * que se vendió — no la de hoy.
 *
 * Es la versión de `contenidoPublico` para el detalle de un pedido ya hecho.
 * Se lee de `order_item_components` y no de `product_components` por la misma
 * razón de siempre: si a la canasta le quitaron el aguacate después de esa
 * venta, el pedido tiene que seguir mostrando que sí lo llevaba. El detalle es
 * el documento de lo que pasó, no una vista de la receta actual.
 *
 * Clave del mapa: `"${orderId}:${parentProductId}"`, porque la misma canasta
 * puede vender distinto en dos pedidos distintos si la receta cambió entre uno
 * y otro.
 */
export async function contenidoDePedidos(
  env: Env,
  orderIds: readonly string[],
): Promise<Map<string, ContenidoPublico[]>> {
  if (orderIds.length === 0) {
    return new Map();
  }

  const placeholders = orderIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT oic.order_id           AS orderId,
            oic.parent_product_id  AS parent,
            p.nombre,
            oic.cantidad_requerida AS cantidad,
            p.unidad,
            p.cantidad_unidad      AS cantidadUnidad
       FROM order_item_components oic
       JOIN products p ON p.id = oic.child_product_id
      WHERE oic.order_id IN (${placeholders})
      ORDER BY p.nombre COLLATE NOCASE`,
  )
    .bind(...orderIds)
    .all<{ orderId: string; parent: string } & ContenidoPublico>();

  const porLinea = new Map<string, ContenidoPublico[]>();
  for (const { orderId, parent, ...contenido } of results) {
    const clave = `${orderId}:${parent}`;
    const lista = porLinea.get(clave);
    if (lista) {
      lista.push(contenido);
    } else {
      porLinea.set(clave, [contenido]);
    }
  }
  return porLinea;
}

/**
 * Sentencias que congelan en el pedido la receta de cada canasta que lleva.
 *
 * Van en el mismo batch que el pedido: si la compra no llega a cerrarse,
 * tampoco debe quedar la instantánea de una canasta que nadie compró.
 */
export function sentenciasDeInstantanea(
  env: Env,
  orderId: string,
  pedido: ReadonlyMap<string, number>,
  recetas: Recetas,
): D1PreparedStatement[] {
  const sentencias: D1PreparedStatement[] = [];

  for (const productId of pedido.keys()) {
    for (const componente of recetas.get(productId) ?? []) {
      sentencias.push(
        env.DB.prepare(
          `INSERT INTO order_item_components
             (order_id, parent_product_id, child_product_id, cantidad_requerida)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (order_id, parent_product_id, child_product_id) DO NOTHING`,
        ).bind(orderId, productId, componente.childId, componente.cantidad),
      );
    }
  }

  return sentencias;
}
