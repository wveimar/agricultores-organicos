/**
 * QA integral: ¿los números cuadran de punta a punta?
 *
 * No prueba seguridad ni permisos — para eso están qa-seguridad y
 * qa-fuerza-bruta. Esta suite persigue UNA sola pregunta: cuando la
 * mercancía entra, se vende, se devuelve y se cobra, ¿el inventario, la
 * cartera y la caja terminan diciendo lo mismo?
 *
 * Cada bloque mide ANTES y DESPUÉS y compara la diferencia exacta. Un total
 * que "se ve bien" no sirve: si el stock baja 4 cuando se vendieron 3, la
 * cifra sigue pareciendo razonable y el negocio pierde una unidad cada venta.
 *
 *   node worker/tests/qa-integral.mjs [base] [email] [password]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';
const EMAIL = process.argv[3] ?? 'admin@agricultores.co';
const PASSWORD = process.argv[4] ?? 'demo1234';

let fallos = 0;
const problemas = [];

const ok = (condicion, titulo, detalle = '') => {
  if (condicion) {
    console.log(`  OK   ${titulo}`);
  } else {
    fallos++;
    problemas.push(`${titulo}${detalle ? ` — ${detalle}` : ''}`);
    console.log(`  FALLA ${titulo}${detalle ? ` — ${detalle}` : ''}`);
  }
};
const seccion = (t) => console.log(`\n${t}`);
const cop = (n) => `$${(n ?? 0).toLocaleString('es-CO')}`;

let token = '';
const api = async (ruta, opciones = {}) => {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '198.51.100.42',
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

/** El stock de un producto, ahora mismo. */
const stockDe = async (productId) => {
  const { body } = await api('/api/admin/products?limit=500');
  return (body?.products ?? []).find((p) => p.id === productId)?.stock ?? null;
};

const saldos = async () => {
  const { body } = await api('/api/admin/tesoreria/cuentas');
  const mapa = {};
  for (const c of body?.cuentas ?? []) mapa[c.id] = c.saldo;
  return mapa;
};

const facturaDe = async (invoiceId) => {
  const { body } = await api('/api/admin/invoices');
  return (body?.invoices ?? []).find((f) => f.id === invoiceId) ?? null;
};

const nuevoContacto = async (nombre, extra = {}) => {
  const { body } = await post('/api/admin/contacts', {
    nombre,
    documento: `9${Math.floor(Math.random() * 1_000_000_000)}`,
    telefono: `30${Math.floor(Math.random() * 100_000_000)}`,
    ...extra,
  });
  return body?.contacto;
};

console.log(`\nQA Integral · ${BASE}\n`);

{
  const r = await post('/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (r.status !== 200) {
    console.error('No se pudo entrar:', r.status, JSON.stringify(r.body).slice(0, 200));
    process.exit(1);
  }
  token = r.body.token;
}

// Un producto sencillo para toda la prueba: sin variantes, sin canasta, con
// stock. Todo lo que sigue mide sobre ESTE producto.
const { body: catalogo } = await api('/api/admin/products?limit=500');
const prod = (catalogo?.products ?? []).find(
  (p) => (p.stock ?? 0) > 10 && !p.tieneVariantes && !p.esCanasta && p.precio > 1000,
);
if (!prod) {
  console.error('No hay un producto con stock > 10 para probar. Corre npm run db:reset.');
  process.exit(1);
}
console.log(`Producto de prueba: ${prod.nombre} · stock inicial ${prod.stock} · precio ${cop(prod.precio)}\n`);

// ═══════════════ 1. ENTRADA DE MERCANCÍA (COMPRAS) ═══════════════

seccion('1. Entrada de mercancía — la compra a la finca sube el inventario');

const finca = await nuevoContacto('QA Finca Integral', { esProveedor: true });
const stockAntesCompra = await stockDe(prod.id);

const compra = await post('/api/admin/providers/purchases', {
  contactId: finca.id,
  items: [{ productId: prod.id, cantidad: 20, costoUnitario: 1500 }],
});
ok(compra.status === 201, 'se registra la compra de 20 unidades', `status ${compra.status}`);

const stockTrasCompra = await stockDe(prod.id);
ok(
  stockTrasCompra === stockAntesCompra + 20,
  'el inventario sube EXACTAMENTE 20 unidades',
  `${stockAntesCompra} → ${stockTrasCompra}`,
);

const { body: catTrasCompra } = await api('/api/admin/products?limit=500');
const prodTrasCompra = catTrasCompra.products.find((p) => p.id === prod.id);
ok(
  prodTrasCompra?.precioCosto === 1500,
  'y el costo del producto queda en lo que se le pagó a la finca',
  `costo ${prodTrasCompra?.precioCosto}`,
);

// La compra queda como deuda con la finca hasta que se gire.
const { body: porPagar } = await api('/api/admin/tesoreria/resumen');
ok(
  (porPagar?.porPagar?.total ?? 0) >= 30_000,
  'la compra aparece como deuda con la finca (20 × $1.500)',
  `por pagar ${cop(porPagar?.porPagar?.total)}`,
);

// ═══════════════ 2. VENTA EN POS DESCUENTA INVENTARIO ═══════════════

seccion('2. Venta en caja (POS) — descuenta del inventario y entra la plata');

const stockAntesPos = await stockDe(prod.id);
const cajaAntesPos = (await saldos())['caja-efectivo'];

const ventaPos = await post('/api/admin/pos/sell', {
  items: [{ productId: prod.id, cantidad: 3 }],
  metodoPago: 'efectivo',
});
ok(ventaPos.status === 201, 'se registra la venta de 3 unidades en caja', `status ${ventaPos.status}`);

const totalPos = ventaPos.body?.venta?.total ?? 0;
const stockTrasPos = await stockDe(prod.id);
ok(
  stockTrasPos === stockAntesPos - 3,
  'el inventario baja EXACTAMENTE 3 unidades',
  `${stockAntesPos} → ${stockTrasPos}`,
);

const cajaTrasPos = (await saldos())['caja-efectivo'];
ok(
  cajaTrasPos === cajaAntesPos + totalPos,
  'la caja sube exactamente lo que se cobró',
  `${cop(cajaAntesPos)} → ${cop(cajaTrasPos)} (venta ${cop(totalPos)})`,
);

ok(
  ventaPos.body?.venta?.factura?.id && ventaPos.body?.venta?.factura?.saldo === 0,
  'y la venta deja factura emitida, sin saldo pendiente',
  `saldo ${ventaPos.body?.venta?.factura?.saldo}`,
);

// ═══════════════ 3. VENTA EN LA TIENDA WEB DESCUENTA INVENTARIO ═══════════════

seccion('3. Venta en la tienda web — reserva el inventario al comprar');

const stockAntesWeb = await stockDe(prod.id);

const pedidoWeb = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA Cliente Web',
    clienteTelefono: '3001234567',
    clienteDireccion: 'Calle QA # 10-20',
    clienteCedula: `9${Math.floor(Math.random() * 1_000_000_000)}`,
    items: [{ productId: prod.id, cantidad: 2 }],
    metodoPago: 'transferencia',
  }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

ok(pedidoWeb.status === 201, 'se registra el pedido web de 2 unidades', `status ${pedidoWeb.status}`);

const stockTrasWeb = await stockDe(prod.id);
ok(
  stockTrasWeb === stockAntesWeb - 2,
  'el inventario baja EXACTAMENTE 2 al momento de comprar (reserva)',
  `${stockAntesWeb} → ${stockTrasWeb}`,
);

const pedidoWebId = pedidoWeb.body?.order?.id;
const aprobar = await post(`/api/admin/orders/${pedidoWebId}/aprobar`);
ok(aprobar.status === 200, 'el pedido se aprueba desde el panel', `status ${aprobar.status}`);

const stockTrasAprobar = await stockDe(prod.id);
ok(
  stockTrasAprobar === stockTrasWeb,
  'aprobarlo NO vuelve a descontar (no hay doble descuento)',
  `${stockTrasWeb} → ${stockTrasAprobar}`,
);

// ═══════════════ 4. FACTURA + DEVOLUCIÓN DE UN PRODUCTO ═══════════════

seccion('4. Factura y devolución — la nota crédito baja la factura y devuelve el producto');

const clienteDev = await nuevoContacto('QA Cliente Devolución', { esCliente: true });
const stockAntesVentaDev = await stockDe(prod.id);

// Venta de 5 unidades para después devolver 2.
const ventaParaDevolver = await post('/api/admin/pos/sell', {
  contactId: clienteDev.id,
  items: [{ productId: prod.id, cantidad: 5 }],
  metodoPago: 'efectivo',
});
const facturaDev = ventaParaDevolver.body?.venta?.factura;
const pedidoDevId = ventaParaDevolver.body?.venta?.id;
const totalVentaDev = ventaParaDevolver.body?.venta?.total ?? 0;

ok(ventaParaDevolver.status === 201, 'se vende 5 unidades a un cliente', `status ${ventaParaDevolver.status}`);

const stockTrasVentaDev = await stockDe(prod.id);
ok(stockTrasVentaDev === stockAntesVentaDev - 5, 'el inventario baja 5', `${stockAntesVentaDev} → ${stockTrasVentaDev}`);

// Devolución de 2 de las 5 unidades, por el camino del POS (nota crédito +
// stock de vuelta en la misma operación).
const devolucion = await post(`/api/admin/pos/${pedidoDevId}/devolucion`, {
  items: [{ productId: prod.id, cantidad: 2 }],
  motivo: 'QA: el cliente devolvió 2 unidades',
});
ok(devolucion.status === 200 || devolucion.status === 201, 'se registra la devolución de 2 unidades', `status ${devolucion.status} ${JSON.stringify(devolucion.body).slice(0, 150)}`);

const stockTrasDevolucion = await stockDe(prod.id);
ok(
  stockTrasDevolucion === stockTrasVentaDev + 2,
  'las 2 unidades VUELVEN al inventario',
  `${stockTrasVentaDev} → ${stockTrasDevolucion}`,
);

const esperadoAcreditado = Math.round((totalVentaDev / 5) * 2);
const { body: listaFacturas } = await api('/api/admin/invoices');
const notaCredito = (listaFacturas?.invoices ?? []).find(
  (f) => f.tipo === 'nota_credito' && f.invoiceOrigenId === facturaDev.id,
);
ok(
  notaCredito && Math.abs(notaCredito.total - esperadoAcreditado) <= 2,
  'la nota crédito se emite por el valor de las 2 unidades devueltas',
  `nota ${cop(notaCredito?.total)} vs esperado ${cop(esperadoAcreditado)}`,
);

// ═══════════════ 5. CARTERA: VENTA A CRÉDITO ═══════════════

seccion('5. Cartera — una venta fiada queda como deuda del cliente');

const clienteCredito = await nuevoContacto('QA Cliente Crédito', {
  esCliente: true,
  cupoCredito: 500_000,
  diasCredito: 30,
});

const { body: carteraAntes } = await api('/api/admin/tesoreria/resumen');
const porCobrarAntes = carteraAntes?.porCobrar?.total ?? 0;

const ventaCredito = await post('/api/admin/pos/sell', {
  contactId: clienteCredito.id,
  items: [{ productId: prod.id, cantidad: 4 }],
  metodoPago: 'credito',
});
ok(ventaCredito.status === 201, 'se fía una venta de 4 unidades', `status ${ventaCredito.status}`);

const totalCredito = ventaCredito.body?.venta?.total ?? 0;
const facturaCredito = ventaCredito.body?.venta?.factura;

const { body: carteraDespues } = await api('/api/admin/tesoreria/resumen');
ok(
  (carteraDespues?.porCobrar?.total ?? 0) === porCobrarAntes + totalCredito,
  'la cartera sube EXACTAMENTE lo fiado',
  `${cop(porCobrarAntes)} → ${cop(carteraDespues?.porCobrar?.total)} (venta ${cop(totalCredito)})`,
);

ok(
  facturaCredito?.saldo === totalCredito,
  'y la factura nace debiendo el total',
  `saldo ${cop(facturaCredito?.saldo)}`,
);

// ═══════════════ 6. ABONO PARCIAL A LA CARTERA ═══════════════

seccion('6. Abono parcial — el cliente paga una parte y la cartera lo refleja');

const abono = Math.floor(totalCredito / 2);
const cajaAntesAbono = (await saldos())['caja-efectivo'];

const registrarAbono = await post('/api/admin/payments', {
  contactId: clienteCredito.id,
  monto: abono,
  metodo: 'efectivo',
  nota: 'QA abono parcial',
  allocations: [{ invoiceId: facturaCredito.id, monto: abono }],
});
ok(registrarAbono.status === 201, 'se registra el abono', `status ${registrarAbono.status}`);

const facturaTrasAbono = await facturaDe(facturaCredito.id);
ok(
  facturaTrasAbono?.saldo === totalCredito - abono,
  'la factura queda debiendo SOLO lo que falta',
  `${cop(totalCredito)} − ${cop(abono)} = ${cop(facturaTrasAbono?.saldo)}`,
);

const cajaTrasAbono = (await saldos())['caja-efectivo'];
ok(
  cajaTrasAbono === cajaAntesAbono + abono,
  'y la plata del abono entra a la caja',
  `${cop(cajaAntesAbono)} → ${cop(cajaTrasAbono)}`,
);

// ═══════════════ 7. DOMICILIARIO: ENTREGA Y COBRA TODO ═══════════════

seccion('7. Domicilio — el domiciliario entrega, cobra todo y liquida en la tienda');

const stockAntesDomi = await stockDe(prod.id);

const pedidoDomi = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA Cliente Domicilio',
    clienteTelefono: '3009876543',
    clienteDireccion: 'Carrera QA # 30-40',
    clienteCedula: `9${Math.floor(Math.random() * 1_000_000_000)}`,
    items: [{ productId: prod.id, cantidad: 2 }],
    metodoPago: 'contraentrega',
  }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

ok(pedidoDomi.status === 201, 'entra un pedido contra entrega', `status ${pedidoDomi.status}`);
const domiId = pedidoDomi.body?.order?.id;
const totalDomi = pedidoDomi.body?.order?.total ?? 0;

const stockTrasDomi = await stockDe(prod.id);
ok(stockTrasDomi === stockAntesDomi - 2, 'el inventario se reserva al pedir', `${stockAntesDomi} → ${stockTrasDomi}`);

await post(`/api/admin/orders/${domiId}/aprobar`);
const enviar = await post(`/api/admin/orders/${domiId}/enviar`);
ok(enviar.status === 200, 'el pedido sale a reparto', `status ${enviar.status}`);

const cajaAntesLiquidar = (await saldos())['caja-efectivo'];

// El domiciliario cobra en la puerta: la plata está en SU bolsillo, no en caja.
const cobrarEnPuerta = await post(`/api/admin/orders/${domiId}/pagar`, {});
ok(cobrarEnPuerta.status === 200, 'el domiciliario marca el pedido como cobrado', `status ${cobrarEnPuerta.status}`);

const cajaTrasCobroEnPuerta = (await saldos())['caja-efectivo'];
ok(
  cajaTrasCobroEnPuerta === cajaAntesLiquidar,
  'la caja de la tienda TODAVÍA no cambia: la plata va en la moto',
  `${cop(cajaAntesLiquidar)} → ${cop(cajaTrasCobroEnPuerta)}`,
);

// Y ahora sí, la entrega del efectivo en la tienda.
const liquidar = await post(`/api/admin/orders/${domiId}/liquidar`, {});
ok(liquidar.status === 200, 'el domiciliario entrega el efectivo en la tienda', `status ${liquidar.status}`);

const cajaTrasLiquidar = (await saldos())['caja-efectivo'];
ok(
  cajaTrasLiquidar === cajaAntesLiquidar + totalDomi,
  'AHORA sí la caja sube lo que traía el domiciliario',
  `${cop(cajaAntesLiquidar)} → ${cop(cajaTrasLiquidar)} (pedido ${cop(totalDomi)})`,
);

// ═══════════════ 8. DOMICILIARIO: SOLO TRAE UN ABONO ═══════════════

seccion('8. Domicilio con abono — el cliente solo paga una parte en la puerta');

const clienteAbonoDomi = await nuevoContacto('QA Cliente Abono Domicilio', {
  esCliente: true,
  cupoCredito: 500_000,
  diasCredito: 15,
});

const ventaAbonoDomi = await post('/api/admin/pos/sell', {
  contactId: clienteAbonoDomi.id,
  items: [{ productId: prod.id, cantidad: 3 }],
  metodoPago: 'credito',
});
const facturaAbonoDomi = ventaAbonoDomi.body?.venta?.factura;
const totalAbonoDomi = ventaAbonoDomi.body?.venta?.total ?? 0;

const abonoParcial = Math.floor(totalAbonoDomi / 3);
const cajaAntesAbonoDomi = (await saldos())['caja-efectivo'];

const abonoDomi = await post('/api/admin/payments', {
  contactId: clienteAbonoDomi.id,
  monto: abonoParcial,
  metodo: 'efectivo',
  nota: 'QA: abono recogido por el domiciliario',
  allocations: [{ invoiceId: facturaAbonoDomi.id, monto: abonoParcial }],
});
ok(abonoDomi.status === 201, 'se registra el abono que trajo el domiciliario', `status ${abonoDomi.status}`);

const facturaTrasAbonoDomi = await facturaDe(facturaAbonoDomi.id);
ok(
  facturaTrasAbonoDomi?.saldo === totalAbonoDomi - abonoParcial,
  'la cartera del cliente queda con el resto pendiente, no en cero',
  `debía ${cop(totalAbonoDomi)}, abonó ${cop(abonoParcial)}, queda ${cop(facturaTrasAbonoDomi?.saldo)}`,
);

const cajaTrasAbonoDomi = (await saldos())['caja-efectivo'];
ok(
  cajaTrasAbonoDomi === cajaAntesAbonoDomi + abonoParcial,
  'y en caja entró solo el abono, no la factura entera',
  `${cop(cajaAntesAbonoDomi)} → ${cop(cajaTrasAbonoDomi)}`,
);

// ═══════════════ 9. CIERRE DE CAJA ═══════════════

seccion('9. Cierre de caja — lo recaudado del día cuadra con lo vendido');

const { body: resumenCaja } = await api('/api/admin/reports/cash?canal=pos');
ok(resumenCaja !== null, 'el resumen de caja responde');

const recaudadoAntes = resumenCaja?.recaudado ?? resumenCaja?.total ?? 0;
console.log(`   Recaudado POS antes de cerrar: ${cop(recaudadoAntes)}`);

const cierre = await post('/api/admin/reports/cash/close?canal=pos', {});
ok(cierre.status === 200 || cierre.status === 201, 'la caja del canal POS se cierra', `status ${cierre.status}`);

const { body: resumenTrasCierre } = await api('/api/admin/reports/cash?canal=pos');
ok(
  (resumenTrasCierre?.recaudado ?? resumenTrasCierre?.total ?? 0) === 0,
  'tras cerrar, lo pendiente por cerrar vuelve a cero',
  `queda ${cop(resumenTrasCierre?.recaudado ?? resumenTrasCierre?.total)}`,
);

// ═══════════════ 10. COHERENCIA GLOBAL ═══════════════

seccion('10. Coherencia — el libro de Tesorería cuadra con los saldos');

const { body: movimientos } = await api('/api/admin/tesoreria/movimientos');
const { body: cuentasFinales } = await api('/api/admin/tesoreria/cuentas');

const sumaMovimientos = (movimientos?.movimientos ?? []).reduce(
  (acc, m) => acc + (m.entra ?? 0) - (m.sale ?? 0),
  0,
);
const sumaSaldos = (cuentasFinales?.cuentas ?? []).reduce((acc, c) => acc + c.saldo, 0);

ok(
  sumaMovimientos === sumaSaldos,
  'la suma de TODOS los movimientos es igual a la suma de los saldos',
  `movimientos ${cop(sumaMovimientos)} vs saldos ${cop(sumaSaldos)}`,
);

const { body: resumenFinal } = await api('/api/admin/tesoreria/resumen');
ok(
  resumenFinal?.disponible === sumaSaldos,
  'y el "disponible total" del panel dice lo mismo',
  `${cop(resumenFinal?.disponible)} vs ${cop(sumaSaldos)}`,
);

// Inventario: cuadre completo del producto de prueba.
const stockFinal = await stockDe(prod.id);
const esperadoFinal = prod.stock + 20 - 3 - 2 - 5 + 2 - 4 - 2 - 3;
ok(
  stockFinal === esperadoFinal,
  'el inventario final cuadra con TODOS los movimientos de la prueba',
  `esperado ${esperadoFinal}, real ${stockFinal} (inicial ${prod.stock} +20 compra −3 pos −2 web −5 venta +2 devolución −4 crédito −2 domicilio −3 abono)`,
);

// ═══════════════ RESUMEN ═══════════════

console.log('\n' + '═'.repeat(60));
if (fallos === 0) {
  console.log('TODO OK — los números cuadran de punta a punta');
} else {
  console.log(`${fallos} PROBLEMA(S) ENCONTRADO(S):\n`);
  problemas.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}
console.log('═'.repeat(60) + '\n');

process.exit(fallos === 0 ? 0 : 1);
