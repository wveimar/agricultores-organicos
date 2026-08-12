/**
 * Límite de intentos en el login y verificación anti-bots.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-fuerza-bruta.mjs [http://localhost:8788]
 *
 * Ojo: deja el correo de prueba bloqueado 15 minutos en la base local. Usa uno
 * inexistente a propósito para no dejar fuera a una cuenta real.
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};

/**
 * `ip` simula desde dónde llega la petición.
 *
 * En producción Cloudflare pone `CF-Connecting-IP` en el borde y el cliente no
 * puede falsearla; en local no existe, así que sin este parámetro todas las
 * peticiones compartirían la misma clave y las pruebas no distinguirían a un
 * atacante del administrador legítimo.
 */
const intentar = async (email, password, { ip = '203.0.113.10', ...extra } = {}) => {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password, ...extra }),
  });
  return {
    status: res.status,
    ms: Math.round(performance.now() - t0),
    body: await res.json().catch(() => null),
  };
};

console.log(`== Fuerza bruta y anti-bots · ${BASE} ==`);

// ─────────────────────────── Configuración pública ───────────────────────────

console.log('\n1. Configuración del cliente');

const config = await (await fetch(`${BASE}/api/config`)).json();
t('turnstileSiteKey' in config, 'GET /api/config expone la sitekey');
t(
  !JSON.stringify(config).toLowerCase().includes('secret'),
  'No filtra ninguna clave secreta',
);
if (!config.turnstileSiteKey) {
  console.log('     (vacía: Turnstile aún no está configurado, el login no lo exige)');
}

// ──────────────────────────── Límite de intentos ────────────────────────────

console.log('\n2. Intentos fallidos consecutivos');

const VICTIMA = `bruta-${Date.now()}@agricultores.co`;
const latencias = [];
let primer429 = null;

for (let i = 1; i <= 11; i++) {
  const r = await intentar(VICTIMA, `clave-mala-${i}`);
  latencias.push(r.ms);
  if (r.status === 429 && primer429 === null) {
    primer429 = i;
  }
  if (i <= 3 || r.status === 429) {
    console.log(`     intento ${String(i).padStart(2)} → ${r.status}  ${r.ms}ms`);
  }
}

t(primer429 !== null, `Llega a bloquear (primer 429 en el intento ${primer429 ?? '—'})`);
t(primer429 !== null && primer429 <= 10, 'Bloquea antes del intento 10');

const bloqueado = await intentar(VICTIMA, 'otra-mas');
t(bloqueado.status === 429, `Sigue bloqueado después → ${bloqueado.status}`);
t(
  bloqueado.body?.error?.code === 'demasiados-intentos',
  `Con un código propio: ${bloqueado.body?.error?.code ?? '—'}`,
);

/**
 * Lo importante no es solo que corte, sino que corte **barato**: si el bloqueo
 * ocurriera después del PBKDF2, el atacante seguiría gastando la CPU del
 * Worker en cada intento.
 */
const antesDelBloqueo = latencias.slice(0, Math.max(1, (primer429 ?? 9) - 1));
const medianaNormal = antesDelBloqueo.sort((a, b) => a - b)[Math.floor(antesDelBloqueo.length / 2)];
t(
  bloqueado.ms < medianaNormal / 2,
  `El intento bloqueado cuesta ${bloqueado.ms}ms frente a ${medianaNormal}ms: se corta antes del PBKDF2`,
);

// ──────────────────── Una cuenta buena no queda atrapada ────────────────────

console.log('\n3. El administrador legítimo no queda atrapado');

// Misma cuenta que estaba siendo atacada, pero desde otra IP.
const desdeCasa = await intentar('admin@agricultores.co', 'demo1234', { ip: '198.51.100.7' });
t(
  desdeCasa.status === 200,
  `Entra desde otra IP mientras atacan la suya → ${desdeCasa.status}`,
);

// Y el ataque contra un correo conocido no bloquea ese correo en el mundo.
const OBJETIVO = 'admin@agricultores.co';
for (let i = 0; i < 10; i++) {
  await intentar(OBJETIVO, `intento-${i}`, { ip: '203.0.113.99' });
}
const noSecuestrable = await intentar(OBJETIVO, 'demo1234', { ip: '198.51.100.8' });
t(
  noSecuestrable.status === 200,
  `10 fallos contra su correo desde fuera no lo dejan fuera → ${noSecuestrable.status}`,
);

const atacante = await intentar(OBJETIVO, 'otra-mas', { ip: '203.0.113.99' });
t(atacante.status === 429, `Quien ataca sí queda bloqueado → ${atacante.status}`);

// ─────────────────── El contador se limpia al acertar ───────────────────

console.log('\n4. El contador se reinicia al entrar bien');

const CUENTA = 'pedidos@agricultores.co';
const MI_IP = '198.51.100.20';

for (let i = 0; i < 3; i++) {
  await intentar(CUENTA, 'no-es-esta', { ip: MI_IP });
}
const acierta = await intentar(CUENTA, 'demo1234', { ip: MI_IP });
t(acierta.status === 200, `Tras 3 fallos, la correcta entra → ${acierta.status}`);

for (let i = 0; i < 6; i++) {
  await intentar(CUENTA, 'no-es-esta', { ip: MI_IP });
}
const sexto = await intentar(CUENTA, 'demo1234', { ip: MI_IP });
t(
  sexto.status === 200,
  `Y 6 fallos más siguen sin bloquear, porque el acierto limpió → ${sexto.status}`,
);

console.log(
  fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`,
);
if (fallos > 0) process.exitCode = 1;
