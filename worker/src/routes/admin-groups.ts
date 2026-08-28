import { ApiError, json, readJson, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Grupos del panel de compras — la agrupación macro que usa Inventario y los
 * informes ("Frutas", "Verduras", "Agroindustriales"...).
 *
 * Vivían como tres literales fijos, repetidos en un CHECK de `products`, otro
 * de `categories` y un tipo de TypeScript en el frontend. Añadir un cuarto
 * grupo exigía tocar los tres sitios y desplegar. Ahora son filas, igual que
 * pasó con las categorías en la migración 0013.
 *
 * ── Por qué `grupo_admin_id` y no reescribir `grupo_admin` ──
 *
 * `products.grupo_admin` tiene un CHECK que SQLite no permite quitar sin
 * recrear la tabla, y `products` tiene varias FK con `ON DELETE RESTRICT`
 * (`order_items`, `order_item_components`, `provider_purchase_items`) que
 * harían de ese recreado una operación que arrastra el histórico de ventas y
 * de compras — el mismo motivo por el que la migración 0012 evitó recrearla
 * para las variantes. La migración 0025 añade `grupo_admin_id` con
 * `ALTER TABLE`, sin tocar la columna vieja, que queda sin uso.
 *
 * Quién puede tocarlos: `ADMIN_INVENTARIO`, la misma persona que archiva
 * productos y categorías.
 */

const COLUMNS = `id,
                  nombre,
                  mostrar_filtro_fino AS mostrarFiltroFino,
                  orden,
                  activo,
                  actualizado_en AS actualizadoEn`;

interface GroupBody {
  id?: unknown;
  nombre?: unknown;
  mostrarFiltroFino?: unknown;
  orden?: unknown;
  activo?: unknown;
}

/**
 * Normaliza un nombre a un id usable: «Panadería fina» → `panaderia-fina`.
 *
 * Idéntico al de categories.ts a propósito: el id acaba en `products.grupo_
 * admin_id` y `categories.grupo_admin_id`, y las dos tablas deben poder
 * generarlo con la misma regla para que dos administradores no acaben con
 * dos ids distintos para lo que iba a ser el mismo grupo.
 */
function slugify(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * GET /api/admin/admin-groups — todos, con cuántas categorías y productos
 * cuelgan de cada uno.
 *
 * Los dos recuentos viajan con la lista, igual que en categorías: son lo que
 * decide si el botón de borrar se puede pulsar, y calcularlo en el mismo
 * viaje evita mostrar un error después de que alguien ya lo intentó.
 */
export async function listAdmin(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM categories c WHERE c.grupo_admin_id = g.id) AS categorias,
            (SELECT COUNT(*) FROM products  p WHERE p.grupo_admin_id  = g.id) AS productos
       FROM admin_groups g
      ORDER BY g.orden, g.nombre COLLATE NOCASE`,
  ).all();

  return json({ grupos: results });
}

/**
 * Valida el `grupoAdmin` que llega de un formulario de producto o categoría.
 *
 * Exportada para que `products.ts` y `categories.ts` no dupliquen la consulta
 * ni el mensaje: las dos necesitan exactamente la misma comprobación contra la
 * misma tabla. Acepta un grupo desactivado —igual que `categories.activo` no
 * le impide a un producto ya archivado seguir en su categoría—, así que solo
 * se comprueba que la fila exista, no que esté activa.
 */
export async function validarGrupo(env: Env, value: unknown): Promise<string> {
  const grupoId = requireString(value, 'grupoAdmin', 40);

  const existe = await env.DB.prepare(`SELECT 1 FROM admin_groups WHERE id = ?1`)
    .bind(grupoId)
    .first();

  if (!existe) {
    throw ApiError.badRequest(
      'grupo-invalido',
      `Ese grupo no existe. Revisa la lista en Grupos, dentro de Inventario.`,
    );
  }

  return grupoId;
}

export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<GroupBody>(request);
  const nombre = requireString(body.nombre, 'nombre', 60);

  const id = slugify(body.id ? requireString(body.id, 'id', 40) : nombre);
  if (!id) {
    throw ApiError.badRequest(
      'id-invalido',
      'El nombre debe tener al menos una letra o un número.',
    );
  }

  const existe = await env.DB.prepare(`SELECT nombre FROM admin_groups WHERE id = ?1`)
    .bind(id)
    .first<{ nombre: string }>();

  if (existe) {
    throw ApiError.conflict(
      'grupo-repetido',
      `Ya existe un grupo con ese identificador: «${existe.nombre}».`,
    );
  }

  await env.DB.prepare(
    `INSERT INTO admin_groups (id, nombre, mostrar_filtro_fino, orden, activo)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(
      id,
      nombre,
      body.mostrarFiltroFino ? 1 : 0,
      body.orden === undefined ? 100 : Number(body.orden),
      body.activo === 0 ? 0 : 1,
    )
    .run();

  const created = await env.DB.prepare(`SELECT ${COLUMNS} FROM admin_groups WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ grupo: created }, 201);
}

/**
 * PUT /api/admin/admin-groups/:id
 *
 * El id no se puede cambiar: es la clave por la que apuntan productos y
 * categorías, y renombrarlo los dejaría huérfanos. Para «cambiarle el
 * nombre» está `nombre`, que es lo que de verdad se lee en el panel.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  id: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<GroupBody>(request);

  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (body.nombre !== undefined) {
    sets.push(`nombre = ?${bindings.push(requireString(body.nombre, 'nombre', 60))}`);
  }
  if (body.mostrarFiltroFino !== undefined) {
    sets.push(`mostrar_filtro_fino = ?${bindings.push(body.mostrarFiltroFino ? 1 : 0)}`);
  }
  if (body.orden !== undefined) {
    sets.push(`orden = ?${bindings.push(Number(body.orden))}`);
  }
  if (body.activo !== undefined) {
    sets.push(`activo = ?${bindings.push(body.activo ? 1 : 0)}`);
  }

  if (sets.length === 0) {
    throw ApiError.badRequest('sin-cambios', 'No mandaste ningún campo que cambiar.');
  }

  sets.push(`actualizado_en = datetime('now')`);
  bindings.push(id);

  const result = await env.DB.prepare(
    `UPDATE admin_groups SET ${sets.join(', ')} WHERE id = ?${bindings.length}`,
  )
    .bind(...bindings)
    .run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Ese grupo no existe.');
  }

  const updated = await env.DB.prepare(`SELECT ${COLUMNS} FROM admin_groups WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ grupo: updated });
}

/**
 * DELETE /api/admin/admin-groups/:id — solo si no lo usa ninguna categoría ni
 * ningún producto.
 *
 * Se comprueban las dos tablas por separado porque un producto puede tener su
 * propio `grupo_admin_id` distinto al de su categoría: el formulario de
 * producto lo deja elegir aparte, no lo deriva siempre de la categoría.
 * Comprobar solo una de las dos dejaría borrar un grupo que la otra todavía
 * usa.
 *
 * Para dejar de ofrecerlo sin vaciarlo está `activo = 0`.
 */
export async function remove(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const enUso = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM categories WHERE grupo_admin_id = ?1) AS categorias,
            (SELECT COUNT(*) FROM products  WHERE grupo_admin_id = ?1) AS productos`,
  )
    .bind(id)
    .first<{ categorias: number; productos: number }>();

  if (enUso && (enUso.categorias > 0 || enUso.productos > 0)) {
    const partes: string[] = [];
    if (enUso.categorias > 0) {
      partes.push(`${enUso.categorias} categoría(s)`);
    }
    if (enUso.productos > 0) {
      partes.push(`${enUso.productos} producto(s)`);
    }
    throw ApiError.conflict(
      'grupo-en-uso',
      `Todavía hay ${partes.join(' y ')} en este grupo. Muévelos a otro antes de borrarlo, ` +
        `o desactívalo si solo quieres dejar de ofrecerlo.`,
      { categorias: enUso.categorias, productos: enUso.productos },
    );
  }

  const result = await env.DB.prepare(`DELETE FROM admin_groups WHERE id = ?1`).bind(id).run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Ese grupo no existe.');
  }

  return json({ ok: true });
}
