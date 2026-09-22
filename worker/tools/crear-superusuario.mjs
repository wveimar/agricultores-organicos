/**
 * Genera el SQL que crea (o reemplaza) un usuario SUPER_ADMIN.
 *
 * La contraseña no se puede sembrar desde un .sql a mano: hay que derivarla
 * con PBKDF2-SHA256, 100.000 iteraciones, exactamente como lo hace
 * `hashPassword()` en worker/src/auth/crypto.ts. Si el número de iteraciones
 * no coincide con el que espera el runtime de Cloudflare, el login funciona
 * en local y falla en el edge — ya pasó una vez.
 *
 * El archivo que produce lleva el HASH, nunca la contraseña, pero aun así
 * está en .gitignore: es una credencial de una instalación concreta.
 *
 * Uso:
 *   node worker/tools/crear-superusuario.mjs <correo> <clave> "<nombre>"
 *
 * Después:
 *   npx wrangler d1 execute DB --local  --file=worker/tools/.superusuario.sql
 *   npx wrangler d1 execute DB --remote --file=worker/tools/.superusuario.sql
 */
import { writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [email, password, nombre = 'Administrador'] = process.argv.slice(2);

if (!email || !password) {
  console.error('Uso: node worker/tools/crear-superusuario.mjs <correo> <clave> "<nombre>"');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`No parece un correo válido: ${email}`);
  process.exit(1);
}
if (password.length < 8) {
  console.error('La clave debe tener al menos 8 caracteres.');
  process.exit(1);
}

// Mismo tope que impone workerd. Ver el comentario largo en auth/crypto.ts.
const PBKDF2_ITERATIONS = 100_000;

const toBase64Url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
const hash = `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;

// Id estable derivado del correo: volver a correr esto con el mismo correo
// reemplaza la cuenta en vez de crear una segunda que choque con el UNIQUE.
const id = `u-${toBase64Url(
  new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(email))),
).slice(0, 12)}`;

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

const sql = `-- ============================================================
--  GENERADO por worker/tools/crear-superusuario.mjs
--  Cuenta: ${email}   ·   ${new Date().toISOString()}
--
--  La contraseña NO está aquí — solo su hash PBKDF2. No se puede
--  recuperar a partir de este archivo; si se olvida, se vuelve a
--  generar este SQL con una clave nueva.
-- ============================================================

DELETE FROM users WHERE email = ${q(email)};

INSERT INTO users (id, email, nombre, password_hash, activo)
VALUES (${q(id)}, ${q(email)}, ${q(nombre)}, ${q(hash)}, 1);

INSERT INTO user_roles (user_id, role) VALUES (${q(id)}, 'SUPER_ADMIN');
`;

const destino = join(dirname(fileURLToPath(import.meta.url)), '.superusuario.sql');
writeFileSync(destino, sql, 'utf8');

console.log(`Listo. SQL escrito en worker/tools/.superusuario.sql`);
console.log(`  correo : ${email}`);
console.log(`  nombre : ${nombre}`);
console.log(`  id     : ${id}`);
console.log(`  rol    : SUPER_ADMIN`);
console.log(`\nAplícalo con:`);
console.log(`  npx wrangler d1 execute DB --local  --file=worker/tools/.superusuario.sql`);
console.log(`  npx wrangler d1 execute DB --remote --file=worker/tools/.superusuario.sql`);
