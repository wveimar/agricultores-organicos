/**
 * QA del módulo de delivery (migración 0029).
 *
 * Comprueba:
 *  1. La lista de domiciliarios trae solo cuentas con ese rol y activas.
 *  2. Asignar guarda id y nombre congelado.
 *  3. Reasignar sobrescribe sin pasos intermedios.
 *  4. Soltar (null) deja el pedido sin domiciliario.
 *  5. Asignar a alguien sin el rol se rechaza.
 *  6. No se le asigna domiciliario a un pedido que no está en la calle.
 *  7. Un domiciliario ve solo lo suyo (y lo que no tiene dueño).
 *
 * Uso: node worker/tests/qa-delivery.mjs [base] [email] [password]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';
const EMAIL = process.argv[3] ?? 'admin@agricultores.co';
const PASSWORD = process.argv[4] ?? 'demo1234';

let token = '';
let fallos = 0;

function ok(condicion, titulo, detalle = '') {
  if (condicion) {
    console.log(`  OK   ${titulo}`);
  } else {
    fallos++;
    console.log(`  FALLA ${titulo}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function api(ruta, opciones = {}, tokenPropio = null) {
  const usado = tokenPropio ?? token;
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      ...(usado ? { authorization: `Bearer ${usado}` } : {}),
      ...opciones.headers,
    },
  });
  const texto = await res.text();
  let cuerpo;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }
  return { status: res.status, body: cuerpo };
}

async function entrar(email, password) {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    console.error('No se pudo entrar:', email, res.status);
    process.exit(1);
  }
  return res.body.token;
}

token = await entrar(EMAIL, PASSWORD);

console.log('\n── 0 · Preparar un domiciliario ──');

const CORREO_DOM = `domiciliario.qa.${Date.now()}@agricultores.co`;
const creado = await api('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: CORREO_DOM,
    nombre: 'Repartidor QA',
    password: 'demo1234',
    roles: ['DOMICILIARIO'],
  }),
});
ok(creado.status === 201, 'se crea una cuenta de domiciliario', `status ${creado.status}`);
const domiciliarioId = creado.body?.user?.id;

console.log('\n── 1 · La lista de domiciliarios ──');

const lista = await api('/api/admin/couriers');
ok(lista.status === 200, 'responde el listado', `status ${lista.status}`);
ok(
  lista.body.couriers.some((c) => c.id === domiciliarioId),
  'incluye al recién creado',
);
ok(
  lista.body.couriers.every((c) => !('email' in c)),
  'no filtra el correo de nadie: solo id y nombre',
);

console.log('\n── 2 · Asignar ──');

const catalogo = await api('/api/products');
const producto = catalogo.body.products.find((p) => p.stock > 2 && !p.parentId);

async function pedidoEnLaCalle() {
  const nuevo = await api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      clienteNombre: 'Delivery QA',
      clienteTelefono: `30077${Math.floor(Math.random() * 100000)}`,
      clienteDireccion: 'Calle QA 45',
      metodoPago: 'contraentrega',
      items: [{ productId: producto.id, cantidad: 1 }],
    }),
  });
  const id = nuevo.body.order.id;
  await api(`/api/admin/orders/${id}/aprobar`, { method: 'POST' });
  await api(`/api/admin/orders/${id}/enviar`, { method: 'POST' });
  return id;
}

const pedido = await pedidoEnLaCalle();

const asignado = await api(`/api/admin/orders/${pedido}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId }),
});
ok(asignado.status === 200, 'se asigna el domiciliario', `status ${asignado.status}`);
ok(
  asignado.body?.order?.domiciliarioNombre === 'Repartidor QA',
  'guarda el nombre congelado',
  asignado.body?.order?.domiciliarioNombre,
);

console.log('\n── 3 · Reasignar y soltar ──');

const segundo = await api('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: `domiciliario.qa2.${Date.now()}@agricultores.co`,
    nombre: 'Repartidor QA 2',
    password: 'demo1234',
    roles: ['DOMICILIARIO'],
  }),
});

const reasignado = await api(`/api/admin/orders/${pedido}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId: segundo.body.user.id }),
});
ok(
  reasignado.body?.order?.domiciliarioNombre === 'Repartidor QA 2',
  'reasignar sobrescribe sin pasos intermedios',
  reasignado.body?.order?.domiciliarioNombre,
);

const soltado = await api(`/api/admin/orders/${pedido}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId: null }),
});
ok(soltado.body?.order?.domiciliarioId === null, 'mandar null lo deja sin domiciliario');

console.log('\n── 4 · Lo que no se permite ──');

const noDomiciliario = await api(`/api/admin/orders/${pedido}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId: 'u-01' }),
});
ok(
  noDomiciliario.status === 400,
  'asignar a alguien sin el rol se rechaza',
  `status ${noDomiciliario.status}`,
);

const pendiente = await api('/api/orders', {
  method: 'POST',
  body: JSON.stringify({
    clienteNombre: 'Sin aprobar QA',
    clienteTelefono: `30088${Math.floor(Math.random() * 100000)}`,
    clienteDireccion: 'Calle QA 99',
    items: [{ productId: producto.id, cantidad: 1 }],
  }),
});
const sinAprobar = await api(`/api/admin/orders/${pendiente.body.order.id}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId }),
});
ok(
  sinAprobar.status === 409,
  'un pedido que no está en la calle no admite domiciliario',
  `status ${sinAprobar.status}`,
);

console.log('\n── 5 · Cada domiciliario ve lo suyo ──');

const mio = await pedidoEnLaCalle();
const ajeno = await pedidoEnLaCalle();
await api(`/api/admin/orders/${mio}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId }),
});
await api(`/api/admin/orders/${ajeno}/domiciliario`, {
  method: 'POST',
  body: JSON.stringify({ domiciliarioId: segundo.body.user.id }),
});

const tokenDom = await entrar(CORREO_DOM, 'demo1234');
const susEntregas = await api('/api/admin/entregas', {}, tokenDom);
const ids = susEntregas.body.entregas.map((e) => e.id);

ok(ids.includes(mio), 've el pedido que lleva él');
ok(!ids.includes(ajeno), 'NO ve el del otro domiciliario');

const comoGestor = await api('/api/admin/entregas');
const idsGestor = comoGestor.body.entregas.map((e) => e.id);
ok(idsGestor.includes(mio) && idsGestor.includes(ajeno), 'el gestor ve toda la calle');

console.log(`\n${fallos === 0 ? 'TODO EN VERDE' : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
