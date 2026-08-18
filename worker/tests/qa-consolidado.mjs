/**
 * Consolidado semanal: qué cosechar y auditoría de domicilios.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-consolidado.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

/** Debe ir a la par de worker/src/routes/reports.ts. */
const UMBRAL_GRATIS = 70_000;
const COSTO_ENVIO = 5_000;

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);

const login = async (email) =>
  (
    await (
      await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.140' },
        body: JSON.stringify({ email, password: 'demo1234' }),
      })
    ).json()
  ).token;

const H = {
  authorization: `Bearer ${await login('admin@agricultores.co')}`,
  'content-type': 'application/json',
};
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: H, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const publicos = async () => (await (await fetch(`${BASE}/api/products`)).json()).products;

/** Crea un pedido de invitado y devuelve su id + referencia. */
const pedir = async (items, envio, nombre = 'QA Consolidado') => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: nombre,
      clienteTelefono: '3016066121',
      clienteDireccion: 'Vereda El Rosario, Marinilla',
      envio,
      items,
    }),
  });
  const body = await res.json();
  if (!body.order) throw new Error(`No se pudo crear el pedido: ${JSON.stringify(body)}`);
  return body.order;
};

const consolidado = async (query = '') =>
  (await api(`/api/admin/reports/consolidation${query}`)).body;

const lineaDe = (data, productId) => data.productos.find((p) => p.productId === productId);
const pedidoDe = (data, id) => data.pedidos.find((p) => p.id === id);

console.log(`== Consolidado semanal · ${BASE} ==`);

// ───────────────────────────── Preparación ─────────────────────────────

const catalogo = await publicos();
const barato = catalogo.find((p) => p.stock > 12 && p.precio > 0 && p.precio < 8_000);
const caro = [...catalogo].sort((a, b) => b.precio - a.precio).find((p) => p.stock > 10);

if (!barato || !caro) {
  console.log('✘ El catálogo sembrado no tiene productos suficientes para la prueba.');
  process.exit(1);
}

seccion('1. Solo entra lo aprobado');

const base = await consolidado();
const antes = lineaDe(base, barato.id)?.cantidadTotal ?? 0;
const pendientesAntes = base.pendientes.pedidos;

// Sin aprobar: no debe sumar a la cosecha, pero sí avisar.
const sinAprobar = await pedir([{ productId: barato.id, cantidad: 3 }], COSTO_ENVIO);

const conPendiente = await consolidado();
t(
  (lineaDe(conPendiente, barato.id)?.cantidadTotal ?? 0) === antes,
  `Un pedido en verificación no suma a la cosecha (sigue en ${antes})`,
);
t(
  conPendiente.pendientes.pedidos === pendientesAntes + 1,
  `Pero se cuenta como pendiente: ${pendientesAntes} → ${conPendiente.pendientes.pedidos}`,
);
t(
  !pedidoDe(conPendiente, sinAprobar.id),
  'Y no aparece en la hoja de reparto',
);

await api(`/api/admin/orders/${sinAprobar.id}/aprobar`, { method: 'POST' });

const trasAprobar = await consolidado();
t(
  lineaDe(trasAprobar, barato.id)?.cantidadTotal === antes + 3,
  `Al aprobarlo entra: ${antes} → ${lineaDe(trasAprobar, barato.id)?.cantidadTotal}`,
);
t(
  trasAprobar.pendientes.pedidos === pendientesAntes,
  'Y deja de estar pendiente',
);

seccion('2. Suma varios pedidos del mismo producto');

const segundo = await pedir([{ productId: barato.id, cantidad: 4 }], COSTO_ENVIO);
await api(`/api/admin/orders/${segundo.id}/aprobar`, { method: 'POST' });

const sumado = await consolidado();
const linea = lineaDe(sumado, barato.id);
t(
  linea.cantidadTotal === antes + 7,
  `3 + 4 unidades se consolidan en una sola línea: ${linea.cantidadTotal}`,
);
t(linea.pedidos >= 2, `Y dice de cuántos pedidos sale: ${linea.pedidos}`);

seccion('3. Trae la presentación, no solo el número');

t(typeof linea.unidad === 'string' && linea.unidad !== '', `unidad = "${linea.unidad}"`);
t(
  Number.isInteger(linea.cantidadUnidad) && linea.cantidadUnidad > 0,
  `cantidadUnidad = ${linea.cantidadUnidad}`,
);
t(
  ['frutas', 'verduras', 'agroindustriales'].includes(linea.grupoAdmin),
  `grupoAdmin = ${linea.grupoAdmin}`,
);
t(linea.nombre === barato.nombre, `Nombre histórico desde order_items: "${linea.nombre}"`);

seccion('4. Auditoría del domicilio');

t(
  sumado.regla.umbralEnvioGratis === UMBRAL_GRATIS && sumado.regla.costoEnvio === COSTO_ENVIO,
  `La regla viaja en la respuesta: ${sumado.regla.costoEnvio} bajo ${sumado.regla.umbralEnvioGratis}`,
);

const cobrado = pedidoDe(sumado, segundo.id);
t(cobrado.cobroEnvio === true, 'Un pedido pequeño con domicilio cobrado sale marcado');
t(
  cobrado.envioEsperado === COSTO_ENVIO && cobrado.envioCorrecto === true,
  `Y coincide con la regla: esperado ${cobrado.envioEsperado}, cobrado ${cobrado.envio}`,
);

// Un cliente que manda `envio: 0` sobre un pedido pequeño.
//
// Antes de los precios de mayorista, el Worker aceptaba ese importe tal cual y
// aquí se comprobaba que el informe lo marcara como descuadre. Ya no puede
// pasar: `POST /api/orders` calcula el envío sobre el subtotal que él mismo
// arma, porque con un descuento por medio el subtotal del navegador y el real
// pueden caer a lados distintos del umbral. Lo que se comprueba ahora es que
// esa manipulación no llega a la base — la auditoría de descuadres sigue en el
// informe para los pedidos anteriores a este cambio.
const sinCobrar = await pedir([{ productId: barato.id, cantidad: 1 }], 0, 'QA Sin cobro');
await api(`/api/admin/orders/${sinCobrar.id}/aprobar`, { method: 'POST' });

const conDescuadre = await consolidado();
const fallido = pedidoDe(conDescuadre, sinCobrar.id);
t(
  fallido.envio === COSTO_ENVIO,
  `El "envio: 0" del cliente se ignora y se cobra ${fallido.envio}`,
);
t(fallido.envioCorrecto === true, 'Así que el pedido nace ya cuadrado con la regla');
t(
  fallido.diferenciaEnvio === 0,
  `Sin diferencia que reclamar: ${fallido.diferenciaEnvio}`,
);

// Pedido por encima del umbral: el envío gratis es lo correcto.
const cantidadGrande = Math.ceil(UMBRAL_GRATIS / caro.precio) + 1;
if (cantidadGrande <= caro.stock) {
  const grande = await pedir([{ productId: caro.id, cantidad: cantidadGrande }], 0, 'QA Envío gratis');
  await api(`/api/admin/orders/${grande.id}/aprobar`, { method: 'POST' });

  const conGratis = await consolidado();
  const libre = pedidoDe(conGratis, grande.id);
  t(
    libre.subtotal >= UMBRAL_GRATIS,
    `Pedido de ${libre.subtotal} supera el umbral de ${UMBRAL_GRATIS}`,
  );
  t(
    libre.envioEsperado === 0 && libre.envioCorrecto === true && libre.cobroEnvio === false,
    'Por encima del umbral, envío gratis es lo correcto',
  );
} else {
  console.log('     (sin stock suficiente para armar un pedido sobre el umbral)');
}

seccion('5. Los totales cuadran con las líneas');

const final = await consolidado();
const sumaEnvios = final.pedidos
  .filter((p) => p.envio > 0)
  .reduce((suma, p) => suma + p.envio, 0);
t(
  final.domicilios.totalRecaudado === sumaEnvios,
  `totalRecaudado (${final.domicilios.totalRecaudado}) = suma de envíos (${sumaEnvios})`,
);
t(
  final.domicilios.conCobro + final.domicilios.sinCobro === final.pedidos.length,
  `conCobro + sinCobro = ${final.pedidos.length} pedidos`,
);
t(
  final.totales.referencias === final.productos.length,
  `referencias = ${final.productos.length} líneas de producto`,
);

const sumaSubtotales = final.pedidos.reduce((suma, p) => suma + p.subtotal, 0);
t(
  final.totales.ventaProducto === sumaSubtotales,
  `ventaProducto (${final.totales.ventaProducto}) = suma de subtotales (${sumaSubtotales})`,
);

seccion('6. Cuadra con el cierre de caja');

const { body: caja } = await api('/api/admin/reports/cash');
t(
  caja.enviosCobrados === final.domicilios.totalRecaudado,
  `envios_cobrados de caja (${caja.enviosCobrados}) = domicilios del consolidado (${final.domicilios.totalRecaudado})`,
);
t(
  caja.pedidos === final.totales.pedidos,
  `Mismos pedidos que la caja abierta: ${caja.pedidos} vs ${final.totales.pedidos}`,
);

seccion('7. Filtros de fecha');

const futuro = await api('/api/admin/reports/consolidation?desde=2099-01-01');
t(futuro.status === 200, `Rango futuro → ${futuro.status}`);
t(futuro.body.productos.length === 0, 'Sin nada que cosechar en el futuro');
t(futuro.body.ventana.soloJornadaAbierta === false, 'Y la ventana deja de ser "jornada abierta"');

const hoy = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const delDia = await api(`/api/admin/reports/consolidation?desde=${hoy}&hasta=${hoy}`);
t(delDia.status === 200, `Rango de un solo día → ${delDia.status}`);
t(
  delDia.body.pedidos.length > 0,
  `Incluye los pedidos de hoy: ${delDia.body.pedidos.length} (el "hasta" no los deja fuera)`,
);

const malFormato = await api('/api/admin/reports/consolidation?desde=14-08-2026');
t(malFormato.status === 400, `Fecha con formato inválido → ${malFormato.status}`);
t(malFormato.body?.error?.code === 'fecha-invalida', `Con su motivo: ${malFormato.body?.error?.code}`);

const alReves = await api('/api/admin/reports/consolidation?desde=2026-08-20&hasta=2026-08-01');
t(alReves.status === 400, `Rango invertido → ${alReves.status}`);
t(alReves.body?.error?.code === 'rango-invalido', `Con su motivo: ${alReves.body?.error?.code}`);

const inyeccion = await api(`/api/admin/reports/consolidation?desde=2026-01-01'--`);
t(inyeccion.status === 400, `Fecha con comilla suelta → ${inyeccion.status} (no llega a SQLite)`);

seccion('8. Permisos');

const sinSesion = await fetch(`${BASE}/api/admin/reports/consolidation`);
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

const tokenInv = await login('inventario@agricultores.co');
const inventario = await fetch(`${BASE}/api/admin/reports/consolidation`, {
  headers: { authorization: `Bearer ${tokenInv}` },
});
t(inventario.status === 200, `ADMIN_INVENTARIO sí puede verlo → ${inventario.status}`);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
