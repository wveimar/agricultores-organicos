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
// Esta suite crea siete pedidos de un producto cada uno (uno más por cada
// camino de cobro nuevo): el filtro de stock tiene que cubrir eso de sobra.
const producto = catalogo.body.products.find((p) => p.stock > 15 && !p.parentId);

async function pedidoEnLaCalle() {
  const nuevo = await api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      clienteNombre: 'Delivery QA',
      clienteTelefono: `30077${Math.floor(Math.random() * 100000)}`,
      clienteDireccion: 'Calle QA 45',
      // La cédula es obligatoria desde que identifica al cliente. Al azar
      // para no chocar con el índice único entre corridas del script.
      clienteCedula: cedulaQA(),
      metodoPago: 'contraentrega',
      items: [{ productId: producto.id, cantidad: 1 }],
    }),
  });
  const id = nuevo.body.order.id;
  await api(`/api/admin/orders/${id}/aprobar`, { method: 'POST' });
  await api(`/api/admin/orders/${id}/enviar`, { method: 'POST' });
  // No hay GET /api/admin/orders/:id — el total sale de la propia respuesta de
  // creación, que ya lo trae y no cambia entre aprobar y enviar.
  return { id, total: nuevo.body.order.total };
}

const { id: pedido } = await pedidoEnLaCalle();

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
    // La cédula es obligatoria desde que identifica al cliente. Al azar
    // para no chocar con el índice único entre corridas del script.
    clienteCedula: cedulaQA(),
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

const { id: mio } = await pedidoEnLaCalle();
const { id: ajeno } = await pedidoEnLaCalle();
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

console.log('\n── 6 · Los tres caminos del cobro contra entrega ──');

async function facturaDelPedido(orderId) {
  const lista = await api('/api/admin/invoices');
  return lista.body.invoices.find((f) => f.orderId === orderId);
}

// Pago completo: sin `monto`, se cobra el saldo entero — el camino de siempre.
const { id: pedidoCompleto } = await pedidoEnLaCalle();
const cobroCompleto = await api(
  `/api/admin/orders/${pedidoCompleto}/pagar`,
  { method: 'POST', body: JSON.stringify({}) },
  tokenDom,
);
ok(cobroCompleto.status === 200, 'el domiciliario cobra completo', `status ${cobroCompleto.status}`);
let factura = await facturaDelPedido(pedidoCompleto);
ok(factura?.saldo === 0, 'sin monto, la factura queda en cero', `saldo ${factura?.saldo}`);
ok(factura?.estado === 'pagada', "y en estado 'pagada'", factura?.estado);

// Abono: con `monto` menor al total, el pedido igual pasa a 'pago' —la
// mercancía salió igual— pero la factura queda debiendo la diferencia.
const { id: pedidoAbono, total: totalAbono } = await pedidoEnLaCalle();
const mitad = Math.floor(totalAbono / 2);

const cobroAbono = await api(
  `/api/admin/orders/${pedidoAbono}/pagar`,
  { method: 'POST', body: JSON.stringify({ monto: mitad }) },
  tokenDom,
);
ok(cobroAbono.status === 200, 'el domiciliario registra un abono', `status ${cobroAbono.status}`);
ok(cobroAbono.body?.order?.estado === 'pago', "el pedido pasa a 'pago' igual: la mercancía ya salió");

factura = await facturaDelPedido(pedidoAbono);
ok(
  factura?.saldo === totalAbono - mitad,
  'la factura queda debiendo justo la diferencia',
  `saldo ${factura?.saldo} vs esperado ${totalAbono - mitad}`,
);
ok(factura?.estado === 'pagada_parcial', "y en estado 'pagada_parcial'", factura?.estado);

// La pantalla de "por liquidar" tiene que enseñar lo que el domiciliario
// TRAE en la mano —el abono real—, no lo que vale el pedido completo. Este es
// el defecto que se reportó viendo la pantalla real: antes de este arreglo la
// tarjeta mostraba `subtotal + envio` sin importar cuánto se hubiera cobrado.
const porLiquidar = await api('/api/admin/reports/efectivo-pendiente');
const pendienteAbono = porLiquidar.body.pendientes.find((p) => p.orderId === pedidoAbono);
ok(!!pendienteAbono, 'el pedido con abono aparece en "por liquidar"');
ok(
  pendienteAbono?.cobrado === mitad,
  'la cifra es lo que de verdad se cobró, no el total del pedido',
  `cobrado ${pendienteAbono?.cobrado} vs esperado ${mitad}`,
);
ok(
  pendienteAbono?.cobrado < pendienteAbono?.totalPedido + pendienteAbono?.envio,
  'y por eso es menor que lo que vale el pedido con domicilio',
);

// Con cobro completo, "cobrado" y "lo que vale el pedido" coinciden —el
// caso de siempre, que no debía cambiar con este arreglo.
const pendienteCompleto = porLiquidar.body.pendientes.find((p) => p.orderId === pedidoCompleto);
ok(
  pendienteCompleto?.cobrado === pendienteCompleto?.totalPedido + pendienteCompleto?.envio,
  'con cobro completo, cobrado = total del pedido, como siempre',
  `cobrado ${pendienteCompleto?.cobrado} vs total ${pendienteCompleto?.totalPedido}`,
);

// ─────── El defecto real reportado: un abono suelto también trae plata ───────
//
// El domiciliario cobró $50.000 de una factura vieja en la calle, y oficina
// lo registró marcando "todavía no está en caja". Esa plata TAMBIÉN la trae
// encima, aunque no venga de un pedido contra entrega — antes de este arreglo
// la pantalla de "por liquidar" ni se enteraba, porque solo miraba `orders`.
async function crearClienteQA(nombre) {
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
  return res.body.contacto.id;
}

const clienteAbonoSuelto = await crearClienteQA('Deuda Vieja QA');

const abonoSuelto = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({
    contactId: clienteAbonoSuelto,
    monto: 50_000,
    metodo: 'efectivo',
    enCaja: false,
  }),
});
ok(abonoSuelto.status === 201, 'oficina registra el abono que avisó el domiciliario', `status ${abonoSuelto.status}`);
ok(
  abonoSuelto.body?.payment?.liquidado === 0,
  '"enCaja: false" lo deja SIN liquidar aunque lo registre un GESTOR_PEDIDOS',
  `liquidado ${abonoSuelto.body?.payment?.liquidado}`,
);

const porLiquidarConAbono = await api('/api/admin/reports/efectivo-pendiente');
const filaSuelta = porLiquidarConAbono.body.pendientes.find((p) => p.id === abonoSuelto.body.payment.id);
ok(!!filaSuelta, 'el abono suelto SÍ aparece en "por liquidar" — el defecto reportado', 'no apareció');
ok(filaSuelta?.orderId === null, 'sin pedido detrás: no es un contra entrega', filaSuelta?.orderId);
ok(filaSuelta?.cobrado === 50_000, 'con el monto real cobrado', filaSuelta?.cobrado);

// Sin marcar "enCaja: false" (el caso normal: alguien paga en el mostrador),
// sigue liquidándose de una, como siempre.
const cobroNormal = await api('/api/admin/payments', {
  method: 'POST',
  body: JSON.stringify({ contactId: clienteAbonoSuelto, monto: 10_000, metodo: 'efectivo' }),
});
ok(
  cobroNormal.body?.payment?.liquidado === 1,
  'sin "enCaja", un cobro de oficina sigue liquidándose directo, como antes',
  `liquidado ${cobroNormal.body?.payment?.liquidado}`,
);

// Y liquidar el abono suelto lo saca de la lista sin tocar `orders` para nada.
const liquidarSuelto = await api(`/api/admin/payments/${abonoSuelto.body.payment.id}/liquidar`, {
  method: 'POST',
});
ok(liquidarSuelto.status === 200, 'se libera el abono suelto', `status ${liquidarSuelto.status}`);

const porLiquidarTrasLiberar = await api('/api/admin/reports/efectivo-pendiente');
ok(
  !porLiquidarTrasLiberar.body.pendientes.some((p) => p.id === abonoSuelto.body.payment.id),
  'y ya no aparece en "por liquidar"',
);

const reintentoLiquidar = await api(`/api/admin/payments/${abonoSuelto.body.payment.id}/liquidar`, {
  method: 'POST',
});
ok(reintentoLiquidar.status === 409, 'liquidar dos veces el mismo abono se rechaza', `status ${reintentoLiquidar.status}`);

// Un monto mayor al saldo no puede sobrepagar esta factura por este camino:
// se cubre justo lo que se debía, no más.
const { id: pedidoExceso, total: totalExceso } = await pedidoEnLaCalle();
await api(
  `/api/admin/orders/${pedidoExceso}/pagar`,
  { method: 'POST', body: JSON.stringify({ monto: totalExceso + 50_000 }) },
  tokenDom,
);
factura = await facturaDelPedido(pedidoExceso);
ok(factura?.saldo === 0, 'un monto de más no sobrepaga: queda en cero', `saldo ${factura?.saldo}`);

// No pagó nada: cancela el pedido y anula su factura, y lo puede hacer el
// domiciliario — es quien está delante cuando el cliente no paga.
const { id: pedidoRechazo } = await pedidoEnLaCalle();
const rechazo = await api(
  `/api/admin/orders/${pedidoRechazo}/rechazar-entrega`,
  { method: 'POST', body: JSON.stringify({ motivo: 'No pagó en la puerta' }) },
  tokenDom,
);
ok(
  rechazo.status === 200,
  'el domiciliario puede marcar "no pagó nada"',
  `status ${rechazo.status}`,
);
ok(rechazo.body?.order?.estado === 'cancelado', 'el pedido queda cancelado', rechazo.body?.order?.estado);

factura = await facturaDelPedido(pedidoRechazo);
ok(factura?.estado === 'anulada', 'su factura queda anulada, no viva debiendo nada', factura?.estado);

console.log(`\n${fallos === 0 ? 'TODO EN VERDE' : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
