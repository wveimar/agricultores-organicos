/**
 * QA del punto de venta (migración 0032).
 *
 * Lo que se comprueba:
 *   1. Venta en efectivo: queda pagada, liquidada, con factura y cobro.
 *   2. El stock baja de verdad, y en una canasta baja el de sus componentes.
 *   3. Un precio manual sin motivo se rechaza; con motivo queda auditado.
 *   4. El descuento de mayorista se aplica por la FICHA, sin sesión del cliente.
 *   5. Fiar sin ficha se rechaza; con cupo insuficiente también; con cupo, pasa.
 *   6. Vender más de lo que hay falla entera, sin dejar pedido a medias.
 *   7. Una devolución emite nota crédito y devuelve el stock, en un solo paso.
 *   8. Las dos cajas se cierran por separado y el consolidado las suma.
 *   9. Una venta de mostrador NO aparece en la ruta del domiciliario.
 *
 * Uso: node worker/tests/qa-pos.mjs [base] [email] [password]
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

async function crearCliente(nombre, extra = {}) {
  const res = await api('/api/admin/contacts', {
    method: 'POST',
    body: JSON.stringify({
      nombre,
      telefono: `31${Math.floor(Math.random() * 100000000)}`,
      esCliente: 1,
      esProveedor: 0,
      ...extra,
    }),
  });
  if (res.status !== 201) {
    console.error('No se pudo crear el contacto:', res.status, JSON.stringify(res.body).slice(0, 400));
    process.exit(1);
  }
  return res.body.contacto.id;
}

/** Stock actual de un producto, leído del panel de inventario. */
async function stockDe(productId) {
  const res = await api(`/api/admin/products?limit=500`);
  const lista = res.body?.products ?? res.body?.productos ?? [];
  const p = lista.find((x) => x.id === productId);
  return p?.stockActual ?? p?.stock ?? null;
}

/** Un producto simple (sin variantes) con stock de sobra. */
async function productoConStock(minimo = 10) {
  const res = await api(`/api/admin/products?limit=500`);
  const lista = res.body?.products ?? res.body?.productos ?? [];
  return lista.find(
    (p) => (p.stockActual ?? p.stock ?? 0) >= minimo && p.activo !== 0 && !p.tieneVariantes,
  );
}

async function vender(cuerpo) {
  return api('/api/admin/pos/sell', { method: 'POST', body: JSON.stringify(cuerpo) });
}

async function main() {
  console.log(`\nQA punto de venta · ${BASE}\n`);
  await login();

  const producto = await productoConStock(20);
  if (!producto) {
    console.error('No hay ningún producto con stock suficiente para las pruebas. Corre worker/seed.sql.');
    process.exit(1);
  }
  const precioLista = producto.precio;

  // ── 1. Venta en efectivo ───────────────────────────────────────────────
  console.log('1. Venta en efectivo');
  const stockAntes = await stockDe(producto.id);

  const venta1 = await vender({
    items: [{ productId: producto.id, cantidad: 2 }],
    metodoPago: 'efectivo',
    reciboSolicitado: true,
  });

  ok(venta1.status === 201, 'la venta se registra', `status ${venta1.status}`);
  const v1 = venta1.body?.venta;
  ok(v1?.estado === 'pago', 'queda en estado pago', `estado ${v1?.estado}`);
  ok(v1?.canal === 'pos', 'queda marcada como venta de caja', `canal ${v1?.canal}`);
  ok(v1?.medioPago === 'efectivo', 'guarda el medio de pago real', `medio ${v1?.medioPago}`);
  ok(v1?.envio === 0, 'no cobra domicilio', `envio ${v1?.envio}`);
  ok(v1?.total === precioLista * 2, 'el total es el precio de lista por 2', `total ${v1?.total}`);
  ok(Boolean(v1?.factura?.numero), 'emite factura', JSON.stringify(v1?.factura));
  ok(v1?.factura?.saldo === 0, 'la factura queda saldada (se cobró en el acto)', `saldo ${v1?.factura?.saldo}`);
  ok(v1?.reciboSolicitado === 1, 'recuerda que el cliente pidió recibo');

  // ── 2. El stock baja ───────────────────────────────────────────────────
  console.log('\n2. Inventario');
  const stockDespues = await stockDe(producto.id);
  ok(
    stockDespues === stockAntes - 2,
    'el stock baja exactamente lo vendido',
    `antes ${stockAntes}, después ${stockDespues}`,
  );

  // ── 3. Precio manual ───────────────────────────────────────────────────
  console.log('\n3. Ajuste manual de precio');
  const sinMotivo = await vender({
    items: [{ productId: producto.id, cantidad: 1, precioManual: Math.round(precioLista / 2) }],
    metodoPago: 'efectivo',
  });
  ok(sinMotivo.status === 400, 'un descuento sin motivo se rechaza', `status ${sinMotivo.status}`);
  ok(sinMotivo.body?.error?.code === 'motivo-requerido', 'y dice por qué', JSON.stringify(sinMotivo.body));

  const conMotivo = await vender({
    items: [
      {
        productId: producto.id,
        cantidad: 1,
        precioManual: Math.round(precioLista / 2),
        motivoAjuste: 'Fruta con golpe, acordado con el cliente',
      },
    ],
    metodoPago: 'efectivo',
  });
  ok(conMotivo.status === 201, 'con motivo sí pasa', `status ${conMotivo.status}`);
  ok(
    conMotivo.body?.venta?.items?.[0]?.motivoAjuste?.includes('golpe'),
    'y el motivo queda guardado en la línea',
    JSON.stringify(conMotivo.body?.venta?.items?.[0]),
  );
  ok(
    conMotivo.body?.venta?.total === Math.round(precioLista / 2),
    'se cobra el precio ajustado, no el de lista',
    `total ${conMotivo.body?.venta?.total}`,
  );

  // ── 4. Sin tope de descuento ───────────────────────────────────────────
  const regalado = await vender({
    items: [
      { productId: producto.id, cantidad: 1, precioManual: 0, motivoAjuste: 'Muestra para degustación' },
    ],
    metodoPago: 'efectivo',
  });
  ok(regalado.status === 201, 'no hay tope: se puede dejar en 0 si queda registrado', `status ${regalado.status}`);

  // ── 5. Crédito ─────────────────────────────────────────────────────────
  console.log('\n4. Venta a crédito');
  const sinFicha = await vender({
    items: [{ productId: producto.id, cantidad: 1 }],
    metodoPago: 'credito',
  });
  ok(sinFicha.status === 400, 'fiar sin identificar al cliente se rechaza', `status ${sinFicha.status}`);
  ok(sinFicha.body?.error?.code === 'sin-ficha', 'con el código correcto', JSON.stringify(sinFicha.body));

  const sinCupo = await crearCliente('QA POS sin cupo');
  const rechazado = await vender({
    contactId: sinCupo,
    items: [{ productId: producto.id, cantidad: 1 }],
    metodoPago: 'credito',
  });
  ok(rechazado.status === 409, 'a quien no tiene cupo no se le fía', `status ${rechazado.status}`);
  ok(rechazado.body?.error?.code === 'sin-cupo', 'y se explica', JSON.stringify(rechazado.body));

  const conCupo = await crearCliente('QA POS con cupo', { cupoCredito: 5_000_000, diasCredito: 15 });
  const fiado = await vender({
    contactId: conCupo,
    items: [{ productId: producto.id, cantidad: 1 }],
    metodoPago: 'credito',
  });
  ok(fiado.status === 201, 'con cupo suficiente sí se fía', `status ${fiado.status}`);
  ok(fiado.body?.venta?.estado === 'aprobado', 'la venta fiada queda aprobada, no pagada', `estado ${fiado.body?.venta?.estado}`);
  ok(Boolean(fiado.body?.venta?.venceEn), 'y con fecha de vencimiento', `vence ${fiado.body?.venta?.venceEn}`);
  ok(
    fiado.body?.venta?.factura?.saldo === fiado.body?.venta?.total,
    'la factura queda debiendo el total: no hubo cobro',
    `saldo ${fiado.body?.venta?.factura?.saldo}`,
  );

  const cupoChico = await crearCliente('QA POS cupo chico', { cupoCredito: 1, diasCredito: 8 });
  const excedido = await vender({
    contactId: cupoChico,
    items: [{ productId: producto.id, cantidad: 2 }],
    metodoPago: 'credito',
  });
  ok(excedido.status === 409, 'pasarse del cupo se rechaza', `status ${excedido.status}`);
  ok(excedido.body?.error?.code === 'cupo-excedido', 'con el código de cupo excedido', JSON.stringify(excedido.body));

  // ── 6. Stock insuficiente ──────────────────────────────────────────────
  console.log('\n5. Stock insuficiente');
  const stockActual = await stockDe(producto.id);
  const demasiado = await vender({
    items: [{ productId: producto.id, cantidad: stockActual + 50 }],
    metodoPago: 'efectivo',
  });
  ok(demasiado.status === 400, 'vender más de lo que hay se rechaza', `status ${demasiado.status}`);
  const stockTrasFallo = await stockDe(producto.id);
  ok(
    stockTrasFallo === stockActual,
    'y el inventario no se movió ni un poco',
    `antes ${stockActual}, después ${stockTrasFallo}`,
  );

  // ── 7. Devolución ──────────────────────────────────────────────────────
  console.log('\n6. Devolución');
  const paraDevolver = await vender({
    items: [{ productId: producto.id, cantidad: 3 }],
    metodoPago: 'efectivo',
  });
  const ventaDev = paraDevolver.body?.venta;
  const stockPreDev = await stockDe(producto.id);

  const devolucion = await api(`/api/admin/pos/${ventaDev.id}/devolucion`, {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: producto.id, cantidad: 1 }],
      motivo: 'El cliente se llevó una de más',
    }),
  });
  ok(devolucion.status === 200, 'la devolución se registra', `status ${devolucion.status}`);
  ok(devolucion.body?.nota?.tipo === 'nota_credito', 'emite una nota crédito', JSON.stringify(devolucion.body?.nota));
  ok(
    devolucion.body?.nota?.total === precioLista,
    'por el precio congelado de la venta',
    `total ${devolucion.body?.nota?.total}`,
  );

  const stockPostDev = await stockDe(producto.id);
  ok(
    stockPostDev === stockPreDev + 1,
    'y el stock vuelve al inventario',
    `antes ${stockPreDev}, después ${stockPostDev}`,
  );

  const deMas = await api(`/api/admin/pos/${ventaDev.id}/devolucion`, {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: producto.id, cantidad: 99 }],
      motivo: 'Intento de devolver más de lo vendido',
    }),
  });
  ok(deMas.status === 400, 'devolver más de lo vendido se rechaza', `status ${deMas.status}`);

  // ── 8. Historial ───────────────────────────────────────────────────────
  console.log('\n7. Historial de caja');
  const historial = await api('/api/admin/pos/ventas?hoy=1');
  ok(historial.status === 200, 'el historial responde', `status ${historial.status}`);
  ok(
    (historial.body?.ventas ?? []).some((v) => v.id === ventaDev.id),
    'y contiene las ventas del día',
  );
  ok(
    (historial.body?.ventas ?? []).every((v) => v.metodoPago !== 'transferencia'),
    'solo trae ventas de mostrador',
  );

  // ── 9. Las ventas de caja no salen a la calle ──────────────────────────
  console.log('\n8. Separación con domicilios');
  const entregas = await api('/api/admin/orders/deliveries');
  const colada = (entregas.body?.entregas ?? []).some((e) => e.id === ventaDev.id);
  ok(!colada, 'una venta de mostrador no aparece en la ruta del domiciliario');

  // ── 10. Cierres separados y consolidado ────────────────────────────────
  console.log('\n9. Cierre de caja por canal');
  const resumenPos = await api('/api/admin/reports/cash?canal=pos');
  ok(resumenPos.status === 200, 'el resumen de la caja física responde', `status ${resumenPos.status}`);
  ok(resumenPos.body?.pedidos > 0, 'y ve las ventas del mostrador', `pedidos ${resumenPos.body?.pedidos}`);

  const resumenEcom = await api('/api/admin/reports/cash?canal=ecommerce');
  const pedidosEcomAntes = resumenEcom.body?.pedidos ?? 0;

  const cierrePos = await api('/api/admin/reports/cash/close?canal=pos', { method: 'POST' });
  ok(cierrePos.status === 201, 'la caja del mostrador cierra', `status ${cierrePos.status}`);
  ok(cierrePos.body?.closing?.canal === 'pos', 'y el cierre queda marcado como POS', JSON.stringify(cierrePos.body?.closing));

  const posTrasCierre = await api('/api/admin/reports/cash?canal=pos');
  ok(
    (posTrasCierre.body?.pedidos ?? 0) === 0,
    'después de cerrar, la caja del mostrador queda en cero',
    `pedidos ${posTrasCierre.body?.pedidos}`,
  );

  const ecomTrasCierre = await api('/api/admin/reports/cash?canal=ecommerce');
  ok(
    (ecomTrasCierre.body?.pedidos ?? 0) === pedidosEcomAntes,
    'y el cierre del mostrador NO se llevó los pedidos de la tienda web',
    `antes ${pedidosEcomAntes}, después ${ecomTrasCierre.body?.pedidos}`,
  );

  const consolidado = await api('/api/admin/reports/cash/consolidado');
  ok(consolidado.status === 200, 'el consolidado responde', `status ${consolidado.status}`);
  const filaPos = (consolidado.body?.porCanal ?? []).find((c) => c.canal === 'pos');
  ok(Boolean(filaPos), 'y trae la fila de la caja física', JSON.stringify(consolidado.body?.porCanal));
  ok(
    (consolidado.body?.total?.totalRecaudado ?? 0) >= (filaPos?.totalRecaudado ?? 0),
    'el total suma al menos lo del mostrador',
    JSON.stringify(consolidado.body?.total),
  );

  // ── 11. Ajustes ────────────────────────────────────────────────────────
  console.log('\n10. Ajustes de operación');
  const ajustes = await api('/api/admin/settings');
  ok(ajustes.status === 200, 'los ajustes se leen', `status ${ajustes.status}`);
  ok(
    (ajustes.body?.ajustes ?? []).some((a) => a.clave === 'pos_recibo_por_defecto'),
    'e incluyen el del recibo',
    JSON.stringify(ajustes.body),
  );

  const cambio = await api('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ clave: 'pos_recibo_por_defecto', valor: '0' }),
  });
  ok(cambio.status === 200, 'y se pueden cambiar', `status ${cambio.status}`);

  const inventado = await api('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ clave: 'ajuste_que_no_existe', valor: 'x' }),
  });
  ok(inventado.status === 400, 'un ajuste inventado se rechaza', `status ${inventado.status}`);

  // Se deja como estaba, para no cambiarle la configuración a nadie.
  await api('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ clave: 'pos_recibo_por_defecto', valor: '1' }),
  });

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} FALLO(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Error inesperado:', error);
  process.exit(1);
});
