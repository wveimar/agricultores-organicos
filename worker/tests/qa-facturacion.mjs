/**
 * QA del módulo de facturación (migración 0027).
 *
 * Lo que se comprueba, en orden:
 *  1. Aprobar un pedido emite su factura, con el total congelado.
 *  2. Aprobar dos veces NO emite dos facturas (la guarda del token).
 *  3. Cobrar el pedido deja la factura en 'pagada' con saldo 0.
 *  4. El consecutivo no se repite ni retrocede.
 *  5. Anular exige motivo, y una anulada no se puede anular otra vez.
 *  6. Un rechazo en la entrega anula la factura del pedido.
 *
 * Uso: node worker/tests/qa-facturacion.mjs [base] [email] [password]
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

/** Crea un pedido público con una línea del catálogo, y devuelve su id. */
async function crearPedido(nombre = 'QA Facturación', metodoPago = 'transferencia') {
  const catalogo = await api('/api/products');
  const producto = catalogo.body.products.find((p) => p.stock > 3 && !p.parentId);
  if (!producto) {
    console.error('No hay producto con stock para la prueba.');
    process.exit(1);
  }

  const res = await api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      clienteNombre: nombre,
      clienteTelefono: `30012${Math.floor(Math.random() * 100000)}`,
      clienteDireccion: 'Calle QA 123',
      metodoPago,
      items: [{ productId: producto.id, cantidad: 1 }],
    }),
  });

  if (res.status !== 201) {
    console.error('No se pudo crear el pedido:', res.status, JSON.stringify(res.body).slice(0, 400));
    process.exit(1);
  }
  return { id: res.body.order.id, total: res.body.order.total };
}

async function facturaDe(orderId) {
  const res = await api('/api/admin/invoices');
  return res.body.invoices.find((f) => f.orderId === orderId);
}

// ─────────────────────────────────── Pruebas ───────────────────────────────────

await login();
console.log('\n── 1 · Aprobar emite la factura ──');

const pedido = await crearPedido();
const antes = await facturaDe(pedido.id);
ok(!antes, 'un pedido sin aprobar no tiene factura');

const aprobacion = await api(`/api/admin/orders/${pedido.id}/aprobar`, { method: 'POST' });
ok(aprobacion.status === 200, 'el pedido se aprueba', `status ${aprobacion.status}`);

const factura = await facturaDe(pedido.id);
ok(!!factura, 'al aprobar nace la factura');
ok(factura?.estado === 'emitida', "nace en estado 'emitida'", `estado ${factura?.estado}`);
ok(
  factura?.total === pedido.total,
  'el total de la factura es el del pedido',
  `${factura?.total} vs ${pedido.total}`,
);
ok(factura?.saldo === factura?.total, 'nace debiendo todo (saldo = total)');
ok(/^FAC-\d{6}$/.test(factura?.numero ?? ''), 'el número tiene formato FAC-000000', factura?.numero);

console.log('\n── 2 · Aprobar dos veces no duplica la factura ──');

const reaprobacion = await api(`/api/admin/orders/${pedido.id}/aprobar`, { method: 'POST' });
ok(reaprobacion.status === 409, 'la segunda aprobación se rechaza', `status ${reaprobacion.status}`);

const todas = await api('/api/admin/invoices');
const delPedido = todas.body.invoices.filter((f) => f.orderId === pedido.id);
ok(delPedido.length === 1, 'sigue habiendo UNA sola factura del pedido', `hay ${delPedido.length}`);

console.log('\n── 3 · El consecutivo no se repite ──');

const numeros = todas.body.invoices.map((f) => f.consecutivo);
ok(new Set(numeros).size === numeros.length, 'no hay consecutivos repetidos');

const pedido2 = await crearPedido('QA Facturación 2');
await api(`/api/admin/orders/${pedido2.id}/aprobar`, { method: 'POST' });
const factura2 = await facturaDe(pedido2.id);
ok(
  factura2.consecutivo > factura.consecutivo,
  'el consecutivo avanza',
  `${factura.consecutivo} → ${factura2.consecutivo}`,
);

console.log('\n── 4 · El resumen de cartera cuadra ──');

const listado = await api('/api/admin/invoices');
const sumaSaldos = listado.body.invoices.reduce((t, f) => t + f.saldo, 0);
ok(
  listado.body.resumen.porCobrar === sumaSaldos,
  'el resumen "por cobrar" coincide con la suma de saldos',
  `${listado.body.resumen.porCobrar} vs ${sumaSaldos}`,
);

console.log('\n── 5 · Anular ──');

const sinMotivo = await api(`/api/admin/invoices/${factura2.id}/anular`, {
  method: 'POST',
  body: JSON.stringify({}),
});
ok(sinMotivo.status === 400, 'anular sin motivo se rechaza', `status ${sinMotivo.status}`);

const anulada = await api(`/api/admin/invoices/${factura2.id}/anular`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'Prueba de QA' }),
});
ok(anulada.status === 200, 'anular con motivo funciona', `status ${anulada.status}`);
ok(anulada.body?.invoice?.estado === 'anulada', "queda en estado 'anulada'");
ok(anulada.body?.invoice?.saldo === 0, 'una anulada no debe nada');

const reanular = await api(`/api/admin/invoices/${factura2.id}/anular`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'Otra vez' }),
});
ok(reanular.status === 409, 'no se puede anular dos veces', `status ${reanular.status}`);

console.log('\n── 6 · Cobrar el pedido salda la factura ──');

// Contra entrega: aprobar → despachar → cobrar en la puerta. Es el camino que
// la 0028 reemplazará por abonos; hoy tiene que dejar la factura en 'pagada' o
// la cartera diría que este cliente debe algo que ya pagó.
const pedidoCOD = await crearPedido('QA Contra entrega', 'contraentrega');
await api(`/api/admin/orders/${pedidoCOD.id}/aprobar`, { method: 'POST' });

const facturaCOD = await facturaDe(pedidoCOD.id);
ok(facturaCOD?.saldo === facturaCOD?.total, 'antes de cobrar, la factura debe todo');

await api(`/api/admin/orders/${pedidoCOD.id}/enviar`, { method: 'POST' });
const cobro = await api(`/api/admin/orders/${pedidoCOD.id}/pagar`, { method: 'POST' });
ok(cobro.status === 200, 'el cobro contra entrega funciona', `status ${cobro.status}`);

const facturaCobrada = await facturaDe(pedidoCOD.id);
ok(facturaCobrada?.estado === 'pagada', "la factura queda 'pagada'", `estado ${facturaCobrada?.estado}`);
ok(facturaCobrada?.saldo === 0, 'la factura queda en saldo 0', `saldo ${facturaCobrada?.saldo}`);

// Anular algo ya cobrado pondría el saldo en 0 dando la deuda por buena, pero
// el dinero recibido seguiría en la caja sin venta detrás. Eso se deshace con
// una nota crédito, no borrando el documento.
const anularPagada = await api(`/api/admin/invoices/${facturaCobrada.id}/anular`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'No debería dejarme' }),
});
ok(
  anularPagada.status === 409,
  'una factura ya cobrada NO se puede anular',
  `status ${anularPagada.status}`,
);
ok(
  anularPagada.body?.error?.code === 'factura-con-pagos',
  'y lo explica con un código propio',
  anularPagada.body?.error?.code,
);

console.log('\n── 7 · Crear a mano (venta de mostrador) ──');

const nueva = await api('/api/admin/invoices', {
  method: 'POST',
  body: JSON.stringify({
    clienteNombre: 'Mostrador QA',
    clienteTelefono: '3009998877',
    envio: 3000,
    items: [
      { descripcion: 'Tomate chonto', cantidad: 3, precioUnitario: 4000 },
      { descripcion: 'Empaque especial', cantidad: 1, precioUnitario: 1500 },
    ],
  }),
});
ok(nueva.status === 201, 'se crea una factura sin pedido detrás', `status ${nueva.status}`);
ok(nueva.body?.invoice?.orderId === null, 'no queda atada a ningún pedido');
ok(
  nueva.body?.invoice?.subtotal === 13500,
  'el subtotal lo suma el servidor (3×4000 + 1×1500)',
  `${nueva.body?.invoice?.subtotal}`,
);
ok(
  nueva.body?.invoice?.total === 16500,
  'el total incluye el domicilio',
  `${nueva.body?.invoice?.total}`,
);
ok(nueva.body?.invoice?.saldo === 16500, 'nace debiendo todo');

const sinLineas = await api('/api/admin/invoices', {
  method: 'POST',
  body: JSON.stringify({ clienteNombre: 'Vacía', items: [] }),
});
ok(sinLineas.status === 400, 'una factura sin líneas se rechaza', `status ${sinLineas.status}`);

// El importe lo calcula el servidor: mandarlo desde fuera no debe colar.
const importeFalso = await api('/api/admin/invoices', {
  method: 'POST',
  body: JSON.stringify({
    clienteNombre: 'Tramposo QA',
    items: [{ descripcion: 'Oro', cantidad: 10, precioUnitario: 5000, importe: 50 }],
  }),
});
ok(
  importeFalso.body?.invoice?.total === 50000,
  'un importe mandado desde el cliente se ignora',
  `total ${importeFalso.body?.invoice?.total}`,
);

console.log('\n── 8 · Editar ──');

const editada = await api(`/api/admin/invoices/${nueva.body.invoice.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    clienteNombre: 'Mostrador QA corregido',
    envio: 0,
    items: [{ descripcion: 'Tomate chonto', cantidad: 2, precioUnitario: 4000 }],
  }),
});
ok(editada.status === 200, 'se puede editar mientras no tenga cobros', `status ${editada.status}`);
ok(editada.body?.invoice?.total === 8000, 'el total se recalcula', `${editada.body?.invoice?.total}`);
ok(editada.body?.invoice?.saldo === 8000, 'el saldo sigue al total');
ok(
  editada.body?.invoice?.numero === nueva.body.invoice.numero,
  'el número NO cambia al editar: es la identidad del documento',
);

const detalle = await api(`/api/admin/invoices/${nueva.body.invoice.id}`);
ok(detalle.body?.items?.length === 1, 'las líneas se reemplazaron enteras', `${detalle.body?.items?.length}`);

// La barrera se comprueba con un GESTOR_PEDIDOS, no con el admin: desde la
// migración 0030 el administrador la salta a propósito, así que probarla con
// una cuenta de admin no probaría nada.
const CORREO_GESTOR = `gestor.fac.${Date.now()}@agricultores.co`;
await api('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: CORREO_GESTOR,
    nombre: 'Gestor QA',
    password: 'demo1234',
    roles: ['GESTOR_PEDIDOS'],
  }),
});
const loginGestor = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: CORREO_GESTOR, password: 'demo1234' }),
});
const tokenGestor = loginGestor.body.token;

const cuerpoEdicion = JSON.stringify({
  clienteNombre: 'No debería',
  items: [{ descripcion: 'X', cantidad: 1, precioUnitario: 1 }],
});

const editarComoGestor = await fetch(`${BASE}/api/admin/invoices/${facturaCobrada.id}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenGestor}` },
  body: cuerpoEdicion,
});
ok(
  editarComoGestor.status === 409,
  'para quien cobra a diario, una factura pagada NO se edita',
  `status ${editarComoGestor.status}`,
);

const editarComoAdmin = await api(`/api/admin/invoices/${facturaCobrada.id}`, {
  method: 'PUT',
  body: cuerpoEdicion,
});
ok(
  editarComoAdmin.status === 200,
  'el administrador sí puede, que es lo que se pidió',
  `status ${editarComoAdmin.status}`,
);
ok(editarComoAdmin.body?.forzadoPorAdmin === true, 'y la respuesta lo deja dicho');

console.log('\n── 9 · Borrar ──');

const borrarCobrada = await api(`/api/admin/invoices/${facturaCobrada.id}`, { method: 'DELETE' });
ok(
  borrarCobrada.status === 409,
  'una factura ya cobrada NO se puede borrar',
  `status ${borrarCobrada.status}`,
);

const borrada = await api(`/api/admin/invoices/${nueva.body.invoice.id}`, { method: 'DELETE' });
ok(borrada.status === 200, 'se borra la que no tiene cobros', `status ${borrada.status}`);

const yaNoEsta = await api(`/api/admin/invoices/${nueva.body.invoice.id}`);
ok(yaNoEsta.status === 404, 'después de borrar ya no existe', `status ${yaNoEsta.status}`);

// Las líneas se van con ella por el CASCADE.
const huerfanas = await api(`/api/admin/invoices`);
ok(
  !huerfanas.body.invoices.some((f) => f.id === nueva.body.invoice.id),
  'tampoco aparece en el listado',
);

console.log(`\n${fallos === 0 ? 'TODO EN VERDE' : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
