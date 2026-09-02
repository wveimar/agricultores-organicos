/**
 * QA de notas crédito/débito y de los permisos nuevos (migración 0030).
 *
 * Comprueba:
 *  1. Una nota crédito baja el saldo de su factura.
 *  2. Una nota crédito puede saldar una factura entera.
 *  3. Una nota débito lo sube por encima del total original.
 *  4. No se puede acreditar más de lo que la factura admite.
 *  5. No se le emite una nota a otra nota.
 *  6. Una nota crédito sobre una factura YA PAGADA deja saldo a favor coherente.
 *  7. El domiciliario puede registrar un abono, y le nace sin liquidar.
 *  8. El domiciliario NO puede editar ni borrar cobros.
 *  9. El administrador SÍ puede editar una factura ya cobrada, con aviso.
 *
 * Uso: node worker/tests/qa-notas.mjs [base] [email] [password]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';
const EMAIL = process.argv[3] ?? 'admin@agricultores.co';
const PASSWORD = process.argv[4] ?? 'demo1234';

let token = '';
let fallos = 0;

/**
 * Una cédula de prueba distinta en cada llamada.
 *
 * `contacts.documento` es único, así que un número fijo haría fallar la
 * segunda corrida del script contra la misma base. El prefijo 9 la marca
 * como inventada: ninguna cédula colombiana real empieza así.
 */
function cedulaQA() {
  return `9${Math.floor(Math.random() * 1_000_000_000)}`;
}

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

async function crearCliente(nombre) {
  const res = await api('/api/admin/contacts', {
    method: 'POST',
    body: JSON.stringify({
      nombre,
      telefono: `32${Math.floor(Math.random() * 100000000)}`,
      esCliente: 1,
      documento: cedulaQA(),
      esProveedor: 0,
    }),
  });
  return res.body.contacto.id;
}

async function facturar(contactId, nombre, monto) {
  const res = await api('/api/admin/invoices', {
    method: 'POST',
    body: JSON.stringify({
      contactId,
      clienteNombre: nombre,
      items: [{ descripcion: 'Mercancía QA', cantidad: 1, precioUnitario: monto }],
    }),
  });
  return res.body.invoice;
}

const leer = async (id) => (await api(`/api/admin/invoices/${id}`)).body.invoice;

const nota = (facturaId, tipo, monto, motivo = 'Prueba QA') =>
  api(`/api/admin/invoices/${facturaId}/nota`, {
    method: 'POST',
    body: JSON.stringify({
      tipo,
      motivo,
      items: [{ descripcion: 'Ajuste QA', cantidad: 1, precioUnitario: monto }],
    }),
  });

// ─────────────────────────────── 1 · Nota crédito ───────────────────────────────
console.log('\n── 1 · Nota crédito ──');

const c1 = await crearCliente('Notas QA');
const f1 = await facturar(c1, 'Notas QA', 50_000);

const nc = await nota(f1.id, 'nota_credito', 20_000, 'Devolvió media caja');
ok(nc.status === 201, 'se emite la nota crédito', `status ${nc.status}`);
ok(/^NC-\d{6}$/.test(nc.body?.nota?.numero ?? ''), 'con su propia serie NC-', nc.body?.nota?.numero);

let e = await leer(f1.id);
ok(e.saldo === 30_000, 'la factura baja a 30.000', `saldo ${e.saldo}`);
ok(e.total === 50_000, 'el total NO cambia: la nota es otro documento', `total ${e.total}`);

// ─────────────────────────── 2 · Nota que salda entera ───────────────────────────
console.log('\n── 2 · Nota crédito que salda la factura ──');

const f2 = await facturar(c1, 'Notas QA', 10_000);
await nota(f2.id, 'nota_credito', 10_000, 'Se le regaló');
e = await leer(f2.id);
ok(e.saldo === 0, 'queda en cero', `saldo ${e.saldo}`);
ok(e.estado === 'pagada', "y en estado 'pagada'", e.estado);

// ─────────────────────────────── 3 · Nota débito ───────────────────────────────
console.log('\n── 3 · Nota débito ──');

const f3 = await facturar(c1, 'Notas QA', 20_000);
const nd = await nota(f3.id, 'nota_debito', 5_000, 'Interés de mora');
ok(nd.status === 201, 'se emite la nota débito', `status ${nd.status}`);
ok(/^ND-\d{6}$/.test(nd.body?.nota?.numero ?? ''), 'con su serie ND-', nd.body?.nota?.numero);

e = await leer(f3.id);
ok(e.saldo === 25_000, 'el saldo SUPERA el total original', `saldo ${e.saldo} vs total ${e.total}`);

// ──────────────────────── 4 · No se acredita de más ────────────────────────
console.log('\n── 4 · Límite del crédito ──');

const excesiva = await nota(f1.id, 'nota_credito', 999_999, 'Demasiado');
ok(excesiva.status === 400, 'acreditar de más se rechaza', `status ${excesiva.status}`);
ok(
  excesiva.body?.error?.code === 'credito-excesivo',
  'con un código propio',
  excesiva.body?.error?.code,
);

// ──────────────────────── 5 · No hay notas sobre notas ────────────────────────
console.log('\n── 5 · Una nota no admite notas ──');

const encadenada = await nota(nc.body.nota.id, 'nota_credito', 1_000);
ok(encadenada.status === 400, 'se rechaza la nota sobre una nota', `status ${encadenada.status}`);

const sinMotivo = await api(`/api/admin/invoices/${f3.id}/nota`, {
  method: 'POST',
  body: JSON.stringify({ tipo: 'nota_credito', items: [{ descripcion: 'x', cantidad: 1, precioUnitario: 1 }] }),
});
ok(sinMotivo.status === 400, 'una nota sin motivo se rechaza', `status ${sinMotivo.status}`);

// ─────────────────── 6 · Crédito sobre una factura ya pagada ───────────────────
console.log('\n── 6 · Crédito sobre lo ya cobrado ──');

const c2 = await crearCliente('Devolucion QA');
const f4 = await facturar(c2, 'Devolucion QA', 30_000);
await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: c2, monto: 30_000, metodo: 'efectivo' }),
});
e = await leer(f4.id);
ok(e.estado === 'pagada', 'la factura se cobra entera', e.estado);

const devolucion = await nota(f4.id, 'nota_credito', 12_000, 'Devolvió tres kilos');
ok(devolucion.status === 201, 'se puede acreditar algo ya cobrado', `status ${devolucion.status}`);
e = await leer(f4.id);
ok(e.saldo === 0, 'el saldo sigue en cero: se cobró de más, no se debe', `saldo ${e.saldo}`);
ok(e.estado === 'pagada', 'y sigue pagada', e.estado);

// ─────────────────── 7 · El domiciliario cobra y abona ───────────────────
console.log('\n── 7 · Cobros del domiciliario ──');

const CORREO = `dom.notas.${Date.now()}@agricultores.co`;
await api('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: CORREO,
    nombre: 'Repartidor Notas',
    password: 'demo1234',
    roles: ['DOMICILIARIO'],
  }),
});
const tokenDom = await entrar(CORREO, 'demo1234');

const c3 = await crearCliente('Cliente Viejo QA');
const f5 = await facturar(c3, 'Cliente Viejo QA', 40_000);

const abonoDom = await api(
  '/api/admin/payments',
  { method: 'POST', body: JSON.stringify({ contactId: c3, monto: 15_000, metodo: 'efectivo' }) },
  tokenDom,
);
ok(abonoDom.status === 201, 'el domiciliario puede abonar una deuda vieja', `status ${abonoDom.status}`);
ok(
  abonoDom.body?.payment?.liquidado === 0,
  'y su cobro nace SIN liquidar: la plata va en su bolsillo',
  `liquidado ${abonoDom.body?.payment?.liquidado}`,
);

e = await leer(f5.id);
ok(e.saldo === 25_000, 'la factura vieja baja a 25.000', `saldo ${e.saldo}`);

// ─────────────────── 8 · Lo que el domiciliario NO puede ───────────────────
console.log('\n── 8 · Límites del domiciliario ──');

const editaDom = await api(
  `/api/admin/payments/${abonoDom.body.payment.id}`,
  { method: 'PUT', body: JSON.stringify({ monto: 1 }) },
  tokenDom,
);
ok(editaDom.status === 403, 'no puede editar cobros', `status ${editaDom.status}`);

const borraDom = await api(
  `/api/admin/payments/${abonoDom.body.payment.id}`,
  { method: 'DELETE' },
  tokenDom,
);
ok(borraDom.status === 403, 'ni borrarlos', `status ${borraDom.status}`);

const facturaDom = await api(
  '/api/admin/invoices',
  { method: 'POST', body: JSON.stringify({ clienteNombre: 'x', items: [{ descripcion: 'x', cantidad: 1, precioUnitario: 1 }] }) },
  tokenDom,
);
ok(facturaDom.status === 403, 'ni facturar', `status ${facturaDom.status}`);

// ─────────────────── 9 · El administrador sí puede ───────────────────
console.log('\n── 9 · El atajo del administrador ──');

const editaAdmin = await api(`/api/admin/invoices/${f5.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    clienteNombre: 'Cliente Viejo QA',
    items: [{ descripcion: 'Corregido por admin', cantidad: 1, precioUnitario: 38_000 }],
  }),
});
ok(
  editaAdmin.status === 200,
  'el administrador edita una factura ya abonada',
  `status ${editaAdmin.status}`,
);
ok(editaAdmin.body?.forzadoPorAdmin === true, 'y la respuesta avisa de que se forzó');

// Ni el administrador puede borrar una factura con cobros encima: la FK
// RESTRICT lo impide, y tiene que impedirlo — ese dinero quedaría sin
// explicación. Lo que sí debe hacer es decirlo con claridad, no reventar.
const borraAdmin = await api(`/api/admin/invoices/${f5.id}`, { method: 'DELETE' });
ok(
  borraAdmin.status === 409,
  'borrar una factura con cobros da 409, no un 500 en crudo',
  `status ${borraAdmin.status}`,
);
ok(
  borraAdmin.body?.error?.code === 'factura-con-cobros',
  'y explica qué hacer en su lugar',
  borraAdmin.body?.error?.code,
);

// Sin cobros encima sí la borra, aunque tenga notas: las notas son suyas.
const c4 = await crearCliente('Borrable QA');
const f6 = await facturar(c4, 'Borrable QA', 5_000);
const borrable = await api(`/api/admin/invoices/${f6.id}`, { method: 'DELETE' });
ok(borrable.status === 200, 'una factura sin cobros sí se borra', `status ${borrable.status}`);

console.log(`\n${fallos === 0 ? 'TODO EN VERDE' : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
