/**
 * QA de devoluciones (migración 0037).
 *
 * Nace de un caso real: una nota crédito emitida contra una factura ya
 * pagada por completo. `invoices.saldo` está capado en 0, así que esa plata
 * de más no aparecía en ningún lado. Lo que se comprueba aquí:
 *
 *   1. Una nota crédito contra una factura pagada por completo SÍ aparece
 *      en «por devolver», con el saldo pendiente correcto.
 *   2. Se puede devolver en varias partes — hoy efectivo, después banco —
 *      y cada abono sale de la cuenta que le toca según el método.
 *   3. La devolución queda TRAZADA a la nota concreta (y por la nota, a la
 *      factura): dos notas sobre la misma factura se devuelven cada una por
 *      su lado, sin mezclarse.
 *   4. No se devuelve más de lo que la nota admite.
 *   5. Cuando se devuelve todo, la nota sale de «por devolver» y el resumen
 *      de Tesorería dice `porDevolver.total = 0`.
 *   6. Cada devolución aparece como SU PROPIA fila en el libro de
 *      movimientos, con la referencia de la nota.
 *
 *   node worker/tests/qa-devoluciones.mjs [base] [email] [password]
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
      'cf-connecting-ip': '198.51.100.88',
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

console.log(`\nQA Devoluciones · ${BASE}\n`);

{
  const r = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) {
    console.error('No se pudo entrar:', r.status, JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  token = r.body.token;
}

// ─────────────── 1. Nota crédito contra una factura ya pagada ──────────────

seccion('1. Nota crédito sobre una factura pagada por completo');

const NOMBRE_CLIENTE = `QA Devoluciones ${Date.now().toString().slice(-6)}`;
const { body: creado } = await post('/api/admin/contacts', {
  nombre: NOMBRE_CLIENTE,
  documento: `9${Math.floor(Math.random() * 1_000_000_000)}`,
  telefono: `30${Math.floor(Math.random() * 100_000_000)}`,
  esCliente: true,
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

// Venta de mostrador pagada de una: efectivo, sin crédito de por medio.
const venta = await post('/api/admin/pos/sell', {
  contactId,
  items: [{ productId: algo.id, cantidad: 3 }],
  metodoPago: 'efectivo',
});
ok(venta.status === 201, 'se registra la venta, pagada al instante', `status ${venta.status}`);

const facturaId = venta.body?.venta?.factura?.id;
const facturaNumero = venta.body?.venta?.factura?.numero;
const totalFactura = venta.body?.venta?.total ?? 0;
ok(!!facturaId && venta.body?.venta?.factura?.saldo === 0, 'y la factura nace SIN saldo (ya pagada)');

// Dos notas crédito sobre la MISMA factura — el caso real que originó esto.
const nc1 = await post(`/api/admin/invoices/${facturaId}/nota`, {
  motivo: 'QA: descuento acordado después del pago',
  items: [{ descripcion: 'Ajuste', cantidad: 1, precioUnitario: 400 }],
});
ok(nc1.status === 201, 'se emite la primera nota crédito', `status ${nc1.status}`);

const restoAcreditable = totalFactura - 400;
const nc2 = await post(`/api/admin/invoices/${facturaId}/nota`, {
  motivo: 'QA: devolución de parte de la mercancía',
  items: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: restoAcreditable }],
});
ok(nc2.status === 201, 'y una segunda, sobre la misma factura', `status ${nc2.status}`);

const nota1Id = nc1.body?.nota?.id;
const nota1Numero = nc1.body?.nota?.numero;
const nota2Id = nc2.body?.nota?.id;
const nota2Numero = nc2.body?.nota?.numero;

ok(
  venta.body?.venta?.factura?.numero === facturaNumero,
  'las dos notas corrigen la misma factura, ya identificada',
);

// ─────────────── 2. Aparece en «por devolver» ───────────────────────────────

seccion('2. Aparece en la lista de devoluciones pendientes');

const { body: pendientes1 } = await api('/api/admin/tesoreria/devoluciones');
const fila1 = pendientes1?.devoluciones?.find((n) => n.id === nota1Id);
const fila2 = pendientes1?.devoluciones?.find((n) => n.id === nota2Id);

ok(!!fila1 && !!fila2, 'las DOS notas aparecen, cada una su propia fila', `${!!fila1} / ${!!fila2}`);
ok(fila1?.saldo === 400, 'con el saldo pendiente correcto de la primera', `saldo ${fila1?.saldo}`);
ok(
  fila1?.facturaNumero === facturaNumero && fila2?.facturaNumero === facturaNumero,
  'y cada una trazada a la factura de origen',
  `${fila1?.facturaNumero} / ${fila2?.facturaNumero} vs ${facturaNumero}`,
);

const { body: resumenAntes } = await api('/api/admin/tesoreria/resumen');
ok(
  resumenAntes?.porDevolver?.total === 400 + restoAcreditable,
  'el resumen de Tesorería suma las dos en «por devolver»',
  `total ${resumenAntes?.porDevolver?.total}`,
);
ok(resumenAntes?.porDevolver?.notas === 2, 'contando dos notas', `notas ${resumenAntes?.porDevolver?.notas}`);

// ─────────────── 3. Devolver en varias partes ───────────────────────────────

seccion('3. Se devuelve la primera nota en dos partes');

const cajaAntes = (await saldos())['caja-efectivo'];
const mitad1 = Math.floor(400 / 2);

const dev1 = await post(`/api/admin/tesoreria/devoluciones/${nota1Id}`, {
  monto: mitad1,
  metodo: 'efectivo',
});
ok(dev1.status === 200, 'se registra el primer abono de la devolución', `status ${dev1.status}`);
ok(
  dev1.body?.nota?.montoDevuelto === mitad1 && dev1.body?.nota?.saldo === 400 - mitad1,
  'la nota queda a medio devolver',
  `devuelto ${dev1.body?.nota?.montoDevuelto}, falta ${dev1.body?.nota?.saldo}`,
);

const cajaDespues1 = (await saldos())['caja-efectivo'];
ok(
  cajaDespues1 === cajaAntes - mitad1,
  'el abono en efectivo SALE de la caja',
  `${cajaAntes} → ${cajaDespues1}`,
);

const bancoAntes = (await saldos())['cuenta-bancaria'];
const resto1 = 400 - mitad1;
const dev2 = await post(`/api/admin/tesoreria/devoluciones/${nota1Id}`, {
  monto: resto1,
  metodo: 'transferencia',
});
ok(dev2.status === 200, 'se registra el resto por transferencia', `status ${dev2.status}`);
ok(
  dev2.body?.nota?.saldo === 0,
  'y la nota queda devuelta por completo',
  `saldo ${dev2.body?.nota?.saldo}`,
);

const bancoDespues = (await saldos())['cuenta-bancaria'];
ok(
  bancoDespues === bancoAntes - resto1,
  'el segundo abono sale del BANCO, no de la caja',
  `${bancoAntes} → ${bancoDespues}`,
);

// ─────────────── 4. Topes ───────────────────────────────────────────────────

seccion('4. No se devuelve más de lo que la nota admite');

const deMas = await post(`/api/admin/tesoreria/devoluciones/${nota2Id}`, {
  monto: restoAcreditable + 10_000,
  metodo: 'efectivo',
});
ok(deMas.status === 400, 'un abono mayor al saldo se rechaza', `status ${deMas.status}`);

const yaDevuelta = await post(`/api/admin/tesoreria/devoluciones/${nota1Id}`, { monto: 100 });
ok(
  yaDevuelta.status === 409,
  'devolver de nuevo una nota ya saldada se rechaza',
  `status ${yaDevuelta.status}`,
);

// ─────────────── 5. Sin monto se devuelve todo ──────────────────────────────

seccion('5. Sin monto se devuelve todo lo que falta');

const completa = await post(`/api/admin/tesoreria/devoluciones/${nota2Id}`, {});
ok(
  completa.body?.nota?.saldo === 0 && completa.body?.nota?.montoDevuelto === restoAcreditable,
  'un cuerpo vacío devuelve la nota entera',
  `devuelto ${completa.body?.nota?.montoDevuelto}, saldo ${completa.body?.nota?.saldo}`,
);

const { body: pendientes2 } = await api('/api/admin/tesoreria/devoluciones');
ok(
  !pendientes2?.devoluciones?.some((n) => n.id === nota1Id || n.id === nota2Id),
  'las dos notas ya devueltas salen de la lista de pendientes',
);

const { body: resumenDespues } = await api('/api/admin/tesoreria/resumen');
ok(
  resumenDespues?.porDevolver?.total === 0,
  'y el resumen queda en «por devolver: 0»',
  `total ${resumenDespues?.porDevolver?.total}`,
);

// ─────────────── 6. Trazabilidad en el libro de movimientos ────────────────

seccion('6. El libro de movimientos ve cada devolución por separado');

const { body: libro } = await api('/api/admin/tesoreria/movimientos?tipo=devolucion');
const mias = (libro?.movimientos ?? []).filter((m) => m.tercero === NOMBRE_CLIENTE);

ok(mias.length === 3, 'las tres devoluciones aparecen, una por fila', `${mias.length} fila(s)`);
ok(
  mias.some((m) => m.referencia === nota1Numero) && mias.some((m) => m.referencia === nota2Numero),
  'cada fila trae la referencia de SU nota, no un texto genérico',
  `referencias: ${mias.map((m) => m.referencia).join(', ')}`,
);
// dev1 (mitad1) y «completa» (sin método, por defecto efectivo) van a la
// caja; solo dev2 fue explícitamente por transferencia.
ok(
  mias.filter((m) => m.cuentaId === 'caja-efectivo').length === 2 &&
    mias.filter((m) => m.cuentaId === 'cuenta-bancaria').length === 1,
  'y cada una en la cuenta que le tocó según el método',
  `caja ${mias.filter((m) => m.cuentaId === 'caja-efectivo').length}, banco ${mias.filter((m) => m.cuentaId === 'cuenta-bancaria').length}`,
);

console.log(fallos === 0 ? '\nTODO OK\n' : `\n${fallos} FALLO(S)\n`);
process.exit(fallos === 0 ? 0 : 1);
