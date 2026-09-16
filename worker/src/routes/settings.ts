import { ApiError, json, readJson, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { requireRole } from '../auth/middleware';

/**
 * Ajustes de operación — banderas que se cambian en vivo desde el panel.
 *
 * Clave-valor y no una columna por ajuste: son opciones de cómo se opera, no
 * entidades del negocio, y añadir la siguiente no puede costar una migración.
 *
 * La lista blanca de abajo no es burocracia: sin ella, este endpoint sería un
 * almacén de texto arbitrario donde cualquiera con sesión podría escribir lo
 * que quisiera, y nadie sabría al leer el código qué ajustes existen de verdad.
 */
/**
 * `tipo` decide cómo lo pinta el panel: `booleano` es un interruptor Sí/No
 * (el valor guardado sigue siendo '0'/'1', que es lo que ya entendían
 * `leerAjuste()` y el resto del código — esto es una pista de presentación,
 * no un tipo de columna nuevo); `texto` es un campo libre.
 */
const AJUSTES: Record<string, { descripcion: string; porDefecto: string; tipo: 'texto' | 'booleano' }> = {
  pos_recibo_por_defecto: {
    descripcion: 'Si la caja marca "imprimir recibo" al abrir una venta nueva.',
    porDefecto: '1',
    tipo: 'booleano',
  },

  // ── Módulos activables (generalización a cualquier tipo de negocio) ──
  //
  // Mermas, compras a fincas, mayoristas, caja física y domicilios son
  // funcionalidades reales para un negocio de productos físicos, pero no le
  // sirven de nada a un cliente que solo vende servicios reservables (0038):
  // un operador de tours no tiene inventario que dar de baja ni fincas a las
  // que comprarle. Antes esas secciones aparecían siempre en el menú del
  // panel, sin forma de ocultarlas sin tocar código. Todas nacen en '1' —
  // activadas— para que el negocio actual (productos agrícolas) no cambie en
  // absoluto: apagarlas es una decisión explícita de quien clona el proyecto,
  // nunca el comportamiento por defecto.
  modulo_mermas: {
    descripcion: 'Bajas de inventario por merma (sección "Mermas" del panel).',
    porDefecto: '1',
    tipo: 'booleano',
  },
  modulo_compras_proveedores: {
    descripcion: 'Compras a proveedores/fincas, que suben el inventario (sección "Compras").',
    porDefecto: '1',
    tipo: 'booleano',
  },
  modulo_mayoristas: {
    descripcion: 'Niveles y tarifas de mayorista (sección "Mayoristas" y descuentos en la tienda).',
    porDefecto: '1',
    tipo: 'booleano',
  },
  modulo_pos: {
    descripcion: 'Punto de venta / caja física (sección "Caja" y su historial).',
    porDefecto: '1',
    tipo: 'booleano',
  },
  modulo_domicilios: {
    descripcion: 'Reparto a domicilio y el rol de domiciliario (sección "Entregas").',
    porDefecto: '1',
    tipo: 'booleano',
  },
  modulo_venta_por_peso: {
    descripcion: 'Vender un producto a granel, pesado en la caja (casilla en Inventario y en Caja).',
    porDefecto: '1',
    tipo: 'booleano',
  },

  // ── Marca del sitio (des-quemado de branding) ──
  //
  // Antes "Agricultores Orgánicos", el número de WhatsApp y los datos
  // bancarios estaban escritos en el código del frontend (index.html,
  // header, footer, checkout.service.ts, recibos, reportes exportables).
  // Clonar este proyecto para un cliente nuevo —una tienda de ropa, un
  // operador de tours— exigía grepear el repo entero. Viven aquí, con el
  // mismo patrón que `pos_recibo_por_defecto`, porque son exactamente eso:
  // ajustes de operación que un SUPER_ADMIN cambia sin desplegar, no
  // constantes del código. `GET /api/config` los sirve sin sesión —ver
  // `leerMarca()`— porque la tienda pública entera los necesita: el título
  // de la pestaña, el pie de página, el checkout.
  site_nombre: {
    descripcion: 'Nombre del sitio: título de la pestaña, marca del encabezado y del panel.',
    porDefecto: 'Agricultores Orgánicos',
    tipo: 'texto',
  },
  site_tagline: {
    descripcion: 'Frase corta junto al nombre, en el título de la pestaña.',
    porDefecto: 'Del surco a tu cocina',
    tipo: 'texto',
  },
  site_meta_descripcion: {
    descripcion: 'Descripción para buscadores y al compartir el enlace (meta description).',
    porDefecto:
      'Cooperativa de familias campesinas. Fruta, verdura y despensa orgánica cosechada el mismo día y entregada sin intermediarios.',
    tipo: 'texto',
  },
  site_footer_descripcion: {
    descripcion: 'Párrafo corto bajo la marca, en el pie de página.',
    porDefecto:
      'Una cooperativa de familias campesinas que vende directo, sin intermediarios. El 72 % de lo que pagas se queda en la finca.',
    tipo: 'texto',
  },
  contacto_whatsapp: {
    descripcion:
      'Número de WhatsApp para el checkout y la confirmación de pedidos, en formato internacional sin "+" (ej. 573001234567).',
    porDefecto: '573016066121',
    tipo: 'texto',
  },
  banco_nombre: {
    descripcion: 'Banco para la consignación manual del checkout.',
    porDefecto: 'Bancolombia',
    tipo: 'texto',
  },
  banco_tipo_cuenta: {
    descripcion: 'Tipo de cuenta para la consignación (ej. "Cuenta de ahorros").',
    porDefecto: 'Cuenta de ahorros',
    tipo: 'texto',
  },
  banco_numero_cuenta: {
    descripcion: 'Número de cuenta para la consignación.',
    porDefecto: '64715834837',
    tipo: 'texto',
  },
  banco_titular: {
    descripcion: 'Nombre del titular de la cuenta.',
    porDefecto: 'wveimar Mamian Ramirez',
    tipo: 'texto',
  },
  banco_titular_documento: {
    descripcion: 'Documento del titular, tal como se muestra en el checkout (ej. "cc 70-907-972").',
    porDefecto: 'cc 70-907-972',
    tipo: 'texto',
  },

  // ── Marca de cada vitrina (split QualityMarketShop / QualityTourShop) ──
  //
  // `site_nombre`/`site_tagline`/etc de arriba siguen siendo la marca del
  // *panel* (login, menú del admin) — no cambian. Mercado y Turismo ahora son
  // dos árboles de ruta independientes (`/mercado`, `/turismo`) que deben
  // "parecer 2 proyectos distintos", así que cada uno necesita su propio
  // nombre, frase y descripciones. WhatsApp y los datos bancarios NO se
  // duplican: son el mismo negocio por debajo, solo cambia la marca visible.
  site_nombre_mercado: {
    descripcion: 'Nombre de la vitrina de Mercado (/mercado): marca del encabezado y del pie.',
    porDefecto: 'QualityMarketShop',
    tipo: 'texto',
  },
  site_tagline_mercado: {
    descripcion: 'Frase corta de la vitrina de Mercado, en el título de la pestaña.',
    porDefecto: 'Del surco a tu cocina',
    tipo: 'texto',
  },
  site_meta_descripcion_mercado: {
    descripcion: 'Meta description de la vitrina de Mercado, para buscadores y al compartir el enlace.',
    porDefecto:
      'Cooperativa de familias campesinas. Fruta, verdura y despensa orgánica cosechada el mismo día y entregada sin intermediarios.',
    tipo: 'texto',
  },
  site_footer_descripcion_mercado: {
    descripcion: 'Párrafo corto bajo la marca, en el pie de página de Mercado.',
    porDefecto:
      'Una cooperativa de familias campesinas que vende directo, sin intermediarios. El 72 % de lo que pagas se queda en la finca.',
    tipo: 'texto',
  },
  site_nombre_turismo: {
    descripcion: 'Nombre de la vitrina de Turismo (/turismo): marca del encabezado y del pie.',
    porDefecto: 'QualityTourShop',
    tipo: 'texto',
  },
  site_tagline_turismo: {
    descripcion: 'Frase corta de la vitrina de Turismo, en el título de la pestaña.',
    porDefecto: 'Experiencias para vivir',
    tipo: 'texto',
  },
  site_meta_descripcion_turismo: {
    descripcion: 'Meta description de la vitrina de Turismo, para buscadores y al compartir el enlace.',
    porDefecto: 'Tours, actividades y alojamiento en el Oriente antioqueño, reservables en línea.',
    tipo: 'texto',
  },
  site_footer_descripcion_turismo: {
    descripcion: 'Párrafo corto bajo la marca, en el pie de página de Turismo.',
    porDefecto: 'Experiencias reservables con disponibilidad real: tours, actividades y alojamiento.',
    tipo: 'texto',
  },
};

/** Las claves de marca, servidas juntas por `leerMarca()`. */
const CLAVES_MARCA = [
  'site_nombre',
  'site_tagline',
  'site_meta_descripcion',
  'site_footer_descripcion',
  'contacto_whatsapp',
  'banco_nombre',
  'banco_tipo_cuenta',
  'banco_numero_cuenta',
  'banco_titular',
  'banco_titular_documento',
  'site_nombre_mercado',
  'site_tagline_mercado',
  'site_meta_descripcion_mercado',
  'site_footer_descripcion_mercado',
  'site_nombre_turismo',
  'site_tagline_turismo',
  'site_meta_descripcion_turismo',
  'site_footer_descripcion_turismo',
] as const;

/**
 * Los ajustes de marca, todos de una vez — para `GET /api/config`.
 *
 * Una sola consulta, igual que `list()`: `app_settings` es una tabla
 * pequeña, y leerla entera de una vez es más barato que una `SELECT` por
 * clave. El público la pide en cada carga de la tienda, así que el costo de
 * ir diez veces a la base en vez de una sí se nota.
 */
export async function leerMarca(env: Env): Promise<Record<(typeof CLAVES_MARCA)[number], string>> {
  const { results } = await env.DB.prepare(`SELECT clave, valor FROM app_settings`).all<{
    clave: string;
    valor: string;
  }>();
  const guardados = new Map(results.map((r) => [r.clave, r.valor]));

  const salida = {} as Record<(typeof CLAVES_MARCA)[number], string>;
  for (const clave of CLAVES_MARCA) {
    salida[clave] = guardados.get(clave) ?? AJUSTES[clave].porDefecto;
  }
  return salida;
}

/** Lee un ajuste con su valor por defecto si nadie lo ha tocado nunca. */
export async function leerAjuste(env: Env, clave: string): Promise<string> {
  const fila = await env.DB.prepare(`SELECT valor FROM app_settings WHERE clave = ?1`)
    .bind(clave)
    .first<{ valor: string }>();

  return fila?.valor ?? AJUSTES[clave]?.porDefecto ?? '';
}

/**
 * GET /api/admin/settings — todos los ajustes conocidos, con su valor actual.
 *
 * Cualquier rol del panel, no solo `GESTOR_PEDIDOS`: los módulos activables
 * de arriba deciden qué ve el menú de CADA rol —un `ADMIN_INVENTARIO`
 * necesita saber si "Mermas" está activo tanto como un `GESTOR_PEDIDOS`
 * necesita saberlo de "Caja"—, así que negarle la lectura a la mitad del
 * panel dejaría su menú sin poder ocultar nada. Escribir sigue siendo solo
 * `SUPER_ADMIN`, ahí abajo en `update()`.
 */
export async function list(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'GESTOR_PEDIDOS', 'ADMIN_INVENTARIO', 'DOMICILIARIO');

  const { results } = await env.DB.prepare(`SELECT clave, valor FROM app_settings`).all<{
    clave: string;
    valor: string;
  }>();

  const guardados = new Map(results.map((r) => [r.clave, r.valor]));

  // Se responde la lista completa de ajustes conocidos, no solo los que tienen
  // fila: así el panel puede pintar uno recién añadido sin que nadie lo haya
  // guardado todavía.
  const ajustes = Object.entries(AJUSTES).map(([clave, meta]) => ({
    clave,
    descripcion: meta.descripcion,
    tipo: meta.tipo,
    valor: guardados.get(clave) ?? meta.porDefecto,
  }));

  return json({ ajustes });
}

/**
 * PUT /api/admin/settings — cambia un ajuste.
 *
 * `SUPER_ADMIN`: esto cambia cómo se comporta el sistema para todo el mundo, no
 * es una preferencia personal de quien está en la caja.
 */
export async function update(request: Request, env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'SUPER_ADMIN');

  const body = await readJson<{ clave?: unknown; valor?: unknown }>(request);
  const clave = requireString(body.clave, 'clave', 60);
  const valor = requireString(body.valor, 'valor', 500);

  if (!(clave in AJUSTES)) {
    throw ApiError.badRequest('ajuste-desconocido', `No existe un ajuste llamado "${clave}".`);
  }

  await env.DB.prepare(
    `INSERT INTO app_settings (clave, valor, actualizado_en)
     VALUES (?1, ?2, datetime('now'))
     ON CONFLICT (clave) DO UPDATE SET valor = ?2, actualizado_en = datetime('now')`,
  )
    .bind(clave, valor)
    .run();

  return json({ clave, valor });
}
