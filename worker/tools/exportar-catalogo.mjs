/**
 * Exporta el catálogo de la base LOCAL a un .sql listo para cargar en remoto.
 *
 * Es el puente del flujo "ajusto los productos en local y los subo": lee lo
 * que hay ahora mismo en la base local y escribe los INSERT equivalentes.
 *
 * Solo saca CATÁLOGO y CONFIGURACIÓN — nunca pedidos, facturas, cobros ni
 * usuarios. Un catálogo se puede volver a publicar tantas veces como haga
 * falta; el historial de plata no, y las contraseñas viajan por su propio
 * camino (crear-superusuario.mjs).
 *
 * Cada tabla se borra antes de reinsertarse, así que el archivo es
 * idempotente: cargarlo dos veces deja el mismo resultado que cargarlo una.
 *
 * Uso:
 *   node worker/tools/exportar-catalogo.mjs
 *   npx wrangler d1 execute DB --remote --file=worker/tools/catalogo.sql
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// El orden importa: las hijas van después de sus padres al insertar, y al
// revés al borrar. product_components apunta a products dos veces.
const TABLAS = [
  'admin_groups',
  'categories',
  'products',
  'product_components',
  'product_wholesale_discounts',
  'treasury_accounts',
  'app_settings',
];

// Los contactos se filtran: solo las fincas proveedoras y la ficha que usa la
// caja. Los clientes son datos de la operación, no del catálogo.
const CONTACTOS_WHERE = "id = 'consumidor-final' OR es_proveedor = 1";

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const consulta = join(tmpdir(), 'ao-exportar-consulta.sql');

/**
 * La consulta viaja por un archivo temporal, no por --command. En Windows,
 * pasar SQL con comillas simples por la línea de comandos lo destroza el shell
 * antes de que wrangler lo vea; --file no pasa por ahí.
 */
const leer = (sql) => {
  writeFileSync(consulta, sql, 'utf8');
  const salida = execSync(
    `npx wrangler d1 execute DB --local --json --file="${consulta}"`,
    { cwd: raiz, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  // wrangler antepone su banner antes del JSON.
  const parsed = JSON.parse(salida.slice(salida.indexOf('[')));
  return parsed[0]?.results ?? [];
};

/** Un valor de SQLite a literal SQL. */
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
};

const bloque = (tabla, filas, where = null) => {
  const lineas = [
    `-- ─────────────── ${tabla} (${filas.length} filas) ───────────────`,
    where ? `DELETE FROM ${tabla} WHERE ${where};` : `DELETE FROM ${tabla};`,
  ];
  for (const fila of filas) {
    const cols = Object.keys(fila);
    lineas.push(
      `INSERT INTO ${tabla} (${cols.join(', ')}) VALUES (${cols.map((c) => lit(fila[c])).join(', ')});`,
    );
  }
  lineas.push('');
  return lineas.join('\n');
};

const partes = [
  '-- ============================================================',
  '--  CATÁLOGO exportado desde la base local',
  `--  ${new Date().toISOString()}`,
  '--',
  '--  Generado por worker/tools/exportar-catalogo.mjs — no editar a mano.',
  '--  Contiene SOLO catálogo y configuración: ni pedidos, ni facturas,',
  '--  ni cobros, ni usuarios, ni clientes.',
  '--',
  '--  Es idempotente: cada tabla se vacía antes de reinsertarse.',
  '--  Cargar con:',
  '--    npx wrangler d1 execute DB --remote --file=worker/tools/catalogo.sql',
  '-- ============================================================',
  '',
];

// Los contactos van primero: products.origen es texto libre, pero las fincas
// deben existir antes de que alguien registre una compra contra ellas.
const contactos = leer(`SELECT * FROM contacts WHERE ${CONTACTOS_WHERE} ORDER BY id`);
partes.push(bloque('contacts', contactos, CONTACTOS_WHERE));
console.log(`  contacts (fincas + consumidor final) : ${contactos.length}`);

for (const tabla of TABLAS) {
  const filas = leer(`SELECT * FROM ${tabla} ORDER BY rowid`);
  partes.push(bloque(tabla, filas));
  console.log(`  ${tabla.padEnd(36)} : ${filas.length}`);
}

const destino = join(dirname(fileURLToPath(import.meta.url)), 'catalogo.sql');
writeFileSync(destino, partes.join('\n'), 'utf8');
console.log(`\nEscrito worker/tools/catalogo.sql`);
console.log(`Cárgalo con:\n  npx wrangler d1 execute DB --remote --file=worker/tools/catalogo.sql`);
