import { ApiError, json, readJson, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';
import { validarGrupo } from './admin-groups';

/**
 * Categorías del catálogo — los chips de la vitrina y el desplegable del panel.
 *
 * Vivían en tres constantes de TypeScript y añadir una obligaba a tocar las
 * tres y desplegar. Ahora son filas, y quien lleva el inventario las edita.
 *
 * Quién puede tocarlas: `ADMIN_INVENTARIO`. Es la misma persona que archiva
 * los productos, y una categoría es la estantería donde los pone. No se abre
 * más: renombrar un chip cambia lo que ve toda la tienda.
 */

const COLUMNS = `id,
                 nombre,
                 descripcion,
                 icono,
                 grupo_admin_id AS grupoAdmin,
                 orden,
                 activo,
                 actualizado_en AS actualizadoEn`;

interface CategoryBody {
  id?: unknown;
  nombre?: unknown;
  descripcion?: unknown;
  icono?: unknown;
  grupoAdmin?: unknown;
  orden?: unknown;
  activo?: unknown;
}

/**
 * La clave del ícono del chip. No se valida contra una lista: el repertorio de
 * siluetas vive en el front (`CategoryIcon`), y atarlo aquí obligaría a
 * desplegar el Worker cada vez que se dibuja una nueva. Una clave que el front
 * no conozca cae en la silueta por defecto, así que lo peor que puede pasar es
 * que el chip salga con una hoja.
 *
 * Vacío es válido y significa exactamente eso: «la que sea».
 */
function readIcono(value: unknown): string {
  return value === '' ? '' : requireString(value, 'icono', 40);
}

/**
 * La descripción es opcional de verdad — así lo dice el formulario y así lo
 * permite la columna (`DEFAULT ''`) — así que vacía es un valor válido, no
 * ausencia de valor. `requireString()` a secas la habría rechazado con "el
 * campo es obligatorio", porque no distingue "no mandaste nada" de "mandaste
 * una cadena vacía a propósito": el formulario SIEMPRE manda la clave
 * (`FormControl` nunca es `undefined`), así que sin este caso especial crear
 * o editar una categoría con la descripción en blanco fallaba siempre. Mismo
 * patrón que `readIcono()`, un campo con la misma forma justo aquí arriba.
 */
function readDescripcion(value: unknown): string {
  return value === '' ? '' : requireString(value, 'descripcion', 200);
}

/**
 * Normaliza un nombre a un id usable: «Panadería fina» → `panaderia-fina`.
 *
 * Sin tildes ni eñes a propósito. El id acaba en la URL de los filtros y en
 * `products.categoria_id`, y un identificador que dependa de cómo se teclee un
 * acento es una fuente de duplicados silenciosos.
 */
function slugify(texto: string): string {
  return texto
    .normalize('NFD')
    // Los diacríticos que `NFD` acaba de separar de su letra. Se quitan antes
    // del filtro de abajo: si llegaran a él, al no ser `a-z0-9` se convertirían
    // en un guion y «Panadería» acabaría como `panader-ia`.
    // `\p{M}` en vez del rango en crudo: el rango son caracteres invisibles en
    // el código que cualquier editor puede comerse sin que nadie lo note.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * GET /api/categories — las que se pintan en la tienda.
 *
 * Solo las activas: una categoría apagada es una que no se ofrece esta
 * temporada, y sus productos siguen encontrándose por búsqueda y bajo «Todo
 * el huerto».
 */
export async function listPublic(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM categories WHERE activo = 1 ORDER BY orden, nombre COLLATE NOCASE`,
  ).all();

  return json({ categories: results });
}

/**
 * GET /api/admin/categories — todas, con cuántos productos cuelgan de cada una.
 *
 * El recuento es lo que decide si se puede borrar, así que viaja con la lista:
 * la pantalla puede desactivar el botón antes de que nadie lo pulse, en vez de
 * enseñar un error después.
 */
export async function listAdmin(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*) FROM products p WHERE p.categoria_id = c.id) AS productos
       FROM categories c
      ORDER BY c.orden, c.nombre COLLATE NOCASE`,
  ).all();

  return json({ categories: results });
}

export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<CategoryBody>(request);
  const nombre = requireString(body.nombre, 'nombre', 60);

  // El id se puede fijar a mano —para recuperar uno que los productos ya usen—
  // o se saca del nombre, que es lo normal.
  const id = slugify(body.id ? requireString(body.id, 'id', 40) : nombre);
  if (!id) {
    throw ApiError.badRequest(
      'id-invalido',
      'El nombre debe tener al menos una letra o un número.',
    );
  }

  const existe = await env.DB.prepare(`SELECT nombre FROM categories WHERE id = ?1`)
    .bind(id)
    .first<{ nombre: string }>();

  if (existe) {
    throw ApiError.conflict(
      'categoria-repetida',
      `Ya existe una categoría con ese identificador: «${existe.nombre}».`,
    );
  }

  const grupoAdmin =
    body.grupoAdmin === undefined
      ? await validarGrupo(env, 'agroindustriales')
      : await validarGrupo(env, body.grupoAdmin);

  await env.DB.prepare(
    `INSERT INTO categories (id, nombre, descripcion, icono, grupo_admin_id, orden, activo)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      nombre,
      body.descripcion === undefined ? '' : readDescripcion(body.descripcion),
      body.icono === undefined ? '' : readIcono(body.icono),
      grupoAdmin,
      body.orden === undefined ? 100 : Number(body.orden),
      body.activo === 0 ? 0 : 1,
    )
    .run();

  const created = await env.DB.prepare(`SELECT ${COLUMNS} FROM categories WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ category: created }, 201);
}

/**
 * PUT /api/admin/categories/:id
 *
 * El id no se puede cambiar: es la clave por la que apuntan los productos, y
 * renombrarlo los dejaría huérfanos. Para «cambiarle el nombre» está `nombre`,
 * que es lo que de verdad se lee en la tienda.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  id: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<CategoryBody>(request);

  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (body.nombre !== undefined) {
    sets.push(`nombre = ?${bindings.push(requireString(body.nombre, 'nombre', 60))}`);
  }
  if (body.descripcion !== undefined) {
    sets.push(
      `descripcion = ?${bindings.push(readDescripcion(body.descripcion))}`,
    );
  }
  if (body.icono !== undefined) {
    sets.push(`icono = ?${bindings.push(readIcono(body.icono))}`);
  }
  if (body.grupoAdmin !== undefined) {
    sets.push(`grupo_admin_id = ?${bindings.push(await validarGrupo(env, body.grupoAdmin))}`);
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
    `UPDATE categories SET ${sets.join(', ')} WHERE id = ?${bindings.length}`,
  )
    .bind(...bindings)
    .run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Esa categoría no existe.');
  }

  const updated = await env.DB.prepare(`SELECT ${COLUMNS} FROM categories WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ category: updated });
}

/**
 * DELETE /api/admin/categories/:id — solo si está vacía.
 *
 * Borrar una con productos dentro los dejaría apuntando a un id inexistente:
 * desaparecerían de todos los chips y solo se encontrarían por búsqueda. Es
 * exactamente el fallo que esta tabla viene a cerrar, así que aquí se rechaza
 * diciendo cuántos hay que mover antes.
 *
 * Para dejar de ofrecer una categoría sin vaciarla está `activo = 0`.
 */
export async function remove(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const enUso = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM products WHERE categoria_id = ?1`,
  )
    .bind(id)
    .first<{ n: number }>();

  if (enUso && enUso.n > 0) {
    throw ApiError.conflict(
      'categoria-en-uso',
      `Todavía hay ${enUso.n} producto(s) en esta categoría. Muévelos a otra antes de borrarla, ` +
        `o desactívala si solo quieres dejar de ofrecerla.`,
      { productos: enUso.n },
    );
  }

  const result = await env.DB.prepare(`DELETE FROM categories WHERE id = ?1`).bind(id).run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Esa categoría no existe.');
  }

  return json({ ok: true });
}
