/**
 * QA de abonos parciales (migración 0036).
 *
 * Lo que se comprueba, en las dos direcciones que mueve plata Tesorería:
 *
 *   1. A un cliente se le puede abonar una parte de UNA factura concreta, y
 *      el abono cae en esa factura y no en la más vieja.
 *   2. El método decide la cuenta: efectivo toca el cajón, transferencia el
 *      banco. Es lo que hace que el arqueo del turno cuadre.
 *   3. A una finca se le puede girar una parte, la compra sigue 'pendiente' y
 *      el saldo baja solo lo abonado.
 *   4. Dos abonos que suman el total la dejan 'pagado'.
 *   5. No se puede abonar más de lo que se debe, ni por cobrar ni por pagar.
 *   6. Una compra con abonos no se puede borrar: sería borrar el rastro de
 *      plata que ya salió de una cuenta.
 *   7. Cada abono aparece como SU PROPIA fila en el libro de movimientos.
 *
 *   node worker/tests/qa-abonos.mjs [http://localhost:8788]
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
      'cf-connecting-ip': '198.51.100.77',
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

const saldos = async () => {
  const { body } = await api('/api/admin/tesoreria/cuentas');
  const mapa = {};
  for (const c of body?.cuentas ?? []) mapa[c.id] = c.saldo;
  return mapa;
};

console.log(`\nQA Abonos parciales · ${BASE}\n`);

{
  const r = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) {
    console.error('No se pudo entrar:', r.status, JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  token = r.body.token;
}

// ─────────────────── 1. Abonar a una factura de cliente ────────────────────

seccion('1. Abono parcial a un cliente');

const cedula = `9${Math.floor(Math.random() * 1_000_000_000)}`;
const { body: creado } = await post('/api/admin/contacts', {
  nombre: 'QA Abonos Cliente',
  documento: cedula,
  telefono: `30${Math.floor(Math.random() * 100_000_000)}`,
  esCliente: true,
  cupoCredito: 500_000,
});
const contactId = creado?.contacto?.id;
ok(!!contactId, 'se crea el cliente de prueba', `id ${contactId}`);

const { body: catalogo } = await api('/api/admin/products?limit=500');
const algo = (catalogo?.products ?? []).find(
  (p) => (p.stock ?? 0) > 5 && !p.tieneVariantes && !p.esCanasta,
);
if (!algo) {
  console.error('No hay producto con stock. Corre npm run db:reset.');
  process.exit(1);
}

// Una venta a crédito deja una factura con saldo, que es lo que se va a abonar.
const venta = await post('/api/admin/pos/sell', {
  contactId,
  items: [{ productId: algo.id, cantidad: 2 }],
  metodoPago: 'credito',
});
ok(venta.status === 201, 'se registra una venta a crédito', `status ${venta.status}`);

const facturaId = venta.body?.venta?.factura?.id;
const totalFactura = venta.body?.venta?.factura?.saldo ?? 0;
ok(!!facturaId && totalFactura > 0, 'y deja una factura con saldo', `total ${totalFactura}`);

const cajaAntes = (await saldos())['caja-efectivo'];

// El abono: la mitad, en efectivo, dirigido a ESA factura.
const mitad = Math.floor(totalFactura / 2);
const abono = await post('/api/admin/payments', {
  contactId,
  monto: mitad,
  metodo: 'efectivo',
  nota: 'QA abono parcial',
  allocations: [{ invoiceId: facturaId, monto: mitad }],
});
ok(abono.status === 201, 'se registra el abono parcial', `status ${abono.status}`);

const { body: facturas } = await api('/api/admin/invoices');
const factura = (facturas?.invoices ?? []).find((f) => f.id === facturaId);
ok(
  factura && factura.saldo === totalFactura - mitad,
  'la factura baja SOLO lo abonado, no queda saldada',
  `saldo ${factura?.saldo} de ${totalFactura}`,
);

const cajaDespues = (await saldos())['caja-efectivo'];
ok(
  cajaDespues === cajaAntes + mitad,
  'y el abono en efectivo entra a la CAJA',
  `${cajaAntes} → ${cajaDespues}`,
);

// ─────────────────── 2. El método decide la cuenta ─────────────────────────

seccion('2. El método decide a qué cuenta entra');

const bancoAntes = (await saldos())['cuenta-bancaria'];
const resto = totalFactura - mitad;
const porBanco = await post('/api/admin/payments', {
  contactId,
  monto: resto,
  metodo: 'transferencia',
  nota: 'QA saldo por transferencia',
  allocations: [{ invoiceId: facturaId, monto: resto }],
});
ok(porBanco.status === 201, 'se registra el resto por transferencia', `status ${porBanco.status}`);

const trasBanco = await saldos();
ok(
  trasBanco['cuenta-bancaria'] === bancoAntes + resto,
  'una transferencia entra al BANCO, no a la caja',
  `${bancoAntes} → ${trasBanco['cuenta-bancaria']}`,
);
ok(
  trasBanco['caja-efectivo'] === cajaDespues,
  'y la caja no se mueve',
  `${cajaDespues} → ${trasBanco['caja-efectivo']}`,
);

const { body: facturas2 } = await api('/api/admin/invoices');
const saldada = (facturas2?.invoices ?? []).find((f) => f.id === facturaId);
ok(saldada?.saldo === 0, 'los dos abonos juntos dejan la factura al día', `saldo ${saldada?.saldo}`);

// ─────────────────── 3. Abonar a una finca ─────────────────────────────────

seccion('3. Abono parcial a una finca');

// Nombre único por corrida: el libro de movimientos se filtra por el nombre de
// la finca, y con un nombre fijo la segunda corrida sobre la misma base veía
// también los abonos de la primera y contaba cuatro filas donde espera dos.
const NOMBRE_FINCA = `QA Abonos Finca ${Date.now().toString().slice(-6)}`;

const { body: proveedor } = await post('/api/admin/contacts', {
  nombre: NOMBRE_FINCA,
  documento: `8${Math.floor(Math.random() * 1_000_000_000)}`,
  telefono: `31${Math.floor(Math.random() * 100_000_000)}`,
  esProveedor: true,
});

const compra = await post('/api/admin/providers/purchases', {
  contactId: proveedor?.contacto?.id,
  items: [{ productId: algo.id, cantidad: 10, costoUnitario: 3000 }],
});
ok(compra.status === 201, 'se registra la compra a la finca', `status ${compra.status}`);

const compraId = compra.body?.compra?.id;
const totalCompra = compra.body?.compra?.totalPago ?? 0;
ok(totalCompra === 30_000, 'por el total esperado', `total ${totalCompra}`);
ok(compra.body?.compra?.saldo === 30_000, 'y nace debiéndose entera', `saldo ${compra.body?.compra?.saldo}`);

const antesDelGiro = await saldos();

// Se le abona en efectivo lo que hay hoy en el cajón.
const giro1 = await post(`/api/admin/providers/purchases/${compraId}/pagar`, {
  monto: 12_000,
  metodo: 'efectivo',
});
ok(giro1.status === 200, 'se registra el primer abono a la finca', `status ${giro1.status}`);
ok(
  giro1.body?.compra?.estado === 'pendiente',
  'la compra sigue PENDIENTE: todavía se le debe',
  `estado ${giro1.body?.compra?.estado}`,
);
ok(
  giro1.body?.compra?.montoPagado === 12_000 && giro1.body?.compra?.saldo === 18_000,
  'y el saldo baja solo lo abonado',
  `girado ${giro1.body?.compra?.montoPagado}, falta ${giro1.body?.compra?.saldo}`,
);

const trasGiro1 = await saldos();
ok(
  trasGiro1['caja-efectivo'] === antesDelGiro['caja-efectivo'] - 12_000,
  'el abono en efectivo sale de la CAJA',
  `${antesDelGiro['caja-efectivo']} → ${trasGiro1['caja-efectivo']}`,
);
ok(
  trasGiro1['cuenta-bancaria'] === antesDelGiro['cuenta-bancaria'],
  'y no toca el banco',
);

// ─────────────────── 4. No se puede borrar con abonos ──────────────────────

seccion('4. Una compra con abonos no se borra');

const borrado = await api(`/api/admin/providers/purchases/${compraId}`, { method: 'DELETE' });
ok(
  borrado.status === 409,
  'borrar una compra a medio girar se rechaza',
  `status ${borrado.status}`,
);

// ─────────────────── 5. Topes ──────────────────────────────────────────────

seccion('5. No se abona más de lo que se debe');

const deMas = await post(`/api/admin/providers/purchases/${compraId}/pagar`, {
  monto: 100_000,
  metodo: 'transferencia',
});
ok(deMas.status === 400, 'un abono mayor al saldo se rechaza', `status ${deMas.status}`);

const sinTocar = await saldos();
ok(
  sinTocar['cuenta-bancaria'] === trasGiro1['cuenta-bancaria'],
  'y el rechazo no movió ninguna cuenta',
  `${trasGiro1['cuenta-bancaria']} → ${sinTocar['cuenta-bancaria']}`,
);

const cobroDeMas = await post('/api/admin/payments', {
  contactId,
  monto: 999_999,
  metodo: 'efectivo',
  allocations: [{ invoiceId: facturaId, monto: 999_999 }],
});
ok(
  cobroDeMas.status >= 400,
  'cobrarle a un cliente más de lo que debe se rechaza',
  `status ${cobroDeMas.status}`,
);

// ─────────────────── 6. El segundo abono la salda ──────────────────────────

seccion('6. Los abonos que suman el total la dejan pagada');

const giro2 = await post(`/api/admin/providers/purchases/${compraId}/pagar`, {
  monto: 18_000,
  metodo: 'transferencia',
});
ok(giro2.status === 200, 'se registra el segundo abono', `status ${giro2.status}`);
ok(
  giro2.body?.compra?.estado === 'pagado' && giro2.body?.compra?.saldo === 0,
  'y la compra queda PAGADA',
  `estado ${giro2.body?.compra?.estado}, saldo ${giro2.body?.compra?.saldo}`,
);

const trasGiro2 = await saldos();
ok(
  trasGiro2['cuenta-bancaria'] === trasGiro1['cuenta-bancaria'] - 18_000,
  'el segundo abono sale del BANCO, porque fue por transferencia',
  `${trasGiro1['cuenta-bancaria']} → ${trasGiro2['cuenta-bancaria']}`,
);

const yaPagada = await post(`/api/admin/providers/purchases/${compraId}/pagar`, { monto: 1000 });
ok(yaPagada.status === 409, 'girar de nuevo una compra saldada se rechaza', `status ${yaPagada.status}`);

// ─────────────────── 7. Cada abono, su propia fila ─────────────────────────

seccion('7. El libro de movimientos ve los dos abonos por separado');

const { body: libro } = await api('/api/admin/tesoreria/movimientos?tipo=pago_proveedor');
const mios = (libro?.movimientos ?? []).filter((m) => m.tercero === NOMBRE_FINCA);
ok(mios.length === 2, 'los dos abonos aparecen como dos filas', `${mios.length} fila(s)`);
ok(
  mios.some((m) => m.cuentaId === 'caja-efectivo' && m.sale === 12_000),
  'uno sale de la caja por 12.000',
);
ok(
  mios.some((m) => m.cuentaId === 'cuenta-bancaria' && m.sale === 18_000),
  'y el otro del banco por 18.000',
);

// ─────────────────── 8. Sin monto se gira todo ─────────────────────────────

seccion('8. Sin monto se gira todo lo que falta (el botón de Compras)');

const compra2 = await post('/api/admin/providers/purchases', {
  contactId: proveedor?.contacto?.id,
  items: [{ productId: algo.id, cantidad: 5, costoUnitario: 2000 }],
});
const compra2Id = compra2.body?.compra?.id;

const completo = await post(`/api/admin/providers/purchases/${compra2Id}/pagar`, {});
ok(
  completo.body?.compra?.estado === 'pagado' && completo.body?.compra?.saldo === 0,
  'un cuerpo vacío sigue girando la compra entera',
  `estado ${completo.body?.compra?.estado}, saldo ${completo.body?.compra?.saldo}`,
);

console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} FALLO(S)\n`);
process.exit(fallos === 0 ? 0 : 1);
