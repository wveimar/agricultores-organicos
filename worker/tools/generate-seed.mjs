/**
 * Genera worker/seed.sql a partir del catálogo que ya usa el frontend.
 *
 * Se importa el .ts directamente (Node 24 elimina los tipos al vuelo) en vez
 * de transcribir los 25 productos a mano: copiarlos garantizaría que backend y
 * frontend se desincronicen en el primer cambio de precio.
 *
 * Uso:  node worker/tools/generate-seed.mjs
 */
import { writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// Permite que los imports sin extensión del código Angular resuelvan a .ts.
register('./resolve-ts.mjs', import.meta.url);

// pathToFileURL es obligatorio en Windows: import() rechaza rutas tipo C:\...
const load = (relative) => import(pathToFileURL(join(root, relative)).href);

const { PRODUCTS } = await load('src/app/core/data/mock-catalog.ts');
const { ORDERS } = await load('src/app/core/data/mock-orders.ts');

/**
 * Las secciones de la vitrina, con su grupo de compras.
 *
 * Viven aquí y no en el frontend porque allí ya no existen: `CATEGORIES` y
 * `ADMIN_GROUP_OF` se mudaron a la tabla `categories` en la migración 0013,
 * que es la que el panel edita. El frontend las pide al servidor.
 *
 * Esto es la copia del **sembrado**, el equivalente para una base nueva de lo
 * que la 0013 hace sobre una existente: una actualiza lo que ya hay, la otra
 * puebla desde cero, y las dos tienen que decir lo mismo. Si se toca una,
 * tócase la otra — son diez filas que no cambian casi nunca.
 *
 * Antes esto no estaba, y el efecto era que tras un `db:reset` la tienda
 * quedaba con 25 productos y cero categorías: ni un chip en la vitrina.
 */
const CATEGORIES = [
  ['verduras', 'Verduras y raíces', 'Recolectadas al amanecer del domingo, en tu casa esa misma tarde.', 'verduras', 10],
  ['frutas', 'Frutas frescas', 'Maduradas en el árbol, nunca en cámara.', 'frutas', 20],
  ['lacteos', 'Leche de cabra', 'De un hato pequeño en el altiplano, ordeñado a mano.', 'agroindustriales', 30],
  ['mieles', 'Mieles y apicultura', 'Miel, polen y propóleo de colmenares propios, sin pasteurizar.', 'agroindustriales', 40],
  ['listos', 'Listos para comer', 'Preparados cada mañana con la cosecha del día.', 'agroindustriales', 50],
  ['fermentos', 'Fermentos', 'Kambuchas y fermentados vivos, embotellados sin pasteurizar.', 'agroindustriales', 60],
  ['panaderia', 'Panadería', 'Horneado el mismo día con harinas molidas en el altiplano.', 'agroindustriales', 70],
  ['granos', 'Granos y semillas', 'Molidos en piedra y empacados en lotes pequeños.', 'agroindustriales', 80],
  ['despensa', 'Despensa', 'Lo que sostiene la cocina durante todo el mes.', 'agroindustriales', 90],
  ['canastas', 'Canastas', 'La compra semanal resuelta en una sola caja.', 'agroindustriales', 100],
];

/** `categoria_id` → `grupo_admin`, que es lo que `products` guarda copiado. */
const GRUPO_DE = new Map(CATEGORIES.map(([id, , , grupo]) => [id, grupo]));

/**
 * Los grupos del panel de compras (migración 0025), con la misma bandera de
 * filtro fino que trae esa migración: solo 'agroindustriales' la enciende,
 * porque mezcla categorías muy distintas (lácteos, mieles, panadería…).
 *
 * Van en su propia tabla porque `categories` y `products` ahora guardan
 * `grupo_admin_id` como referencia a ella en vez de un literal fijo.
 */
const ADMIN_GROUPS = [
  ['frutas', 'Frutas', 0, 10, 'fruta'],
  ['verduras', 'Verduras', 0, 20, 'hoja'],
  ['agroindustriales', 'Agroindustriales', 1, 30, 'canasta'],
];

// ─────────────────── PBKDF2, idéntico al del Worker ───────────────────
// 100.000: tope duro del runtime real de Cloudflare Workers, no una elección
// de estilo. Ver el comentario largo en worker/src/auth/crypto.ts.
const PBKDF2_ITERATIONS = 100_000;

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const baseKey = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

/** Escapa comillas simples para SQL literal. */
const q = (value) =>
  value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`;

const USERS = [
  { id: 'u-01', email: 'inventario@agricultores.co', nombre: 'Sara Villamil', roles: ['ADMIN_INVENTARIO'] },
  { id: 'u-02', email: 'pedidos@agricultores.co', nombre: 'Diana Cardona', roles: ['GESTOR_PEDIDOS'] },
  { id: 'u-03', email: 'admin@agricultores.co', nombre: 'Nicolás Ruiz', roles: ['SUPER_ADMIN'] },
];

const DEMO_PASSWORD = 'demo1234';

const lines = [
  '-- ============================================================',
  '--  GENERADO por worker/tools/generate-seed.mjs — no editar a mano.',
  '--  Regenerar con:  npm run db:seed:build',
  '--',
  `--  Contraseña de todas las cuentas de demo: ${DEMO_PASSWORD}`,
  '--  Los hashes son PBKDF2-SHA256 y llevan su propio salt aleatorio,',
  '--  por eso cambian en cada regeneración aunque la clave sea la misma.',
  '-- ============================================================',
  '',
  // Antes que `orders`: la FK de la factura al pedido es ON DELETE RESTRICT,
  // así que borrar pedidos con factura viva fallaría.
  // El reparto antes que los cobros, y los cobros antes que las facturas: la
  // FK de `payment_allocations` a `invoices` es RESTRICT, así que una factura
  // con plata asignada no se deja borrar. Es la misma protección que impide
  // borrarla desde el panel.
  'DELETE FROM payment_allocations;',
  'DELETE FROM payments;',
  'DELETE FROM invoice_items;',
  // Las notas antes que las facturas: aunque la FK sea CASCADE, borrarlas
  // explícitamente deja claro el orden y no depende del motor.
  "DELETE FROM invoices WHERE tipo <> 'factura';",
  'DELETE FROM invoices;',
  'DELETE FROM order_items;',
  'DELETE FROM orders;',
  'DELETE FROM contacts;',
  'DELETE FROM cash_closings;',
  'DELETE FROM user_roles;',
  'DELETE FROM users;',
  'DELETE FROM products;',
  'DELETE FROM categories;',
  'DELETE FROM admin_groups;',
  '',
  '-- ─────────────────────────── Usuarios ───────────────────────────',
];

for (const user of USERS) {
  const hash = await hashPassword(DEMO_PASSWORD);
  lines.push(
    `INSERT INTO users (id, email, nombre, password_hash) VALUES (${q(user.id)}, ${q(user.email)}, ${q(user.nombre)}, ${q(hash)});`,
  );
  for (const role of user.roles) {
    lines.push(`INSERT INTO user_roles (user_id, role) VALUES (${q(user.id)}, ${q(role)});`);
  }
}

lines.push('', '-- ────────────────────── Grupos del panel de compras ──────────────────────');

// Antes que las categorías: `categories.grupo_admin_id` apunta aquí.
for (const [id, nombre, mostrarFiltroFino, orden, icono] of ADMIN_GROUPS) {
  lines.push(
    `INSERT INTO admin_groups (id, nombre, mostrar_filtro_fino, orden, icono) VALUES (` +
      [q(id), q(nombre), mostrarFiltroFino, orden, q(icono)].join(', ') +
      ');',
  );
}

lines.push('', '-- ─────────────────────────── Categorías ───────────────────────────');

// Antes que los productos: `products.categoria_id` apunta aquí (por
// convención, sin FK), y una vitrina con productos y sin categorías no
// muestra ni un chip.
for (const [id, nombre, descripcion, grupo, orden] of CATEGORIES) {
  lines.push(
    `INSERT INTO categories (id, nombre, descripcion, grupo_admin_id, orden) VALUES (` +
      [q(id), q(nombre), q(descripcion), q(grupo), orden].join(', ') +
      ');',
  );
}

lines.push('', '-- ─────────────────────────── Productos ───────────────────────────');

// Solo para probar la venta por peso (migración 0033): la Papa Nativa ya se
// vendía en 'kg', así que es el candidato natural para pesarse a granel en
// vez de venderse en bultos de kilo entero. `Product` (mock-catalog.ts) no
// lleva este campo porque es un dato de operación de caja, no de catálogo
// público — de ahí que viva aquí, no en el modelo.
const VENDIDOS_POR_PESO = new Set(['p-03']);

for (const p of PRODUCTS) {
  const grupo = GRUPO_DE.get(p.categoryId);
  if (!grupo) {
    // Un producto con una categoría que no está sembrada entraría con
    // `grupo_admin_id` en NULL — sin CHECK que lo impida, sería un producto
    // sin grupo que ni saldría en los filtros de Inventario. Mejor un mensaje
    // que diga cuál, que dejarlo pasar en silencio.
    throw new Error(
      `El producto ${p.id} usa la categoría "${p.categoryId}", que no está en CATEGORIES.`,
    );
  }
  lines.push(
    // `grupo_admin` (sin `_id`) lleva un valor fijo, no el real: es la columna
    // vieja, `NOT NULL` sin DEFAULT, que la migración 0025 dejó sin usar
    // porque quitarla exigía recrear `products`. Ver esa migración.
    `INSERT INTO products (id, slug, nombre, tagline, categoria_id, grupo_admin, grupo_admin_id, precio, precio_costo, precio_anterior, unidad, origen, rating, review_count, badge, stock_actual, stock_seguridad, imagen, imagen_hover, imagen_alt, vendido_por_peso) VALUES (` +
      [
        q(p.id),
        q(p.slug),
        q(p.name),
        q(p.tagline),
        q(p.categoryId),
        q('agroindustriales'),
        q(grupo),
        p.price,
        p.costPrice,
        p.compareAtPrice ?? 'NULL',
        q(p.unit),
        q(p.origin),
        p.rating,
        p.reviewCount,
        p.badge ? q(p.badge) : 'NULL',
        p.stock,
        p.safetyStock,
        q(p.image),
        p.imageHover ? q(p.imageHover) : 'NULL',
        q(p.imageAlt),
        VENDIDOS_POR_PESO.has(p.id) ? 1 : 0,
      ].join(', ') +
      ');',
  );
}

lines.push('', '-- ─────────────────────────── Contactos ───────────────────────────');

// La agenda: proveedores y clientes en una sola tabla (migración 0022).
//
// Es el equivalente para una base nueva de lo que la 0022 hace sobre una
// existente. Sin esto, tras un `db:reset` la agenda queda vacía aunque haya 25
// productos y 6 pedidos, y el selector de proveedores del formulario de
// compras no ofrece nada — que es justo lo que pasó la primera vez.
//
// Los ids son fijos (`prov-1`, `cli-1`) y no aleatorios: así el seed es
// reproducible y dos ejecuciones dan exactamente el mismo fichero, que es lo
// que permite ver en un diff si algo cambió de verdad.

/** Un proveedor por cada `origen` distinto del catálogo. */
const ORIGENES = [...new Set(PRODUCTS.map((p) => p.origin).filter(Boolean))].sort((a, b) =>
  a.localeCompare(b, 'es'),
);

// ── Consumidor final ──
//
// La venta anónima del mostrador necesita una ficha real a la que apuntar:
// `contacts.documento` es NOT NULL UNIQUE, así que "sin identificar" no puede
// ser un hueco. 222222222222 es el documento genérico que la DIAN reserva
// justo para esto, así que el día que haya factura electrónica el dato ya
// está donde tiene que estar.
//
// Id fijo y no generado: el Worker lo busca por documento, pero tenerlo
// estable hace que se pueda reconocer de un vistazo al leer la tabla.
lines.push(
  `INSERT INTO contacts (id, nombre, es_cliente, documento, notas) VALUES (` +
    [
      q('consumidor-final'),
      q('Consumidor final'),
      1,
      q('222222222222'),
      q('Ficha para la venta de mostrador sin identificar. No la borres: la caja apunta aquí.'),
    ].join(', ') +
    ');',
);

const contactIdByOrigen = new Map();
ORIGENES.forEach((origen, i) => {
  const id = `prov-${i + 1}`;
  contactIdByOrigen.set(origen, id);
  lines.push(
    `INSERT INTO contacts (id, nombre, es_proveedor, documento, notas) VALUES (` +
      [
        q(id),
        q(origen),
        1,
        // El documento es NOT NULL UNIQUE: cada finca necesita el suyo. En una
        // base de demo no hay NIT reales, así que se deriva del id — es único
        // por construcción y se distingue a simple vista de uno de verdad.
        q(`NIT-${String(i + 1).padStart(4, '0')}`),
        q('Creado desde el origen del catálogo. Completa teléfono y cuenta.'),
      ].join(', ') +
      ');',
  );
});

/**
 * Un cliente por cada teléfono distinto de los pedidos de demo.
 *
 * El teléfono es la llave —el checkout de invitado no pide cuenta— así que dos
 * pedidos con el mismo número son la misma persona. Se queda con los datos del
 * último pedido de ese número, igual que hace la migración.
 */
const contactIdByPhone = new Map();
const clientePorTelefono = new Map();
for (const order of ORDERS) {
  clientePorTelefono.set(order.customerPhone, order);
}

[...clientePorTelefono.entries()].forEach(([telefono, order], i) => {
  const id = `cli-${i + 1}`;
  contactIdByPhone.set(telefono, id);
  lines.push(
    `INSERT INTO contacts (id, nombre, telefono, direccion, es_cliente, documento) VALUES (` +
      [
        q(id),
        q(order.customerName),
        q(telefono),
        q(order.customerAddress),
        1,
        // Cédula de demo derivada del teléfono: única, estable entre corridas
        // del generador, y reconocible como inventada.
        q(`10${telefono.replace(/[^0-9]/g, '').slice(-8)}`),
      ].join(', ') +
      ');',
  );
});

lines.push('', '-- ─────────────────────────── Pedidos ───────────────────────────');

// Mapea "Diana Cardona" -> 'u-02': los pedidos de demo aprobados registran
// quién los aprobó por nombre; la tabla real referencia el id del usuario.
const userIdByName = new Map(USERS.map((u) => [u.nombre, u.id]));

// El consecutivo de facturación va en el orden en que se siembran los pedidos.
// Es un contador y no `COUNT(*)`: los números de factura no se reutilizan.
let consecutivoFactura = 0;

for (const order of ORDERS) {
  const subtotal = order.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const aprobadoPor = order.approvedBy ? (userIdByName.get(order.approvedBy) ?? 'NULL') : 'NULL';

  lines.push(
    `INSERT INTO orders (id, referencia, contact_id, cliente_nombre, cliente_cedula, cliente_telefono, cliente_direccion, estado, stock_reservado, subtotal, envio, total, aprobado_por, aprobado_en, creado_en) VALUES (` +
      [
        q(order.id),
        q(order.reference),
        // La ficha en la agenda. Las tres columnas siguientes NO son
        // redundantes: son la copia de lo que el cliente escribió ese día.
        q(contactIdByPhone.get(order.customerPhone)),
        q(order.customerName),
        // La cédula con la que se vendió, congelada igual que el nombre.
        q(`10${order.customerPhone.replace(/[^0-9]/g, '').slice(-8)}`),
        q(order.customerPhone),
        q(order.customerAddress),
        q(order.status),
        0,
        subtotal,
        0,
        subtotal,
        aprobadoPor === 'NULL' ? 'NULL' : q(aprobadoPor),
        order.approvedAt ? q(order.approvedAt) : 'NULL',
        q(order.placedAt),
      ].join(', ') +
      ');',
  );

  for (const line of order.lines) {
    lines.push(
      `INSERT INTO order_items (order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad) VALUES (` +
        [
          q(order.id),
          q(line.productId),
          q(line.productName),
          line.unitPrice,
          line.unitCost,
          line.quantity,
        ].join(', ') +
        ');',
    );
  }

  // Factura del pedido (migración 0027).
  //
  // Se emite aquí y no se deja para después porque en el sistema real la
  // factura nace DENTRO del batch que aprueba el pedido: un pedido aprobado
  // sin factura no es un estado que pueda existir. Sembrar sin ella dejaría la
  // base de pruebas en una situación imposible, y la cartera arrancaría
  // mintiendo en cada `db:reset`.
  //
  // Solo los aprobados: lo que sigue pendiente todavía no facturó nada.
  if (order.approvedAt) {
    const consecutivo = ++consecutivoFactura;
    const cobrado = order.status === 'pago' || order.status === 'cancelado';

    lines.push(
      `INSERT INTO invoices (id, consecutivo, numero, order_id, contact_id, cliente_nombre, cliente_telefono, cliente_cedula, subtotal, envio, total, saldo, estado, emitida_en) VALUES (` +
        [
          q(`inv-${order.id}`),
          consecutivo,
          q(`FAC-${String(consecutivo).padStart(6, '0')}`),
          q(order.id),
          q(contactIdByPhone.get(order.customerPhone)),
          q(order.customerName),
          q(order.customerPhone),
          // La misma cedula congelada que lleva el pedido: la factura es lo que se
          // reporta, y tiene que decir a nombre de quien se emitio.
          q(`10${order.customerPhone.replace(/[^0-9]/g, '').slice(-8)}`),
          subtotal,
          0,
          subtotal,
          cobrado ? 0 : subtotal,
          q(
            order.status === 'pago'
              ? 'pagada'
              : order.status === 'cancelado'
                ? 'anulada'
                : 'emitida',
          ),
          q(order.approvedAt),
        ].join(', ') +
        ');',
    );

    // Las líneas de la factura, congeladas igual que las del pedido.
    for (const line of order.lines) {
      lines.push(
        `INSERT INTO invoice_items (invoice_id, product_id, descripcion, cantidad, precio_unitario, importe) VALUES (` +
          [
            q(`inv-${order.id}`),
            q(line.productId),
            q(line.productName),
            line.quantity,
            line.unitPrice,
            line.unitPrice * line.quantity,
          ].join(', ') +
          ');',
      );
    }
  }
}

lines.push('');

const out = join(root, 'worker', 'seed.sql');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(
  `seed.sql generado con ${USERS.length} usuarios, ${PRODUCTS.length} productos y ${ORDERS.length} pedidos`,
);
