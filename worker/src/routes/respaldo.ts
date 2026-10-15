import { ApiError, json, readJson } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Copias de seguridad: bajar toda la base a un archivo y volver a subirla.
 *
 * ── Por qué esto existiendo Time Travel ──
 *
 * D1 guarda solo el estado de los últimos 30 días y vive dentro de la cuenta
 * de Cloudflare. Esto cubre lo otro: una copia más vieja que ese mes, y una
 * copia que sobrevive a perder la cuenta. Para «deshacer lo de esta mañana»,
 * Time Travel es mejor y no hace falta tocar esta pantalla.
 *
 * ── Por qué JSON y no SQL ──
 *
 * Un archivo .sql que el servidor ejecute es ejecución de SQL arbitrario por
 * HTTP: quien robe una sesión de SUPER_ADMIN deja de estar limitado a lo que
 * la aplicación sabe hacer. Aquí el archivo es datos, no instrucciones: se
 * leen las tablas de TABLAS y nada más, y cada valor viaja como parámetro
 * ligado, nunca concatenado en la sentencia.
 *
 * Esa decisión además esquiva el tope de 100 KB por sentencia de D1: la foto
 * de un producto pesa ~190 KB y rompería un INSERT escrito a mano, pero como
 * parámetro ligado no cuenta para ese límite.
 */

/**
 * Las tablas, en orden de inserción: cada una después de aquellas a las que
 * apunta. El orden sale del grafo de claves foráneas del esquema; para
 * borrar se recorre al revés.
 *
 * No están todas las del esquema a propósito:
 *
 * · `d1_migrations` es de wrangler, no del negocio. Restaurarla le mentiría
 *   sobre qué migraciones corrieron y la siguiente se aplicaría dos veces.
 * · `login_attempts` y `password_resets` son rastros de seguridad que caducan
 *   solos. Guardarlos no aporta nada y reponer intentos de login viejos puede
 *   dejar a alguien bloqueado sin motivo.
 */
const TABLAS = [
  'admin_groups',
  'app_settings',
  'contacts',
  'users',
  'user_roles',
  'treasury_accounts',
  'categories',
  'products',
  'product_components',
  'product_wholesale_discounts',
  'cash_closings',
  'cashier_shifts',
  'orders',
  'order_items',
  'order_item_components',
  'order_status_log',
  'invoices',
  'invoice_items',
  'invoice_refunds',
  'payments',
  'payment_allocations',
  'provider_purchases',
  'provider_purchase_items',
  'provider_payments',
  'expenses',
  'mermas',
  'merma_items',
  'treasury_movements',
] as const;

type Tabla = (typeof TABLAS)[number];

/**
 * Tablas que se apuntan a sí mismas. Dentro de ellas, las filas sin padre van
 * primero: una variante insertada antes que su ficha madre viola la clave
 * foránea, y lo mismo una nota crédito antes que la factura que corrige.
 */
const AUTORREFERENCIA: Partial<Record<Tabla, string>> = {
  products: 'parent_id',
  invoices: 'invoice_origen_id',
};

/** Sube con cada copia para que al restaurar se sepa qué se está metiendo. */
const FORMATO = 1;

interface Archivo {
  readonly formato: number;
  readonly generadoEn: string;
  readonly tablas: Record<string, readonly Record<string, unknown>[]>;
}

/**
 * Columnas reales de una tabla, preguntadas al esquema.
 *
 * Se consultan en vez de escribirlas aquí porque una copia hecha antes de una
 * migración trae columnas que ya no existen —o le faltan las nuevas— y hay que
 * saber cuáles aceptar sin reventar. Lo que el archivo traiga de más se ignora
 * con un aviso; lo que falte queda en su valor por defecto.
 */
async function columnasDe(env: Env, tabla: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM pragma_table_info(?1)`,
  )
    .bind(tabla)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

/**
 * GET /api/admin/respaldo — toda la base, en un JSON.
 *
 * Va entero en memoria y en una sola respuesta. Con el tamaño que tiene un
 * negocio de esta escala (unos pocos MB, casi todo fotos) es lo más simple que
 * funciona; si algún día no cupiera, el síntoma sería claro y el arreglo es
 * paginar por tabla.
 */
export async function descargar(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const tablas: Record<string, readonly Record<string, unknown>[]> = {};

  for (const tabla of TABLAS) {
    const columnaPadre = AUTORREFERENCIA[tabla];
    // Las filas se guardan ya ordenadas: así restaurar es leer y escribir, sin
    // tener que volver a razonar sobre quién depende de quién.
    const orden = columnaPadre ? `(${columnaPadre} IS NOT NULL), rowid` : 'rowid';
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${tabla} ORDER BY ${orden}`,
    ).all<Record<string, unknown>>();
    tablas[tabla] = results;
  }

  const archivo: Archivo = {
    formato: FORMATO,
    generadoEn: new Date().toISOString(),
    tablas,
  };

  const fecha = archivo.generadoEn.slice(0, 10);
  return json(archivo, 200, {
    'content-disposition': `attachment; filename="respaldo-agricultores-${fecha}.json"`,
  });
}

/** Cuántas filas se escriben por lote. */
const LOTE = 20;

/**
 * POST /api/admin/respaldo/restaurar — borra todo y repone lo del archivo.
 *
 * ── Sobre la atomicidad ──
 *
 * `batch()` de D1 sí es atómico, pero una base entera no cabe en un lote: las
 * fotos son demasiado grandes y la restauración se parte en varios. Si uno
 * falla a mitad, la base queda incompleta — y por eso la respuesta de error
 * dice explícitamente que se puede volver atrás con Time Travel, que es la
 * única garantía real que hay aquí.
 *
 * El borrado sí va entero en un lote: es poca sentencia y mucho lo que se
 * juega, y así nunca se queda medio vaciada.
 */
export async function restaurar(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const cuerpo = await readJson<Partial<Archivo>>(request);

  if (cuerpo.formato !== FORMATO) {
    throw ApiError.badRequest(
      'formato-desconocido',
      `Este archivo es de otro formato (${cuerpo.formato ?? 'ninguno'}). Esta versión lee el ${FORMATO}.`,
    );
  }
  if (!cuerpo.tablas || typeof cuerpo.tablas !== 'object') {
    throw ApiError.badRequest('archivo-invalido', 'El archivo no tiene datos que restaurar.');
  }

  // Un archivo sin productos ni contactos casi seguro es el archivo
  // equivocado, y restaurarlo deja el negocio en blanco. Vale más un 400.
  const productos = cuerpo.tablas['products'];
  if (!Array.isArray(productos) || productos.length === 0) {
    throw ApiError.badRequest(
      'archivo-vacio',
      'El archivo no trae ningún producto. Si de verdad quieres dejar la base en blanco, usa la limpieza, no una restauración.',
    );
  }

  const avisos: string[] = [];
  const escritas: Record<string, number> = {};

  // ── 1. Vaciar, en orden inverso al de dependencias ──
  const borrados = [...TABLAS].reverse().map((t) => env.DB.prepare(`DELETE FROM ${t}`));
  try {
    await env.DB.batch(borrados);
  } catch (error) {
    throw ApiError.badRequest(
      'no-se-pudo-vaciar',
      `No se pudo vaciar la base para restaurar: ${(error as Error).message}`,
    );
  }

  // ── 2. Reponer, en orden de dependencias ──
  for (const tabla of TABLAS) {
    const filas = cuerpo.tablas[tabla];
    if (!Array.isArray(filas) || filas.length === 0) {
      continue;
    }

    const validas = await columnasDe(env, tabla);
    const sentencias = [];

    for (const fila of filas) {
      if (!fila || typeof fila !== 'object') {
        continue;
      }
      // Solo columnas que existan hoy. Lo que sobre se deja fuera, y se avisa
      // una vez por tabla para que no se pierda en silencio.
      const cols = Object.keys(fila).filter((c) => validas.includes(c));
      const sobran = Object.keys(fila).filter((c) => !validas.includes(c));
      if (sobran.length && !avisos.some((a) => a.startsWith(`${tabla}:`))) {
        avisos.push(`${tabla}: se ignoraron columnas que ya no existen (${sobran.join(', ')}).`);
      }
      if (cols.length === 0) {
        continue;
      }

      const marcadores = cols.map((_, i) => `?${i + 1}`).join(', ');
      sentencias.push(
        env.DB.prepare(
          `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${marcadores})`,
        ).bind(...cols.map((c) => fila[c] ?? null)),
      );
    }

    // En lotes: una tabla de productos con fotos no cabe de una sola vez.
    for (let i = 0; i < sentencias.length; i += LOTE) {
      try {
        await env.DB.batch(sentencias.slice(i, i + LOTE));
      } catch (error) {
        throw ApiError.badRequest(
          'restauracion-incompleta',
          `Falló al reponer "${tabla}" (fila ${i + 1} en adelante): ${(error as Error).message}. ` +
            `La base quedó a medias. Se puede volver al estado anterior con Time Travel de Cloudflare: ` +
            `npx wrangler d1 time-travel restore DB --timestamp=<antes de ahora>`,
        );
      }
    }

    escritas[tabla] = sentencias.length;
  }

  return json({ restaurado: { generadoEn: cuerpo.generadoEn, tablas: escritas }, avisos });
}
