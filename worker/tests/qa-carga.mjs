/**
 * Prueba de carga de los dos endpoints críticos, sin dependencias.
 *
 *   node worker/tests/qa-carga.mjs [base] [concurrencia] [segundos]
 *   node worker/tests/qa-carga.mjs http://localhost:8788 10 20
 *
 * No pretende sustituir a k6: pretende contestar las dos preguntas que de
 * verdad importan a esta escala —¿aguanta el login la concurrencia de una
 * mañana de viernes? ¿se degrada el catálogo?— con algo que se pueda ejecutar
 * ahora mismo y sin instalar nada.
 *
 * ⚠ Contra producción, ten en cuenta que el login gasta PBKDF2 de 100.000
 *   iteraciones por intento. Es CPU real del Worker, no una petición barata.
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';
const CONCURRENCIA = Number(process.argv[3] ?? 10);
const SEGUNDOS = Number(process.argv[4] ?? 15);

const percentil = (valores, p) => {
  if (valores.length === 0) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  return Math.round(orden[Math.min(orden.length - 1, Math.floor((p / 100) * orden.length))]);
};

/**
 * `esperado` es el estado que cuenta como éxito. Para el login con
 * credenciales malas ese estado es 401: contarlo como fallo daría un 0 % de
 * aciertos en una prueba que en realidad está pasando.
 */
async function medir(nombre, hacerPeticion, esperado = 200) {
  const latencias = [];
  const errores = new Map();
  let ok = 0;
  const fin = Date.now() + SEGUNDOS * 1000;

  const trabajador = async () => {
    while (Date.now() < fin) {
      const t0 = performance.now();
      try {
        const res = await hacerPeticion();
        const ms = performance.now() - t0;
        latencias.push(ms);
        if (res.status === esperado) {
          ok++;
        } else {
          errores.set(res.status, (errores.get(res.status) ?? 0) + 1);
        }
      } catch (e) {
        errores.set(e.name ?? 'red', (errores.get(e.name ?? 'red') ?? 0) + 1);
      }
    }
  };

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
  const duracion = (Date.now() - t0) / 1000;
  const total = latencias.length + [...errores.values()].reduce((a, b) => a + b, 0);

  console.log(`\n${nombre}`);
  console.log(`  peticiones   ${total}  ·  ${(total / duracion).toFixed(1)}/s`);
  console.log(`  correctas    ${ok}  (${((ok / total) * 100).toFixed(1)} %)`);
  console.log(
    `  latencia     p50 ${percentil(latencias, 50)}ms · p90 ${percentil(latencias, 90)}ms · p99 ${percentil(latencias, 99)}ms`,
  );
  if (errores.size > 0) {
    console.log(`  errores      ${[...errores].map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }
  return { ok, total, p90: percentil(latencias, 90), errores };
}

console.log(`== Carga · ${BASE} ==`);
console.log(`   ${CONCURRENCIA} en paralelo durante ${SEGUNDOS}s por endpoint`);

// 1. Catálogo: la petición que hace todo el mundo al entrar.
const catalogo = await medir('GET /api/products  (lectura de D1)', () =>
  fetch(`${BASE}/api/products`),
);

// 2. Login con credenciales correctas: PBKDF2 completo, el peor caso de CPU.
const login = await medir('POST /api/auth/login  (PBKDF2 100k)', () =>
  fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@agricultores.co', password: 'demo1234' }),
  }),
);

// 3. Login fallido: mismo coste de CPU a propósito (el hash señuelo), y es el
//    que usaría quien intente fuerza bruta.
const fallido = await medir(
  'POST /api/auth/login  (credenciales malas · se espera 401)',
  () =>
    fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nadie@agricultores.co', password: 'loQueSea' }),
    }),
  401,
);

console.log('\n── Lectura ──');
const problemas = [];
if (catalogo.ok / catalogo.total < 0.99) problemas.push('el catálogo falla más del 1 %');
if (login.ok / login.total < 0.99) problemas.push('el login falla más del 1 %');
if (login.p90 > 2000) problemas.push(`el login se va a ${login.p90}ms en p90`);
if ([...login.errores.keys()].includes(429)) problemas.push('aparece 429: hay limitación activa');

console.log(
  problemas.length === 0
    ? '  Sin degradación a esta concurrencia.'
    : '  ⚠ ' + problemas.join('\n  ⚠ '),
);
console.log(
  `\n  Coste del login frente al catálogo: ×${(login.p90 / Math.max(1, catalogo.p90)).toFixed(1)} en p90.`,
);
console.log('  Un login sin éxito cuesta lo mismo que uno con éxito: es a propósito,');
console.log('  y es justo lo que hace que la fuerza bruta salga cara sin rate limiting.');
