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
const { ADMIN_GROUP_OF } = await load('src/app/core/models/product.model.ts');
const { ORDERS } = await load('src/app/core/data/mock-orders.ts');

// ─────────────────── PBKDF2, idéntico al del Worker ───────────────────
const PBKDF2_ITERATIONS = 210_000;

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
  'DELETE FROM order_items;',
  'DELETE FROM orders;',
  'DELETE FROM cash_closings;',
  'DELETE FROM user_roles;',
  'DELETE FROM users;',
  'DELETE FROM products;',
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

lines.push('', '-- ─────────────────────────── Productos ───────────────────────────');

for (const p of PRODUCTS) {
  const grupo = ADMIN_GROUP_OF[p.categoryId];
  lines.push(
    `INSERT INTO products (id, slug, nombre, tagline, categoria_id, grupo_admin, precio, precio_costo, precio_anterior, unidad, origen, rating, review_count, badge, stock_actual, stock_seguridad, imagen, imagen_hover, imagen_alt) VALUES (` +
      [
        q(p.id),
        q(p.slug),
        q(p.name),
        q(p.tagline),
        q(p.categoryId),
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
      ].join(', ') +
      ');',
  );
}

lines.push('', '-- ─────────────────────────── Pedidos ───────────────────────────');

// Mapea "Diana Cardona" -> 'u-02': los pedidos de demo aprobados registran
// quién los aprobó por nombre; la tabla real referencia el id del usuario.
const userIdByName = new Map(USERS.map((u) => [u.nombre, u.id]));

for (const order of ORDERS) {
  const subtotal = order.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const aprobadoPor = order.approvedBy ? (userIdByName.get(order.approvedBy) ?? 'NULL') : 'NULL';

  lines.push(
    `INSERT INTO orders (id, referencia, cliente_nombre, cliente_telefono, cliente_direccion, estado, stock_reservado, subtotal, envio, total, aprobado_por, aprobado_en, creado_en) VALUES (` +
      [
        q(order.id),
        q(order.reference),
        q(order.customerName),
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
}

lines.push('');

const out = join(root, 'worker', 'seed.sql');
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(
  `seed.sql generado con ${USERS.length} usuarios, ${PRODUCTS.length} productos y ${ORDERS.length} pedidos`,
);
