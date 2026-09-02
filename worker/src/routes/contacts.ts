import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload, UserRole } from '../types';
import { requireRole } from '../auth/middleware';
import { loadUserRoles } from '../pricing';

/**
 * La agenda: proveedores y clientes en una sola lista.
 *
 * Son la misma clase de cosa —alguien con nombre, teléfono y dirección con
 * quien se mueve dinero— y la misma persona puede ser las dos. Por eso
 * `esProveedor` y `esCliente` son banderas independientes y no un tipo
 * excluyente (ver la migración 0022).
 *
 * ── Lo que esta tabla NO decide ──
 *
 * De qué finca viene un producto. `products.origen` sigue siendo texto suelto
 * a propósito: la misma lechuga se le compra a una vereda esta semana y a otra
 * la siguiente, y una columna en el producto no puede decir eso. Quién puso la
 * mercancía se responde por compra, en `provider_purchases.contact_id`.
 */

const TIPOS_CUENTA = ['ahorros', 'corriente', 'nequi', 'daviplata'] as const;
type TipoCuenta = (typeof TIPOS_CUENTA)[number];

/** Campo opcional: '' y null se guardan como NULL, no como cadena vacía. */
function opcional(value: unknown, field: string, maxLength = 200): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return requireString(value, field, maxLength);
}

function leerTipoCuenta(value: unknown): TipoCuenta | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const tipo = requireString(value, 'tipoCuenta', 20);
  if (!TIPOS_CUENTA.includes(tipo as TipoCuenta)) {
    throw ApiError.badRequest(
      'tipo-cuenta-invalido',
      `"tipoCuenta" debe ser uno de: ${TIPOS_CUENTA.join(', ')}.`,
    );
  }
  return tipo as TipoCuenta;
}

/** `1`/`true` → 1. Cualquier otra cosa → 0. */
function bandera(value: unknown): number {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

/**
 * Lo que el formulario manda, ya validado.
 *
 * El teléfono se normaliza quitando espacios y guiones: es la llave con la que
 * el checkout de invitado reencuentra a un cliente, y "300 123 4567" y
 * "3001234567" tienen que ser la misma persona.
 */
interface ContactoEntrada {
  nombre: string;
  esProveedor: number;
  esCliente: number;
  telefono: string | null;
  direccion: string | null;
  notas: string | null;
  banco: string | null;
  tipoCuenta: TipoCuenta | null;
  numeroCuenta: string | null;
  titular: string | null;
  documento: string | null;
  /** Cuánto se le puede fiar. 0 = no se le fía. Ver la migración 0023. */
  cupoCredito: number;
  diasCredito: number;
  activo: number;
}

/**
 * La cédula, sin puntos ni espacios.
 *
 * Se guarda normalizada por lo mismo que el teléfono: "1.020.145.588" y
 * "1020145588" son la misma persona, y el índice único no lo sabría. Sin
 * esto, el mismo cliente entraría dos veces según cómo lo teclee cada quien —
 * que es exactamente lo que el UNIQUE viene a impedir.
 *
 * No se valida el dígito de verificación ni la longitud: aquí entran cédulas
 * de ciudadanía, de extranjería, NIT y pasaportes, y cada uno tiene su forma.
 * Rechazar por formato dejaría fuera a clientes reales en el mostrador.
 */
export function normalizarDocumento(value: string): string {
  const limpio = value.replace(/[.\s-]/g, '').toUpperCase();
  if (limpio === '') {
    throw ApiError.badRequest(
      'documento-requerido',
      'La cédula es obligatoria: es con lo que se identifica al cliente en la caja y lo que se reporta al facturar.',
    );
  }
  return limpio;
}

export function normalizarTelefono(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const limpio = value.replace(/[\s()-]/g, '');
  return limpio === '' ? null : limpio;
}

async function leerCuerpo(request: Request): Promise<ContactoEntrada> {
  const body = await readJson<Record<string, unknown>>(request);

  const esProveedor = bandera(body['esProveedor']);
  const esCliente = bandera(body['esCliente']);

  // El CHECK de la tabla lo rechazaría igual, pero un 400 que dice qué falta
  // es más útil que un 500 con el texto de SQLite.
  if (esProveedor === 0 && esCliente === 0) {
    throw ApiError.badRequest(
      'sin-tipo',
      'Marca si es proveedor, cliente o las dos cosas: si no, no aparecería en ninguna lista.',
    );
  }

  return {
    nombre: requireString(body['nombre'], 'nombre', 160),
    esProveedor,
    esCliente,
    telefono: normalizarTelefono(opcional(body['telefono'], 'telefono', 40)),
    direccion: opcional(body['direccion'], 'direccion', 240),
    notas: opcional(body['notas'], 'notas', 1000),
    banco: opcional(body['banco'], 'banco', 80),
    tipoCuenta: leerTipoCuenta(body['tipoCuenta']),
    numeroCuenta: opcional(body['numeroCuenta'], 'numeroCuenta', 40),
    titular: opcional(body['titular'], 'titular', 160),
    documento: normalizarDocumento(requireString(body['documento'], 'documento', 40)),
    // Solo tiene sentido para un cliente: a un proveedor se le paga, no se le
    // fía. Se guarda igual si viene —no estorba— y la pantalla solo lo ofrece
    // cuando la ficha está marcada como cliente.
    cupoCredito:
      body['cupoCredito'] === undefined || body['cupoCredito'] === null
        ? 0
        : requireInt(body['cupoCredito'], 'cupoCredito', 0),
    diasCredito:
      body['diasCredito'] === undefined || body['diasCredito'] === null
        ? 0
        : requireInt(body['diasCredito'], 'diasCredito', 0),
    activo: body['activo'] === undefined ? 1 : bandera(body['activo']),
  };
}

const COLUMNAS = `
  id, nombre,
  es_proveedor  AS esProveedor,
  es_cliente    AS esCliente,
  telefono, direccion, notas,
  banco,
  tipo_cuenta   AS tipoCuenta,
  numero_cuenta AS numeroCuenta,
  titular, documento,
  cupo_credito  AS cupoCredito,
  dias_credito  AS diasCredito,
  activo,
  creado_en     AS creadoEn`;

/**
 * GET /api/admin/contacts/search?query=… — el buscador del mostrador.
 *
 * Una sola caja de texto que resuelve las tres formas en que un cliente se
 * identifica en una fila: dicta su cédula, dice su nombre, o da el teléfono
 * con el que compró la vez pasada. El cajero no debería tener que elegir en
 * qué campo busca — teclea lo que le digan y el servidor decide.
 *
 * ── Por qué no reutiliza `list()` ──
 *
 * `list()` trae la agenda entera con el resumen de compras y pedidos de cada
 * ficha: cuatro subconsultas por fila. Eso está bien para una pantalla que se
 * abre una vez, y muy mal para algo que se dispara con cada tecla. Aquí solo
 * viaja lo que hace falta para decidir a quién se le está vendiendo.
 *
 * ── Qué devuelve además de la ficha ──
 *
 * El cupo y la deuda viva, porque son lo que el cajero necesita ANTES de
 * empezar a marcar productos: si el cliente ya se pasó del cupo, es mejor
 * saberlo al identificarlo que al intentar cobrar con el ticket lleno.
 *
 * Y el nivel de precios, que sale de los roles de la cuenta enlazada a la
 * ficha. Sin esto la caja no puede avisar "este cliente es mayorista N2" y el
 * cajero cantaría un precio de lista que luego el servidor va a rebajar.
 */
export async function search(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const query = (url.searchParams.get('query') ?? '').trim();

  // Con menos de dos caracteres, cualquier LIKE devuelve media agenda. Se
  // responde vacío en vez de hacer trabajar a la base para nada: el primer
  // carácter de una búsqueda nunca es una respuesta útil.
  if (query.length < 2) {
    return json({ contactos: [] });
  }

  // Se busca contra el documento y el teléfono YA NORMALIZADOS: si alguien
  // teclea "1.020.145" hay que encontrar la ficha que guarda "1020145". Sin
  // esto, buscar por cédula con puntos no daría nunca un resultado.
  const patron = `%${query}%`;
  const patronLimpio = `%${query.replace(/[.\s-]/g, '')}%`;

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nombre, c.documento, c.telefono, c.direccion,
            c.cupo_credito AS cupoCredito,
            c.dias_credito AS diasCredito,
            -- Lo que debe de verdad: facturas vivas, sin contar las anuladas
            -- ni las notas. Misma definición que usa Cartera.
            COALESCE((
              SELECT SUM(i.saldo) FROM invoices i
               WHERE i.contact_id = c.id
                 AND i.estado <> 'anulada'
                 AND i.tipo = 'factura'
            ), 0) AS deuda,
            -- El nivel de precios sale de la cuenta enlazada, si la hay. Se
            -- devuelve el rol crudo; traducirlo a "Mayorista N2" es cosa de
            -- la pantalla, no de la base.
            (SELECT r.role FROM user_roles r
               JOIN users u ON u.id = r.user_id
              WHERE u.contact_id = c.id
                AND u.activo = 1
                AND r.role LIKE 'MAYORISTA_%'
              ORDER BY r.role DESC LIMIT 1) AS nivelPrecio
       FROM contacts c
      WHERE c.activo = 1
        AND c.es_cliente = 1
        AND (
          c.documento LIKE ?2
          OR c.nombre LIKE ?1
          OR REPLACE(REPLACE(REPLACE(IFNULL(c.telefono, ''), ' ', ''), '-', ''), '.', '') LIKE ?2
        )
      -- La coincidencia exacta de cédula primero: cuando el cliente dicta su
      -- número completo, esa es LA ficha y no una más de la lista.
      ORDER BY (c.documento = ?3) DESC, c.nombre COLLATE NOCASE
      LIMIT 15`,
  )
    .bind(patron, patronLimpio, query.replace(/[.\s-]/g, '').toUpperCase())
    .all();

  return json({ contactos: results });
}

/**
 * GET /api/admin/contacts — la agenda.
 *
 * `tipo=proveedor|cliente` filtra por bandera; sin él vienen todos. Cada ficha
 * trae además su resumen —cuántas compras/pedidos y por cuánto— porque es lo
 * que convierte una lista de teléfonos en algo con lo que decidir. Se calcula
 * con subconsultas y no con JOIN + GROUP BY para que un contacto sin
 * movimientos siga apareciendo con ceros en vez de desaparecer.
 */
export async function list(env: Env, user: JwtPayload, url: URL): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const tipo = url.searchParams.get('tipo');
  const incluirInactivos = url.searchParams.get('inactivos') === '1';

  const filtros: string[] = [];
  if (tipo === 'proveedor') {
    filtros.push('c.es_proveedor = 1');
  }
  if (tipo === 'cliente') {
    filtros.push('c.es_cliente = 1');
  }
  if (!incluirInactivos) {
    filtros.push('c.activo = 1');
  }
  const where = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nombre,
            c.es_proveedor  AS esProveedor,
            c.es_cliente    AS esCliente,
            c.telefono, c.direccion, c.notas,
            c.banco,
            c.tipo_cuenta   AS tipoCuenta,
            c.numero_cuenta AS numeroCuenta,
            c.titular, c.documento,
            c.cupo_credito  AS cupoCredito,
            c.dias_credito  AS diasCredito,
            c.activo,
            c.creado_en     AS creadoEn,
            (SELECT COUNT(*)            FROM provider_purchases p WHERE p.contact_id = c.id) AS compras,
            (SELECT COALESCE(SUM(p.total_pago), 0) FROM provider_purchases p WHERE p.contact_id = c.id) AS compradoTotal,
            (SELECT COALESCE(SUM(p.total_pago), 0) FROM provider_purchases p
              WHERE p.contact_id = c.id AND p.estado = 'pendiente')                          AS porPagar,
            (SELECT COUNT(*)            FROM orders o WHERE o.contact_id = c.id AND o.estado <> 'cancelado') AS pedidos,
            (SELECT COALESCE(SUM(o.subtotal), 0) FROM orders o
              WHERE o.contact_id = c.id AND o.estado <> 'cancelado')                         AS compradoPorEl,
            (SELECT MAX(o.creado_en)    FROM orders o WHERE o.contact_id = c.id)             AS ultimoPedido
       FROM contacts c
       ${where}
      ORDER BY c.nombre COLLATE NOCASE`,
  ).all();

  return json({ contactos: results });
}

/** POST /api/admin/contacts — alta manual desde el panel. */
export async function create(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const datos = await leerCuerpo(request);
  const id = crypto.randomUUID();

  await ejecutarCuidandoTelefono(async () => {
    await env.DB.prepare(
      `INSERT INTO contacts
         (id, nombre, es_proveedor, es_cliente, telefono, direccion, notas,
          banco, tipo_cuenta, numero_cuenta, titular, documento,
          cupo_credito, dias_credito, activo)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(
        id,
        datos.nombre,
        datos.esProveedor,
        datos.esCliente,
        datos.telefono,
        datos.direccion,
        datos.notas,
        datos.banco,
        datos.tipoCuenta,
        datos.numeroCuenta,
        datos.titular,
        datos.documento,
        datos.cupoCredito,
        datos.diasCredito,
        datos.activo,
      )
      .run();
  }, env, datos.telefono);

  return json({ contacto: await cargarUno(env, id) }, 201);
}

/** PATCH /api/admin/contacts/:id — corrige la ficha. */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  id: string,
): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const existe = await env.DB.prepare(`SELECT id FROM contacts WHERE id = ?1`).bind(id).first();
  if (!existe) {
    throw ApiError.notFound('Ese contacto no existe.');
  }

  const datos = await leerCuerpo(request);

  await ejecutarCuidandoTelefono(async () => {
    await env.DB.prepare(
      `UPDATE contacts
          SET nombre = ?2, es_proveedor = ?3, es_cliente = ?4, telefono = ?5,
              direccion = ?6, notas = ?7, banco = ?8, tipo_cuenta = ?9,
              numero_cuenta = ?10, titular = ?11, documento = ?12,
              cupo_credito = ?13, dias_credito = ?14, activo = ?15,
              actualizado_en = datetime('now')
        WHERE id = ?1`,
    )
      .bind(
        id,
        datos.nombre,
        datos.esProveedor,
        datos.esCliente,
        datos.telefono,
        datos.direccion,
        datos.notas,
        datos.banco,
        datos.tipoCuenta,
        datos.numeroCuenta,
        datos.titular,
        datos.documento,
        datos.cupoCredito,
        datos.diasCredito,
        datos.activo,
      )
      .run();
  }, env, datos.telefono, id);

  return json({ contacto: await cargarUno(env, id) });
}

/**
 * DELETE /api/admin/contacts/:id — borra la ficha.
 *
 * Solo si no tiene historial. Un contacto con compras o pedidos detrás no se
 * borra: se desactiva (`activo = 0`), y así deja de salir en los selectores
 * pero su nombre sigue explicando de dónde salió cada movimiento. Las FK son
 * SET NULL, así que borrarlo no rompería nada — pero dejaría compras sin
 * proveedor y pedidos sin cliente, que es peor que una ficha archivada.
 */
export async function remove(env: Env, user: JwtPayload, id: string): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO');

  const uso = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM provider_purchases WHERE contact_id = ?1) AS compras,
            (SELECT COUNT(*) FROM orders            WHERE contact_id = ?1) AS pedidos`,
  )
    .bind(id)
    .first<{ compras: number; pedidos: number }>();

  if (!uso) {
    throw ApiError.notFound('Ese contacto no existe.');
  }

  if (uso.compras > 0 || uso.pedidos > 0) {
    const partes: string[] = [];
    if (uso.compras > 0) partes.push(`${uso.compras} compra${uso.compras === 1 ? '' : 's'}`);
    if (uso.pedidos > 0) partes.push(`${uso.pedidos} pedido${uso.pedidos === 1 ? '' : 's'}`);

    throw ApiError.conflict(
      'contacto-con-historial',
      `No se puede borrar: tiene ${partes.join(' y ')} a su nombre. Desactívalo para que deje de salir en las listas sin perder el historial.`,
      { compras: uso.compras, pedidos: uso.pedidos },
    );
  }

  const result = await env.DB.prepare(`DELETE FROM contacts WHERE id = ?1`).bind(id).run();
  if (result.meta.changes === 0) {
    throw ApiError.notFound('Ese contacto no existe.');
  }

  return json({ ok: true });
}

/**
 * Encuentra al cliente por su teléfono, o lo crea.
 *
 * Es lo que hace que el checkout de invitado no duplique a la misma persona en
 * cada compra: no hay cuenta, así que el teléfono es lo único estable entre
 * dos pedidos suyos.
 *
 * Si el contacto ya existía como proveedor, se le enciende `es_cliente` en vez
 * de crear una segunda ficha: es exactamente el caso de la vereda a la que se
 * le compra y que también compra.
 *
 * Devuelve `null` en vez de propagar el error si algo sale mal: perder la
 * ficha de agenda es un fastidio, pero tumbar la compra de un cliente por eso
 * sería mucho peor. El pedido guarda su propia copia del nombre y la
 * dirección, así que no se pierde nada de lo que hace falta para entregarlo.
 */
export async function encontrarOCrearCliente(
  env: Env,
  datos: { nombre: string; telefono: string; direccion: string; documento: string },
): Promise<string | null> {
  const telefono = normalizarTelefono(datos.telefono);
  if (!telefono) {
    return null;
  }

  const documento = normalizarDocumento(datos.documento);

  try {
    // Primero por cédula —es la llave de negocio— y si no, por teléfono.
    // El segundo camino es el que reencuentra a quien ya compraba antes de
    // que la cédula fuera obligatoria: se le completa al vuelo en vez de
    // crearle una ficha nueva y partirle el historial en dos.
    const existente = await env.DB.prepare(
      `SELECT id, documento FROM contacts
        WHERE documento = ?2 OR telefono = ?1
        ORDER BY (documento = ?2) DESC LIMIT 1`,
    )
      .bind(telefono, documento)
      .first<{ id: string; documento: string }>();

    if (existente) {
      // La dirección se refresca a la del pedido más reciente; el nombre NO se
      // pisa: quien ya está en la agenda pudo haberse corregido a mano desde
      // el panel, y el checkout no debe deshacer esa edición.
      await env.DB.prepare(
        `UPDATE contacts
            SET es_cliente = 1, direccion = ?2, documento = ?3, actualizado_en = datetime('now')
          WHERE id = ?1`,
      )
        .bind(existente.id, datos.direccion, documento)
        .run();

      return existente.id;
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO contacts (id, nombre, es_cliente, telefono, direccion, documento)
       VALUES (?1, ?2, 1, ?3, ?4, ?5)`,
    )
      .bind(id, datos.nombre, telefono, datos.direccion, documento)
      .run();

    return id;
  } catch {
    return null;
  }
}

/**
 * La ficha enlazada a esta cuenta, si un SUPER_ADMIN la enlazó desde Usuarios
 * (migración 0024). `null` si la cuenta no tiene enlace — la mayoría no lo
 * tiene, y entonces el pedido cae al camino normal de buscar o crear la ficha
 * por teléfono, igual que a un invitado.
 *
 * Con enlace, la dirección de la ficha se refresca a la de este pedido, igual
 * que hace `encontrarOCrearCliente()`: es el dato que más cambia. El nombre no
 * se toca — la ficha pudo corregirse a mano desde el panel.
 */
export async function contactoDeUsuario(
  env: Env,
  userId: string,
  direccion: string,
): Promise<string | null> {
  const fila = await env.DB.prepare(`SELECT contact_id AS contactId FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ contactId: string | null }>();

  if (!fila?.contactId) {
    return null;
  }

  try {
    await env.DB.prepare(
      `UPDATE contacts SET direccion = ?2, actualizado_en = datetime('now') WHERE id = ?1`,
    )
      .bind(fila.contactId, direccion)
      .run();
  } catch {
    // Igual que en encontrarOCrearCliente(): la ficha es de conveniencia, no
    // debe tumbar un pedido que por lo demás está bien.
  }

  return fila.contactId;
}

/**
 * Los roles de la cuenta enlazada a una ficha, o ninguno si no hay cuenta.
 *
 * Es el camino inverso de `contactoDeUsuario()`: el checkout va de la sesión a
 * la ficha, y el punto de venta necesita ir de la ficha a los roles.
 *
 * Sin esto, un mayorista que entra a la tienda física pagaría precio de lista:
 * en el mostrador no hay sesión iniciada —el cajero identifica al cliente por
 * su ficha, no por un login— así que el descuento no tendría de dónde salir.
 *
 * Se leen de la base y no de ningún token, por lo mismo que documenta
 * `pricing.loadUserRoles`: un JWT puede ir hasta ocho horas desactualizado, y
 * quien acaba de dejar de ser mayorista no puede seguir comprando a su precio.
 */
export async function rolesDeContacto(env: Env, contactId: string): Promise<readonly UserRole[]> {
  const fila = await env.DB.prepare(`SELECT id FROM users WHERE contact_id = ?1 AND activo = 1`)
    .bind(contactId)
    .first<{ id: string }>();

  if (!fila) {
    return [];
  }

  return loadUserRoles(env, fila.id);
}

/**
 * Traduce el choque del índice único de teléfono a un mensaje que se entiende.
 *
 * Sin esto, guardar dos contactos con el mismo número devuelve el texto crudo
 * de SQLite, que no dice ni cuál es el otro contacto ni qué hacer.
 */
async function ejecutarCuidandoTelefono(
  accion: () => Promise<void>,
  env: Env,
  telefono: string | null,
  excluirId?: string,
): Promise<void> {
  try {
    await accion();
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    if (!mensaje.includes('UNIQUE constraint failed') || !telefono) {
      throw error;
    }

    const otro = await env.DB.prepare(
      `SELECT id, nombre FROM contacts WHERE telefono = ?1 AND (?2 IS NULL OR id <> ?2)`,
    )
      .bind(telefono, excluirId ?? null)
      .first<{ id: string; nombre: string }>();

    throw ApiError.conflict(
      'telefono-repetido',
      otro
        ? `Ese teléfono ya es de "${otro.nombre}". Si son la misma persona, edita esa ficha y márcala también como proveedor o cliente.`
        : 'Ese teléfono ya está en la agenda.',
      otro ? { contactId: otro.id, nombre: otro.nombre } : undefined,
    );
  }
}

async function cargarUno(env: Env, id: string): Promise<unknown> {
  const contacto = await env.DB.prepare(
    `SELECT ${COLUMNAS} FROM contacts WHERE id = ?1`,
  )
    .bind(id)
    .first();

  if (!contacto) {
    throw ApiError.notFound('Ese contacto no existe.');
  }
  return contacto;
}
