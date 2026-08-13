/**
 * Recuperación de contraseña por correo.
 *
 *   npm run worker:dev > worker.log      # en otra terminal
 *   node worker/tests/qa-recuperacion.mjs http://localhost:8788 worker.log
 *
 * ── Por qué hace falta el fichero de log ──
 *
 * El token real solo existe en el correo, y su huella es lo único que queda en
 * la base — no se puede deshacer. Mientras no haya proveedor de correo
 * configurado, el Worker escribe el enlace en sus logs, así que leerlos es la
 * única forma de probar el flujo con un token de verdad en vez de uno
 * inventado. Sin el fichero, la prueba corre igual y salta esas secciones.
 *
 * ── Por qué no se escribe en la base desde aquí ──
 *
 * `wrangler d1 execute --local` escribiendo mientras `wrangler dev` tiene la
 * misma base abierta tira al servidor: se comprobó, la siguiente petición
 * moría con ECONNRESET. Las lecturas conviven bien; las escrituras no. Por eso
 * cada ejecución usa IPs nuevas en vez de limpiar contadores.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:8788';
const LOG = process.argv[3] ?? null;

let fallos = 0;
let omitidas = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const omitir = (msg) => {
  console.log(`  ~ ${msg} (sin fichero de log)`);
  omitidas++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);

/** IP distinta en cada ejecución: así los contadores de una no bloquean la siguiente. */
const sufijo = Math.floor(Math.random() * 250) + 1;
const IP = `203.0.113.${sufijo}`;
const IP_OTRA = `198.51.100.${sufijo}`;

const post = async (ruta, cuerpo, ip = IP) => {
  const res = await fetch(`${BASE}${ruta}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(cuerpo),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const login = (email, password) => post('/api/auth/login', { email, password }, IP_OTRA);

/** Solo lecturas. Ver la nota de arriba sobre por qué no se escribe. */
const sql = (consulta) => {
  const salida = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1', 'execute', 'DB', '--local', '--command', consulta, '--json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(salida.slice(salida.indexOf('[')))[0]?.results ?? [];
};

/** Todos los enlaces que el Worker ha escrito en sus logs para esa dirección. */
const enlacesDelLog = (email) => {
  if (!LOG) return [];
  try {
    // Se quitan los códigos de color antes de buscar. Wrangler colorea su
    // salida, así que la línea termina en un `\x1b[0m` que `\S+` se tragaba
    // como parte del token: la huella no cuadraba nunca y el servidor
    // respondía "enlace inválido" con un enlace que era correcto.
    const texto = readFileSync(LOG, 'utf8').replace(/\[[0-9;]*m/g, '');
    return [...texto.matchAll(/Enlace para ([^\s:]+): (\S+)/g)]
      .filter((m) => m[1] === email)
      .map((m) => m[2]);
  } catch {
    return [];
  }
};

/**
 * Espera a que aparezca un enlace que no estuviera antes.
 *
 * Leer "el último del fichero" sin más devolvía el de la ejecución anterior:
 * la salida del Worker se vuelca con retraso, y para cuando la prueba miraba,
 * la línea nueva todavía no estaba escrita. Como pedir un enlace invalida el
 * anterior, ese token viejo ya no servía y el fallo parecía del servidor.
 */
const esperarEnlaceNuevo = async (email, conocidos) => {
  if (!LOG) return null;
  for (let intento = 0; intento < 25; intento++) {
    const nuevo = enlacesDelLog(email).find((e) => !conocidos.includes(e));
    if (nuevo) return nuevo;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

console.log(`== Recuperación de contraseña · ${BASE} ==`);
console.log(`   IP simulada: ${IP}${LOG ? ` · log: ${LOG}` : ' · sin log'}`);

const CUENTA = 'pedidos@agricultores.co';
const CLAVE_ORIGINAL = 'demo1234';

// ───────────────────── No delata qué cuentas existen ─────────────────────

seccion('1. La misma respuesta exista o no la cuenta');

const enlacesPrevios = enlacesDelLog(CUENTA);
const existente = await post('/api/auth/recuperar', { email: CUENTA });
const inventada = await post('/api/auth/recuperar', { email: 'nadie-de-nadie@ejemplo.com' });

t(existente.status === 200, `Correo registrado → ${existente.status}`);
t(inventada.status === 200, `Correo inexistente → ${inventada.status}`);
t(
  JSON.stringify(existente.body) === JSON.stringify(inventada.body),
  `Cuerpo idéntico en ambos casos: ${JSON.stringify(existente.body)}`,
);

// ─────────────────────── Lo que se guarda en la base ───────────────────────

seccion('2. En la base no queda una llave utilizable');

const filas = sql(
  `SELECT r.token_hash, r.usado_en FROM password_resets r
     JOIN users u ON u.id = r.user_id WHERE u.email = '${CUENTA}'`,
);
t(filas.length >= 1, `Se guardó el enlace (${filas.length})`);
t(
  filas.every((f) => /^[0-9a-f]{64}$/.test(f.token_hash)),
  'Lo guardado es un SHA-256, no el token',
);
t(filas.every((f) => f.usado_en === null), 'Todavía sin usar');

const token = (await esperarEnlaceNuevo(CUENTA, enlacesPrevios))?.split('token=')[1] ?? null;
if (token) {
  t(
    !filas.some((f) => f.token_hash === token),
    'El token del correo no aparece tal cual en la base',
  );
}

// ─────────────────────────── Tokens que no valen ───────────────────────────

seccion('3. Enlaces que no deben funcionar');

const inexistente = await post('/api/auth/restablecer', {
  token: 'esto-no-existe-de-ninguna-manera',
  nueva: 'claveNueva123',
});
t(inexistente.status === 400, `Token inventado → ${inexistente.status}`);
t(
  inexistente.body?.error?.code === 'enlace-invalido',
  `Con código genérico: ${inexistente.body?.error?.code}`,
);

if (token) {
  const corta = await post('/api/auth/restablecer', { token, nueva: 'corta' });
  t(corta.status === 400, `Contraseña de 5 caracteres → ${corta.status}`);
  t(
    corta.body?.error?.code === 'password-corta',
    `Y dice por qué: ${corta.body?.error?.code}`,
  );
} else {
  omitir('Contraseña demasiado corta');
}

// ─────────────────────────── El camino que sí vale ───────────────────────────

seccion('4. Restablecer de verdad');

if (token) {
  const CLAVE_NUEVA = 'claveRecuperada456';
  const ok = await post('/api/auth/restablecer', { token, nueva: CLAVE_NUEVA });
  t(ok.status === 200, `Con el token del correo → ${ok.status}`);

  t((await login(CUENTA, CLAVE_NUEVA)).status === 200, 'Entra con la contraseña nueva');
  t((await login(CUENTA, CLAVE_ORIGINAL)).status === 401, 'La vieja deja de servir');

  seccion('5. El enlace es de un solo uso');

  const reutilizado = await post('/api/auth/restablecer', {
    token,
    nueva: 'otraMasTodavia789',
  });
  t(reutilizado.status === 400, `Reutilizarlo → ${reutilizado.status}`);
  t(
    (await login(CUENTA, CLAVE_NUEVA)).status === 200,
    'Y la contraseña sigue siendo la que se puso',
  );

  const usado = sql(
    `SELECT usado_en FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE u.email = '${CUENTA}' AND r.usado_en IS NOT NULL`,
  );
  t(usado.length === 1, 'Queda marcado como usado en la base');

  // Se devuelve la contraseña original para no dejar la cuenta de prueba
  // cambiada; hace falta un enlace nuevo, que es el flujo normal.
  const antesDeVolver = enlacesDelLog(CUENTA);
  await post('/api/auth/recuperar', { email: CUENTA }, IP_OTRA);
  const tokenVuelta = (await esperarEnlaceNuevo(CUENTA, antesDeVolver))?.split('token=')[1];
  if (tokenVuelta && tokenVuelta !== token) {
    await post('/api/auth/restablecer', { token: tokenVuelta, nueva: CLAVE_ORIGINAL });
    t(
      (await login(CUENTA, CLAVE_ORIGINAL)).status === 200,
      'Se restaura la contraseña original de la cuenta de prueba',
    );
  }
} else {
  omitir('Restablecer con un token real');
  omitir('Un solo uso');
}

// ───────────────────────── Tope de peticiones ─────────────────────────

seccion('6. No se puede llenar de correos una bandeja');

const IP_ABUSO = `203.0.113.${((sufijo + 77) % 250) + 1}`;
let primer429 = null;
for (let i = 1; i <= 8; i++) {
  const r = await post('/api/auth/recuperar', { email: CUENTA }, IP_ABUSO);
  if (r.status === 429 && primer429 === null) primer429 = i;
}
t(primer429 !== null, `Bloquea tras varias peticiones (la ${primer429 ?? '—'})`);

const otraIp = await post('/api/auth/recuperar', { email: CUENTA }, `198.51.100.${((sufijo + 13) % 250) + 1}`);
t(otraIp.status === 200, `Y no bloquea a quien pide desde otra IP → ${otraIp.status}`);

console.log(
  fallos === 0
    ? `\n✔ Todo en orden.${omitidas > 0 ? ` (${omitidas} omitidas por falta del log)` : ''}`
    : `\n✘ ${fallos} comprobación(es) sin pasar.`,
);
if (fallos > 0) process.exitCode = 1;
