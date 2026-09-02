/**
 * QA del módulo de cartera (migración 0028).
 *
 * Lo que se comprueba:
 *  1. Un abono parcial deja la factura en 'pagada_parcial' con el saldo justo.
 *  2. Varios abonos sobre la misma factura la saldan.
 *  3. Un solo pago reparte entre varias facturas, de la más vieja primero.
 *  4. Lo que sobra queda como anticipo y no infla ninguna factura.
 *  5. Un reparto a mano inválido se rechaza.
 *  6. Editar un cobro recalcula las facturas que tocaba y las nuevas.
 *  7. Borrar un cobro devuelve la deuda.
 *  8. Cobrar contra entrega crea el cobro, y no cuenta para caja hasta liquidar.
 *  9. Un cobro ya cerrado en caja no se edita ni se borra.
 *
 * Uso: node worker/tests/qa-cartera.mjs [base] [email] [password]
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

async function api(ruta, opciones = {}) {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function login() {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) {
    console.error('No se pudo entrar:', res.status, JSON.stringify(res.body).slice(0, 300));
    process.exit(1);
  }
  token = res.body.token;
}

/** Crea un contacto cliente y devuelve su id. */
async function crearCliente(nombre) {
  const res = await api('/api/admin/contacts', {
    method: 'POST',
    body: JSON.stringify({
      nombre,
      telefono: `31${Math.floor(Math.random() * 100000000)}`,
      esCliente: 1,
      documento: cedulaQA(),
      esProveedor: 0,
    }),
  });
  if (res.status !== 201) {
    console.error('No se pudo crear el contacto:', res.status, JSON.stringify(res.body).slice(0, 400));
    process.exit(1);
  }
  return res.body.contacto.id;
}

/** Factura a mano contra un contacto, por el monto que se pida. */
async function facturar(contactId, clienteNombre, monto) {
  const res = await api('/api/admin/invoices', {
    method: 'POST',
    body: JSON.stringify({
      contactId,
      clienteNombre,
      items: [{ descripcion: 'Mercancía QA', cantidad: 1, precioUnitario: monto }],
    }),
  });
  if (res.status !== 201) {
    console.error('No se pudo facturar:', res.status, JSON.stringify(res.body).slice(0, 400));
    process.exit(1);
  }
  return res.body.invoice;
}

async function leerFactura(id) {
  const res = await api(`/api/admin/invoices/${id}`);
  return res.body.invoice;
}

// ─────────────────────────────────── Pruebas ───────────────────────────────────

await login();

console.log('\n── 1 · Abono parcial ──');

const cliente = await crearCliente('Restaurante QA');
const f1 = await facturar(cliente, 'Restaurante QA', 45_000);

const abono1 = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: cliente, monto: 20_000, metodo: 'efectivo' }),
});
ok(abono1.status === 201, 'se registra un abono de 20.000', `status ${abono1.status}`);

let estado = await leerFactura(f1.id);
ok(estado.saldo === 25_000, 'la factura queda debiendo 25.000', `saldo ${estado.saldo}`);
ok(estado.estado === 'pagada_parcial', "y en estado 'pagada_parcial'", estado.estado);
ok(abono1.body.anticipo === 0, 'no hay anticipo: todo se aplicó a la deuda');

console.log('\n── 2 · Segundo abono que la salda ──');

await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: cliente, monto: 25_000, metodo: 'transferencia' }),
});

estado = await leerFactura(f1.id);
ok(estado.saldo === 0, 'la factura queda en cero', `saldo ${estado.saldo}`);
ok(estado.estado === 'pagada', "y en estado 'pagada'", estado.estado);

console.log('\n── 3 · Un pago reparte entre varias facturas ──');

const cliente2 = await crearCliente('Hotel QA');
const a = await facturar(cliente2, 'Hotel QA', 45_000);
await new Promise((r) => setTimeout(r, 1100)); // que las fechas se ordenen
const b = await facturar(cliente2, 'Hotel QA', 30_000);
await new Promise((r) => setTimeout(r, 1100));
const c = await facturar(cliente2, 'Hotel QA', 50_000);

const grande = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: cliente2, monto: 100_000, metodo: 'transferencia' }),
});
ok(grande.status === 201, 'se registra un pago de 100.000', `status ${grande.status}`);

const ea = await leerFactura(a.id);
const eb = await leerFactura(b.id);
const ec = await leerFactura(c.id);

ok(ea.saldo === 0, 'la más vieja queda saldada', `saldo ${ea.saldo}`);
ok(eb.saldo === 0, 'la segunda también', `saldo ${eb.saldo}`);
ok(ec.saldo === 25_000, 'la más nueva queda debiendo 25.000', `saldo ${ec.saldo}`);
ok(ec.estado === 'pagada_parcial', 'y en pagada_parcial', ec.estado);

console.log('\n── 4 · Anticipo ──');

const cliente3 = await crearCliente('Anticipo QA');
const chica = await facturar(cliente3, 'Anticipo QA', 10_000);

const conSobrante = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: cliente3, monto: 15_000 }),
});
ok(conSobrante.body.anticipo === 5_000, 'los 5.000 sobrantes quedan como anticipo', `${conSobrante.body.anticipo}`);

const echica = await leerFactura(chica.id);
ok(echica.saldo === 0, 'la factura se salda exacta, sin inflarse', `saldo ${echica.saldo}`);
ok(echica.total === 10_000, 'y su total no cambió', `total ${echica.total}`);

console.log('\n── 5 · Reparto a mano inválido ──');

const cliente4 = await crearCliente('Reparto QA');
const d = await facturar(cliente4, 'Reparto QA', 20_000);

const sobreAsignado = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({
    contactId: cliente4,
    monto: 10_000,
    allocations: [{ invoiceId: d.id, monto: 20_000 }],
  }),
});
ok(sobreAsignado.status === 400, 'repartir más de lo que entró se rechaza', `status ${sobreAsignado.status}`);

const ajena = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({
    contactId: cliente4,
    monto: 10_000,
    allocations: [{ invoiceId: f1.id, monto: 5_000 }],
  }),
});
ok(ajena.status === 400, 'repartir sobre la factura de otro cliente se rechaza', `status ${ajena.status}`);

console.log('\n── 6 · Editar un cobro ──');

const editable = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: cliente4, monto: 5_000 }),
});
let ed = await leerFactura(d.id);
ok(ed.saldo === 15_000, 'tras el abono de 5.000 debe 15.000', `saldo ${ed.saldo}`);

const editado = await api(`/api/admin/payments/${editable.body.payment.id}`, {
  method: 'PUT',
  body: JSON.stringify({ monto: 12_000, metodo: 'nequi' }),
});
ok(editado.status === 200, 'se puede editar el cobro', `status ${editado.status}`);

ed = await leerFactura(d.id);
ok(ed.saldo === 8_000, 'la factura se recalcula: ahora debe 8.000', `saldo ${ed.saldo}`);

console.log('\n── 7 · Borrar un cobro devuelve la deuda ──');

const borrado = await api(`/api/admin/payments/${editable.body.payment.id}`, { method: 'DELETE' });
ok(borrado.status === 200, 'se borra el cobro', `status ${borrado.status}`);

ed = await leerFactura(d.id);
ok(ed.saldo === 20_000, 'la factura vuelve a deber todo', `saldo ${ed.saldo}`);
ok(ed.estado === 'emitida', "y vuelve a 'emitida'", ed.estado);

console.log('\n── 8 · Contra entrega: cobrado pero no liquidado ──');

const catalogo = await api('/api/products');
const producto = catalogo.body.products.find((p) => p.stock > 2 && !p.parentId);
const pedido = await api('/api/orders', {
  method: 'POST',
  body: JSON.stringify({
    clienteNombre: 'COD QA',
    clienteTelefono: `30055${Math.floor(Math.random() * 100000)}`,
    clienteDireccion: 'Calle QA',
    // La cédula es obligatoria desde que identifica al cliente. Al azar
    // para no chocar con el índice único entre corridas del script.
    clienteCedula: cedulaQA(),
    metodoPago: 'contraentrega',
    items: [{ productId: producto.id, cantidad: 1 }],
  }),
});
const orderId = pedido.body.order.id;

await api(`/api/admin/orders/${orderId}/aprobar`, { method: 'POST' });
await api(`/api/admin/orders/${orderId}/enviar`, { method: 'POST' });
await api(`/api/admin/orders/${orderId}/pagar`, { method: 'POST' });

const cobros = await api('/api/admin/payments');
const delPedido = cobros.body.payments.find((p) => p.id === `pay-cod-${orderId}`);
ok(!!delPedido, 'cobrar en la puerta registra un cobro');
ok(delPedido?.liquidado === 0, 'nace SIN liquidar: la plata está con el domiciliario');
ok(delPedido?.metodo === 'efectivo', 'y como efectivo', delPedido?.metodo);

const facturasTrasCobro = await api('/api/admin/invoices');
const facPedido = facturasTrasCobro.body.invoices.find((f) => f.orderId === orderId);
ok(facPedido?.estado === 'pagada', 'la factura del pedido queda pagada', facPedido?.estado);

await api(`/api/admin/orders/${orderId}/liquidar`, { method: 'POST' });
const trasLiquidar = await api('/api/admin/payments');
const liquidado = trasLiquidar.body.payments.find((p) => p.id === `pay-cod-${orderId}`);
ok(liquidado?.liquidado === 1, 'al liquidar, el cobro pasa a contar para caja');

console.log('\n── 9 · Un cobro ya cerrado no se toca ──');

const antesDelCierre = await api('/api/admin/payments');
const sinCerrar = antesDelCierre.body.payments.filter((p) => !p.closingId && p.liquidado === 1);
const cierre = await api('/api/admin/reports/cash/close', { method: 'POST' });
ok(cierre.status === 200 || cierre.status === 201, 'se cierra la caja', `status ${cierre.status}`);

const sumaEsperada = sinCerrar.reduce((t, p) => t + p.monto, 0);
ok(
  cierre.body?.closing?.totalCobrado === sumaEsperada,
  'el cierre congela lo COBRADO en la jornada',
  `${cierre.body?.closing?.totalCobrado} vs ${sumaEsperada}`,
);

if (sinCerrar.length > 0) {
  const yaCerrado = sinCerrar[0].id;

  // Igual que en facturación: desde la 0030 el administrador puede corregir un
  // cobro de una jornada cerrada, así que la barrera hay que probarla con una
  // cuenta que solo tenga GESTOR_PEDIDOS.
  const CORREO_GESTOR = `gestor.car.${Date.now()}@agricultores.co`;
  await api('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: CORREO_GESTOR,
      nombre: 'Gestor Cartera QA',
      password: 'demo1234',
      roles: ['GESTOR_PEDIDOS'],
    }),
  });
  const loginGestor = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: CORREO_GESTOR, password: 'demo1234' }),
  });
  const tokenGestor = loginGestor.body.token;

  const editarComoGestor = await fetch(`${BASE}/api/admin/payments/${yaCerrado}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenGestor}` },
    body: JSON.stringify({ monto: 1 }),
  });
  ok(
    editarComoGestor.status === 409,
    'para quien cobra a diario, un cobro ya cerrado no se toca',
    `status ${editarComoGestor.status}`,
  );

  const borrarComoGestor = await fetch(`${BASE}/api/admin/payments/${yaCerrado}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tokenGestor}` },
  });
  ok(borrarComoGestor.status === 409, 'ni se deshace', `status ${borrarComoGestor.status}`);

  // Y el administrador sí, avisando de que el recibo de esa jornada deja de
  // cuadrar. Ese aviso es la parte importante: la corrección se permite, pero
  // no en silencio.
  const editarComoAdmin = await api(`/api/admin/payments/${yaCerrado}`, {
    method: 'PUT',
    body: JSON.stringify({ monto: 1 }),
  });
  ok(
    editarComoAdmin.status === 200,
    'el administrador sí puede corregirlo',
    `status ${editarComoAdmin.status}`,
  );
  ok(
    typeof editarComoAdmin.body?.aviso === 'string' &&
      editarComoAdmin.body.aviso.includes('cierre'),
    'y se avisa de que el cierre queda descuadrado',
    editarComoAdmin.body?.aviso,
  );
}

console.log(`\n${fallos === 0 ? 'TODO EN VERDE' : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
