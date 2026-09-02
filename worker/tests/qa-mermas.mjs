/**
 * QA de la baja de inventario por merma (migración 0034).
 *
 * Lo que se comprueba:
 *   1. Un acta baja el stock exactamente lo dado de baja, y queda documentada.
 *   2. Se valora al COSTO del catálogo, no a lo que mande el navegador.
 *   3. Un producto por peso admite fracciones; uno normal, no.
 *   4. No se puede dar de baja más de lo que hay.
 *   5. Canastas y madres de variantes se rechazan: no tienen inventario propio.
 *   6. Deshacer un acta devuelve el stock; con cierre encima, ya no se puede.
 *   7. El cierre de jornada la adopta y la resta de la ganancia.
 *   8. El informe agrupa por motivo y por producto.
 *
 * Uso: node worker/tests/qa-mermas.mjs [base] [email] [password]
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

async function catalogo() {
  const res = await api('/api/admin/products?limit=500');
  return res.body?.products ?? [];
}

const stockDe = async (id) => (await catalogo()).find((p) => p.id === id)?.stock ?? null;

async function darDeBaja(items, observaciones = 'QA: acta de prueba') {
  return api('/api/admin/mermas', {
    method: 'POST',
    body: JSON.stringify({ items, observaciones }),
  });
}

async function main() {
  console.log(`\nQA merma / baja de inventario · ${BASE}\n`);
  await login();

  const productos = await catalogo();
  const simple = productos.find(
    (p) => (p.stock ?? 0) >= 20 && p.activo !== 0 && !p.tieneVariantes && !p.esCanasta,
  );
  const porPeso = productos.find((p) => p.vendidoPorPeso === 1 && (p.stock ?? 0) >= 5);
  const canasta = productos.find((p) => p.esCanasta === 1);
  const madre = productos.find((p) => p.tieneVariantes === 1);

  if (!simple || !porPeso) {
    console.error('Faltan productos de prueba con stock. Corre npm run db:reset.');
    process.exit(1);
  }

  // ── 1. Un acta baja el stock ───────────────────────────────────────────
  console.log('1. Registrar un acta');
  const stockAntes = await stockDe(simple.id);

  const acta = await darDeBaja([
    { productId: simple.id, cantidad: 3, motivo: 'pudricion', observacion: 'Caja del fondo' },
  ]);

  ok(acta.status === 201, 'el acta se registra', `status ${acta.status}`);
  ok(acta.body?.merma?.items?.length === 1, 'con su línea de detalle');
  ok(
    acta.body?.merma?.items?.[0]?.motivo === 'pudricion',
    'y el motivo queda guardado',
    JSON.stringify(acta.body?.merma?.items?.[0]),
  );
  ok(
    Boolean(acta.body?.merma?.creadoPor),
    'con el nombre de quien la firmó',
    `creadoPor ${acta.body?.merma?.creadoPor}`,
  );

  const stockDespues = await stockDe(simple.id);
  ok(
    stockDespues === stockAntes - 3,
    'el inventario baja exactamente lo dado de baja',
    `antes ${stockAntes}, después ${stockDespues}`,
  );

  // ── 2. Se valora al costo del catálogo ─────────────────────────────────
  console.log('\n2. Valoración');
  const linea = acta.body?.merma?.items?.[0];
  ok(
    linea?.costoUnitario === simple.precioCosto,
    'el costo unitario sale del catálogo, no del navegador',
    `acta ${linea?.costoUnitario}, catálogo ${simple.precioCosto}`,
  );
  ok(
    acta.body?.merma?.totalCosto === simple.precioCosto * 3,
    'y el total es costo × cantidad',
    `total ${acta.body?.merma?.totalCosto}`,
  );
  ok(
    acta.body?.merma?.totalVenta === simple.precio * 3,
    'el valor de venta perdido se guarda aparte',
    `venta ${acta.body?.merma?.totalVenta}`,
  );

  // Aunque el cuerpo mande un costo, se ignora: la valoración la hace el server.
  const conCostoFalso = await api('/api/admin/mermas', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: simple.id, cantidad: 1, motivo: 'otro', costoUnitario: 999999 }],
    }),
  });
  ok(
    conCostoFalso.body?.merma?.items?.[0]?.costoUnitario === simple.precioCosto,
    'un costo mandado desde fuera se ignora',
    JSON.stringify(conCostoFalso.body?.merma?.items?.[0]),
  );

  // ── 3. Fracciones solo en productos por peso ───────────────────────────
  console.log('\n3. Peso y fracciones');
  const fraccionOk = await darDeBaja([
    { productId: porPeso.id, cantidad: 0.4, motivo: 'deshidratacion' },
  ]);
  ok(fraccionOk.status === 201, 'un producto por peso admite fracciones', `status ${fraccionOk.status}`);
  ok(
    Math.abs((fraccionOk.body?.merma?.items?.[0]?.cantidad ?? 0) - 0.4) < 1e-9,
    'y la cantidad se guarda exacta',
    `cantidad ${fraccionOk.body?.merma?.items?.[0]?.cantidad}`,
  );

  const fraccionMal = await darDeBaja([
    { productId: simple.id, cantidad: 0.5, motivo: 'rotura' },
  ]);
  ok(fraccionMal.status === 400, 'un producto normal rechaza fracciones', `status ${fraccionMal.status}`);
  ok(
    fraccionMal.body?.error?.code === 'cantidad-no-entera',
    'con el código correcto',
    JSON.stringify(fraccionMal.body),
  );

  // ── 4. No se puede botar más de lo que hay ─────────────────────────────
  console.log('\n4. Guardas de inventario');
  const disponible = await stockDe(simple.id);
  const deMas = await darDeBaja([
    { productId: simple.id, cantidad: disponible + 10, motivo: 'pudricion' },
  ]);
  ok(deMas.status === 409, 'dar de baja más de lo que hay se rechaza', `status ${deMas.status}`);
  ok(
    deMas.body?.error?.code === 'stock-insuficiente',
    'y dice cuánto queda',
    JSON.stringify(deMas.body?.error?.detalle ?? deMas.body),
  );
  ok(
    (await stockDe(simple.id)) === disponible,
    'el inventario no se movió tras el rechazo',
  );

  const motivoMalo = await darDeBaja([
    { productId: simple.id, cantidad: 1, motivo: 'porque si' },
  ]);
  ok(motivoMalo.status === 400, 'un motivo fuera de la lista se rechaza', `status ${motivoMalo.status}`);

  const repetido = await darDeBaja([
    { productId: simple.id, cantidad: 1, motivo: 'otro' },
    { productId: simple.id, cantidad: 2, motivo: 'rotura' },
  ]);
  ok(repetido.status === 400, 'el mismo producto dos veces en un acta se rechaza', `status ${repetido.status}`);

  if (canasta) {
    const conCanasta = await darDeBaja([
      { productId: canasta.id, cantidad: 1, motivo: 'pudricion' },
    ]);
    ok(conCanasta.status === 400, 'una canasta se rechaza: no tiene inventario propio', `status ${conCanasta.status}`);
  }
  if (madre) {
    const conMadre = await darDeBaja([{ productId: madre.id, cantidad: 1, motivo: 'rotura' }]);
    ok(conMadre.status === 400, 'una madre de variantes se rechaza', `status ${conMadre.status}`);
  }

  // ── 5. Deshacer ────────────────────────────────────────────────────────
  console.log('\n5. Deshacer un acta');
  const stockPreDeshacer = await stockDe(simple.id);
  const paraDeshacer = await darDeBaja([
    { productId: simple.id, cantidad: 2, motivo: 'vencimiento' },
  ]);
  ok((await stockDe(simple.id)) === stockPreDeshacer - 2, 'el acta descuenta');

  const borrado = await api(`/api/admin/mermas/${paraDeshacer.body.merma.id}`, { method: 'DELETE' });
  ok(borrado.status === 200, 'se puede deshacer mientras la jornada esté abierta', `status ${borrado.status}`);
  ok(
    (await stockDe(simple.id)) === stockPreDeshacer,
    'y el inventario vuelve a como estaba',
  );

  // ── 6. Informe ─────────────────────────────────────────────────────────
  console.log('\n6. Informe');
  const informe = await api('/api/admin/mermas/reporte');
  ok(informe.status === 200, 'el informe responde', `status ${informe.status}`);
  ok(
    (informe.body?.porMotivo ?? []).some((m) => m.motivo === 'pudricion'),
    'agrupa por motivo',
    JSON.stringify(informe.body?.porMotivo),
  );
  ok(
    (informe.body?.porProducto ?? []).some((p) => p.productId === simple.id),
    'y por producto',
  );
  ok((informe.body?.total?.costo ?? 0) > 0, 'con un total en plata', JSON.stringify(informe.body?.total));

  // ── 7. El cierre la adopta y la resta de la ganancia ───────────────────
  console.log('\n7. Cierre de jornada');
  const resumen = await api('/api/admin/reports/cash?canal=ecommerce');
  ok(
    (resumen.body?.mermaPendiente ?? 0) > 0,
    'el resumen previo avisa de la merma pendiente',
    `mermaPendiente ${resumen.body?.mermaPendiente}`,
  );

  const mermaPendiente = resumen.body?.mermaPendiente ?? 0;
  const gananciaSinMerma =
    (resumen.body?.ventaProducto ?? 0) - (resumen.body?.costoProducto ?? 0);

  const cierre = await api('/api/admin/reports/cash/close?canal=ecommerce', { method: 'POST' });
  ok(cierre.status === 201, 'la jornada cierra', `status ${cierre.status}`);
  ok(
    cierre.body?.closing?.totalMerma === mermaPendiente,
    'el cierre congela la merma de la jornada',
    `cierre ${cierre.body?.closing?.totalMerma}, pendiente ${mermaPendiente}`,
  );
  ok(
    (cierre.body?.mermasArchivadas ?? 0) > 0,
    'y adopta las actas abiertas',
    `archivadas ${cierre.body?.mermasArchivadas}`,
  );
  ok(
    cierre.body?.closing?.ganancia ===
      gananciaSinMerma - (cierre.body?.closing?.totalGastos ?? 0) - mermaPendiente,
    'la ganancia sale con la merma ya restada',
    `ganancia ${cierre.body?.closing?.ganancia}, esperada ${gananciaSinMerma - (cierre.body?.closing?.totalGastos ?? 0) - mermaPendiente}`,
  );

  // Ya archivada: deshacerla dejaría el inventario y la contabilidad en desacuerdo.
  const archivada = await api('/api/admin/mermas', { method: 'GET' });
  const conCierre = (archivada.body?.mermas ?? []).find((m) => m.closingId !== null);
  if (conCierre) {
    const intento = await api(`/api/admin/mermas/${conCierre.id}`, { method: 'DELETE' });
    ok(intento.status === 409, 'un acta ya cerrada no se puede deshacer', `status ${intento.status}`);
    ok(
      intento.body?.error?.code === 'merma-archivada',
      'con el código correcto',
      JSON.stringify(intento.body),
    );
  } else {
    ok(false, 'debería existir un acta ya adoptada por el cierre');
  }

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} FALLO(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Error inesperado:', error);
  process.exit(1);
});
