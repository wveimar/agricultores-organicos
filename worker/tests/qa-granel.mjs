/**
 * QA del inventario omnicanal a granel.
 *
 * El caso: se compra papa por kilos, el mostrador la pesa (2,3 kg) y la tienda
 * web vende presentaciones fijas ("Paquete de 500 g"). Los dos canales tienen
 * que descontar del MISMO montón y cuadrar al gramo.
 *
 * El paquete web no es un inventario aparte: es un producto con una receta de
 * una sola línea —el granel— y `cantidad_requerida = 0.5`. Es el mismo
 * mecanismo de las canastas, con un componente en vez de seis.
 *
 * Lo que se comprueba:
 *   1. Una receta con fracción solo se acepta si el componente es a granel.
 *   2. El stock del paquete se deriva del granel y viene ENTERO (el FLOOR).
 *   3. Vender el paquete en la web descuenta la fracción exacta del granel.
 *   4. Vender a peso en el POS descuenta del mismo montón.
 *   5. Los dos canales suman: el granel queda con lo que debe quedar.
 *   6. Cancelar el pedido web devuelve la fracción, no un entero.
 *
 * Uso: node worker/tests/qa-granel.mjs [base] [email] [password]
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

/** Comparación de kilos: son REAL, así que no se comparan con ===. */
const casi = (a, b) => Math.abs(a - b) < 1e-6;

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

const catalogo = async () => (await api('/api/admin/products?limit=500')).body?.products ?? [];
const buscar = async (id) => (await catalogo()).find((p) => p.id === id);

function cedulaQA() {
  return `9${Math.floor(Math.random() * 1_000_000_000)}`;
}

async function main() {
  console.log(`\nQA inventario a granel · ${BASE}\n`);
  await login();

  const productos = await catalogo();
  const granel = productos.find((p) => p.vendidoPorPeso === 1 && (p.stock ?? 0) >= 10);
  const normal = productos.find(
    (p) => !p.vendidoPorPeso && !p.esCanasta && !p.tieneVariantes && (p.stock ?? 0) > 0,
  );

  if (!granel || !normal) {
    console.error('Faltan productos de prueba. Corre npm run db:reset.');
    process.exit(1);
  }
  console.log(`  · Granel: ${granel.nombre} (${granel.stock} ${granel.unidad})\n`);

  // ── 1. El paquete web: un producto con receta de media unidad ──────────
  console.log('1. Crear la presentación web');

  const paquete = await api('/api/admin/products', {
    method: 'POST',
    body: JSON.stringify({
      nombre: `QA Paquete 500 g · ${granel.nombre}`,
      categoriaId: granel.categoriaId,
      grupoAdmin: granel.grupoAdmin,
      precio: Math.round(granel.precio / 2),
      precioCosto: Math.round((granel.precioCosto ?? 0) / 2),
      unidad: 'gr',
      cantidadUnidad: 500,
      origen: granel.origen,
      imagen: granel.imagen,
      imagenAlt: 'Paquete de prueba QA',
    }),
  });
  ok(paquete.status === 201, 'se crea el producto de la presentación', `status ${paquete.status}`);
  const paqueteId = paquete.body?.product?.id;

  // Una fracción de algo que NO se vende a granel no tiene sentido.
  const fraccionMala = await api(`/api/admin/products/${paqueteId}/componentes`, {
    method: 'PUT',
    body: JSON.stringify({ childId: normal.id, cantidad: 0.5 }),
  });
  ok(
    fraccionMala.status === 400,
    'media unidad de un producto que no es a granel se rechaza',
    `status ${fraccionMala.status}`,
  );
  ok(
    fraccionMala.body?.error?.code === 'cantidad-no-entera',
    'con el código correcto',
    JSON.stringify(fraccionMala.body),
  );

  const receta = await api(`/api/admin/products/${paqueteId}/componentes`, {
    method: 'PUT',
    body: JSON.stringify({ childId: granel.id, cantidad: 0.5 }),
  });
  ok(receta.status === 200, 'media unidad del granel sí se acepta', `status ${receta.status}`);
  ok(
    casi(receta.body?.componentes?.[0]?.cantidadRequerida ?? 0, 0.5),
    'y la receta guarda el 0,5 exacto',
    JSON.stringify(receta.body?.componentes?.[0]),
  );
  ok(
    Number.isInteger(receta.body?.armables) && receta.body.armables > 0,
    'y ya dice cuántos paquetes se pueden armar, en entero',
    `armables ${receta.body?.armables}`,
  );

  // ── 2. El stock del paquete sale del granel, y sale entero ─────────────
  console.log('\n2. Stock derivado');
  const granelAntes = (await buscar(granel.id)).stock;
  const paqueteVista = await buscar(paqueteId);

  ok(
    paqueteVista.stock === Math.floor(granelAntes / 0.5),
    'el paquete ofrece lo que da el granel, redondeado hacia abajo',
    `granel ${granelAntes} kg → paquete ${paqueteVista.stock} (esperado ${Math.floor(granelAntes / 0.5)})`,
  );
  ok(
    Number.isInteger(paqueteVista.stock),
    'y es un número entero: no existen 84,6 paquetes',
    `stock ${paqueteVista.stock}`,
  );

  // ── 3. La web vende el paquete y descuenta la fracción ─────────────────
  console.log('\n3. Venta web de la presentación');
  const pedido = await api('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      clienteNombre: 'QA Granel',
      clienteTelefono: '3000000000',
      clienteDireccion: 'Calle QA',
      clienteCedula: cedulaQA(),
      metodoPago: 'entrega_en_tienda',
      items: [{ productId: paqueteId, cantidad: 3 }],
    }),
  });
  ok(pedido.status === 201, 'se vende el paquete en la tienda', `status ${pedido.status}`);

  const granelTrasWeb = (await buscar(granel.id)).stock;
  ok(
    casi(granelTrasWeb, granelAntes - 1.5),
    '3 paquetes de 500 g descuentan 1,5 kg del granel',
    `antes ${granelAntes}, después ${granelTrasWeb}`,
  );

  // ── 4. El POS pesa del mismo montón ───────────────────────────────────
  console.log('\n4. Venta a peso en el mostrador');
  const venta = await api('/api/admin/pos/sell', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: granel.id, cantidad: 2.3 }],
      metodoPago: 'efectivo',
    }),
  });
  ok(venta.status === 201, 'el mostrador vende 2,3 kg', `status ${venta.status}`);

  const granelTrasPos = (await buscar(granel.id)).stock;
  ok(
    casi(granelTrasPos, granelTrasWeb - 2.3),
    'y descuenta del mismo montón',
    `antes ${granelTrasWeb}, después ${granelTrasPos}`,
  );

  // ── 5. Los dos canales cuadran ────────────────────────────────────────
  console.log('\n5. Cuadre omnicanal');
  ok(
    casi(granelTrasPos, granelAntes - 1.5 - 2.3),
    'el granel refleja exactamente lo que salió por los dos canales',
    `esperado ${granelAntes - 1.5 - 2.3}, real ${granelTrasPos}`,
  );

  const paqueteTrasVentas = (await buscar(paqueteId)).stock;
  ok(
    paqueteTrasVentas === Math.floor(granelTrasPos / 0.5),
    'y lo que la web ofrece se recalcula solo con lo que queda',
    `paquete ${paqueteTrasVentas}, esperado ${Math.floor(granelTrasPos / 0.5)}`,
  );

  // ── 6. Cancelar devuelve la fracción, no un entero ────────────────────
  console.log('\n6. Devolución de la fracción');
  const cancelado = await api(`/api/admin/orders/${pedido.body.order.id}/cancelar`, {
    method: 'POST',
    body: JSON.stringify({ motivo: 'QA: prueba de devolución de fracción' }),
  });
  ok(cancelado.status === 200, 'se cancela el pedido web', `status ${cancelado.status}`);

  const granelTrasCancelar = (await buscar(granel.id)).stock;
  ok(
    casi(granelTrasCancelar, granelTrasPos + 1.5),
    'vuelven 1,5 kg al granel, no 3 unidades',
    `antes ${granelTrasPos}, después ${granelTrasCancelar}`,
  );

  // ── Limpieza ──────────────────────────────────────────────────────────
  await api(`/api/admin/products/${paqueteId}/componentes/${granel.id}`, { method: 'DELETE' });
  await api(`/api/admin/products/${paqueteId}`, {
    method: 'PATCH',
    body: JSON.stringify({ activo: 0 }),
  });

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} FALLO(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Error inesperado:', error);
  process.exit(1);
});
