/**
 * QA de módulos activables (POS / E-commerce / Entregas / Tesorería).
 *
 * A diferencia del resto de las suites, esta MUTA un estado global de la
 * instalación (`app_settings`), no filas propias con prefijo QA-. Por eso
 * todo el cuerpo de pruebas va en un `try/finally`: pase lo que pase, los
 * cuatro interruptores quedan en `'1'` al salir — la próxima suite que corra
 * (o la persona que abra el panel después) tiene que encontrar el sistema
 * exactamente como lo tenía todo el mundo antes de esta corrida.
 *
 * Lo que se comprueba:
 *   1. `/api/config` expone los cuatro módulos, todos encendidos por defecto.
 *   2. Apagar POS rechaza una venta de mostrador con 403; los demás módulos
 *      siguen funcionando sin tocarlos.
 *   3. Apagar E-commerce rechaza un pedido web con 403.
 *   4. Apagar Entregas: un pedido web nuevo nace SIN exigir dirección ni
 *      teléfono, con envío en 0, y sin `'contraentrega'` como método válido.
 *   5. Apagar Tesorería no rompe una venta en POS — se sigue cobrando igual.
 *   6. No se puede apagar POS y E-commerce a la vez (409).
 *
 *   node worker/tests/qa-modulos.mjs [base] [email] [password]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';
const EMAIL = process.argv[3] ?? 'admin@agricultores.co';
const PASSWORD = process.argv[4] ?? 'demo1234';

let fallos = 0;
const ok = (condicion, titulo, detalle = '') => {
  if (condicion) {
    console.log(`  OK   ${titulo}`);
  } else {
    fallos++;
    console.log(`  FALLA ${titulo}${detalle ? ` — ${detalle}` : ''}`);
  }
};
const seccion = (t) => console.log(`\n${t}`);

let token = '';
const api = async (ruta, opciones = {}) => {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '198.51.100.99',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opciones.headers,
    },
  });
  const texto = await res.text();
  let body;
  try {
    body = texto ? JSON.parse(texto) : null;
  } catch {
    body = texto;
  }
  return { status: res.status, body };
};
const post = (ruta, body) =>
  api(ruta, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const put = (ruta, body) => api(ruta, { method: 'PUT', body: JSON.stringify(body) });

// La única llamada SIN token: `/api/config` es pública a propósito.
const config = () => fetch(`${BASE}/api/config`).then((r) => r.json());

/** Apaga o prende un módulo. Sin token = sin autorización = falla ruidosa. */
const setModulo = (clave, encendido) => put('/api/admin/settings', { clave, valor: encendido ? '1' : '0' });

console.log(`\nQA Módulos activos · ${BASE}\n`);

{
  const r = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) {
    console.error('No se pudo entrar:', r.status, JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  token = r.body.token;
}

try {
  // ─────────────── 1. /api/config expone los cuatro módulos ────────────────

  seccion('1. /api/config');

  const cfg = await config();
  ok(
    cfg?.modulos?.pos === true &&
      cfg?.modulos?.ecommerce === true &&
      cfg?.modulos?.entregas === true &&
      cfg?.modulos?.tesoreria === true,
    'los cuatro módulos vienen encendidos por defecto',
    JSON.stringify(cfg?.modulos),
  );

  // ─────────────── 2. Apagar POS ─────────────────────────────────────────

  seccion('2. Apagar POS');

  const { body: catalogo } = await api('/api/admin/products?limit=500');
  const algo = (catalogo?.products ?? []).find(
    (p) => (p.stock ?? 0) > 5 && !p.tieneVariantes && !p.esCanasta,
  );
  if (!algo) {
    console.error('No hay producto con stock. Corre npm run db:reset.');
    process.exit(1);
  }

  const apagarPos = await setModulo('modulo_pos', false);
  ok(apagarPos.status === 200, 'se apaga POS', `status ${apagarPos.status}`);

  const ventaConPosApagado = await post('/api/admin/pos/sell', {
    items: [{ productId: algo.id, cantidad: 1 }],
    metodoPago: 'efectivo',
  });
  ok(
    ventaConPosApagado.status === 403,
    'una venta de mostrador se rechaza mientras POS está apagado',
    `status ${ventaConPosApagado.status}`,
  );

  // El catálogo del cajero (Inventario, que es del núcleo) no se ve afectado.
  const catalogoConPosApagado = await api('/api/admin/products?limit=5');
  ok(
    catalogoConPosApagado.status === 200 && (catalogoConPosApagado.body?.products?.length ?? 0) > 0,
    'y el catálogo del núcleo sigue respondiendo igual',
  );

  await setModulo('modulo_pos', true);

  // ─────────────── 3. Apagar E-commerce ───────────────────────────────────

  seccion('3. Apagar E-commerce');

  const apagarEcommerce = await setModulo('modulo_ecommerce', false);
  ok(apagarEcommerce.status === 200, 'se apaga E-commerce', `status ${apagarEcommerce.status}`);

  const pedidoWebConEcommerceApagado = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Módulos',
      clienteTelefono: '3000000000',
      clienteDireccion: 'Calle QA # 1-23',
      clienteCedula: `9${Math.floor(Math.random() * 1_000_000_000)}`,
      items: [{ productId: algo.id, cantidad: 1 }],
      metodoPago: 'transferencia',
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  ok(
    pedidoWebConEcommerceApagado.status === 403,
    'un pedido web se rechaza mientras E-commerce está apagado',
    `status ${pedidoWebConEcommerceApagado.status}`,
  );

  // La venta de mostrador, en cambio, ni se entera.
  const ventaPosConEcommerceApagado = await post('/api/admin/pos/sell', {
    items: [{ productId: algo.id, cantidad: 1 }],
    metodoPago: 'efectivo',
  });
  ok(
    ventaPosConEcommerceApagado.status === 201,
    'y POS sigue vendiendo sin que E-commerce le importe',
    `status ${ventaPosConEcommerceApagado.status}`,
  );

  await setModulo('modulo_ecommerce', true);

  // ─────────────── 4. Apagar Entregas ─────────────────────────────────────

  seccion('4. Apagar Entregas');

  const apagarEntregas = await setModulo('modulo_entregas', false);
  ok(apagarEntregas.status === 200, 'se apagan Entregas', `status ${apagarEntregas.status}`);

  // Ni dirección ni teléfono en el cuerpo: si Entregas de verdad está
  // apagado, el pedido tiene que nacer igual.
  const pedidoSinEntregas = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Sin Entregas',
      clienteCedula: `9${Math.floor(Math.random() * 1_000_000_000)}`,
      items: [{ productId: algo.id, cantidad: 1 }],
      metodoPago: 'contraentrega', // a propósito: no debería colarse igual
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  ok(pedidoSinEntregas.status === 201, 'nace sin exigir dirección ni teléfono', `status ${pedidoSinEntregas.status}`);
  ok(
    pedidoSinEntregas.body?.order?.envio === 0,
    'con envío en 0, aunque no se pidió "entrega en tienda" explícitamente',
    `envio ${pedidoSinEntregas.body?.order?.envio}`,
  );
  ok(
    pedidoSinEntregas.body?.order?.metodoPago !== 'contraentrega',
    'y el método NO quedó en "contraentrega" — no hay quién cobre en la puerta',
    `metodoPago ${pedidoSinEntregas.body?.order?.metodoPago}`,
  );

  await setModulo('modulo_entregas', true);

  // ─────────────── 5. Apagar Tesorería no rompe una venta ─────────────────

  seccion('5. Apagar Tesorería');

  const apagarTesoreria = await setModulo('modulo_tesoreria', false);
  ok(apagarTesoreria.status === 200, 'se apaga Tesorería', `status ${apagarTesoreria.status}`);

  const ventaConTesoreriaApagada = await post('/api/admin/pos/sell', {
    items: [{ productId: algo.id, cantidad: 1 }],
    metodoPago: 'efectivo',
  });
  ok(
    ventaConTesoreriaApagada.status === 201,
    'una venta en efectivo se cobra igual, sin exigir turno ni cuenta',
    `status ${ventaConTesoreriaApagada.status}`,
  );

  await setModulo('modulo_tesoreria', true);

  // ─────────────── 6. Al menos un canal de venta ──────────────────────────

  seccion('6. No se puede apagar POS y E-commerce a la vez');

  const apagarPos2 = await setModulo('modulo_pos', false);
  ok(apagarPos2.status === 200, 'se apaga POS primero, solo', `status ${apagarPos2.status}`);

  const apagarLosDos = await setModulo('modulo_ecommerce', false);
  ok(
    apagarLosDos.status === 409,
    'apagar también E-commerce se rechaza: no quedaría ningún canal de venta',
    `status ${apagarLosDos.status}`,
  );

  await setModulo('modulo_pos', true);

  const cfgFinal = await config();
  ok(
    cfgFinal?.modulos?.pos === true && cfgFinal?.modulos?.ecommerce === true,
    'los dos canales de venta quedan encendidos al terminar',
  );
} finally {
  // Cinturón y tirantes: pase lo que pase arriba, la instalación queda tal
  // como la encontró cualquiera que corra la próxima suite.
  await Promise.all([
    setModulo('modulo_pos', true),
    setModulo('modulo_ecommerce', true),
    setModulo('modulo_entregas', true),
    setModulo('modulo_tesoreria', true),
  ]);
}

console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} FALLO(S)\n`);
process.exit(fallos === 0 ? 0 : 1);
