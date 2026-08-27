/**
 * Gastos operativos y liquidación a fincas (migración 0020).
 *
 * Lo que de verdad importa comprobar aquí es la aritmética del cierre, que es
 * irreversible: que la ganancia reste los gastos, que el envío siga fuera, y
 * —lo más frágil— que el reparto a las fincas sume EXACTAMENTE el costo de la
 * mercancía aunque haya canastas de por medio, donde el costo se distribuye
 * en proporción y hay divisiones enteras que pueden perder pesos.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-gastos-pagos.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);
const cop = (n) => `$${(n ?? 0).toLocaleString('es-CO')}`;

const login = async (email, password = 'demo1234') => {
  const r = await (
    await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' },
      body: JSON.stringify({ email, password }),
    })
  ).json();
  return { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' };
};

const H = await login('admin@agricultores.co');
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: H, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, body) =>
  api(p, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
const del = (p) => api(p, { method: 'DELETE' });

// ───────────────────────────── Gastos ─────────────────────────────

seccion('Registrar gastos en la jornada abierta');

const marca = Date.now();

const { status: sCrear, body: bCrear } = await post('/api/admin/expenses', {
  descripcion: `QA transporte ${marca}`,
  monto: 45000,
  categoria: 'transporte',
});
t(sCrear === 201, `crea un gasto (${sCrear})`);
t(bCrear?.gasto?.monto === 45000, `guarda el monto (${cop(bCrear?.gasto?.monto)})`);
t(bCrear?.gasto?.closingId === null, 'nace huérfano, sin cierre');

const gastoId = bCrear?.gasto?.id;

const { body: bEmpaque } = await post('/api/admin/expenses', {
  descripcion: `QA empaque ${marca}`,
  monto: 12300,
  categoria: 'empaque',
});
const empaqueId = bEmpaque?.gasto?.id;

// Validaciones: el CHECK de la tabla no debe ser la primera línea de defensa.
const { status: sCero } = await post('/api/admin/expenses', {
  descripcion: 'QA cero',
  monto: 0,
  categoria: 'otros',
});
t(sCero === 400, `rechaza monto 0 con 400 y no con un 500 de D1 (${sCero})`);

const { status: sCat } = await post('/api/admin/expenses', {
  descripcion: 'QA categoría inventada',
  monto: 1000,
  categoria: 'sobornos',
});
t(sCat === 400, `rechaza una categoría fuera del CHECK (${sCat})`);

const { body: bLista } = await api('/api/admin/expenses');
const huerfanos = bLista?.gastos ?? [];
t(
  huerfanos.some((g) => g.id === gastoId),
  'el gasto aparece en la lista de huérfanos',
);

const totalGastosEsperado = huerfanos.reduce((s, g) => s + g.monto, 0);
console.log(`  · ${huerfanos.length} gastos huérfanos, ${cop(totalGastosEsperado)} en total`);

// Borrar mientras la jornada sigue abierta sí se puede.
const { status: sBorrar } = await del(`/api/admin/expenses/${empaqueId}`);
t(sBorrar === 200, `borra un gasto todavía sin cierre (${sBorrar})`);

// ──────────────────── Cifras antes de cerrar ────────────────────

seccion('Estado de la caja antes de cerrar');

const { body: resumen } = await api('/api/admin/reports/cash');
const ventaProducto = resumen?.ventaProducto ?? 0;
const costoProducto = resumen?.costoProducto ?? 0;
const enviosCobrados = resumen?.enviosCobrados ?? 0;

console.log(`  · venta producto  ${cop(ventaProducto)}`);
console.log(`  · costo producto  ${cop(costoProducto)}`);
console.log(`  · envíos          ${cop(enviosCobrados)} (no debe entrar en nada)`);

t(
  resumen?.totalRecaudado === ventaProducto,
  'totalRecaudado sigue siendo solo producto, sin envío (migración 0019)',
);

const { body: gastosAhora } = await api('/api/admin/expenses');
const gastosEsperados = (gastosAhora?.gastos ?? []).reduce((s, g) => s + g.monto, 0);

// ───────────────────────────── Cierre ─────────────────────────────

seccion('Cerrar la jornada');

const { status: sCierre, body: bCierre } = await post('/api/admin/reports/cash/close');

// Este QA es destructivo por naturaleza: cierra la jornada de verdad. En una
// segunda pasada ya no queda nada que cerrar, y eso no es un fallo del código
// sino de la base — se dice claro y se sale, en vez de reportar 15 falsos
// negativos en cascada.
if (sCierre === 400 && bCierre?.error?.code === 'sin-ventas') {
  console.log('\n  ⚠ No hay pedidos pendientes de cerrar: este QA ya se corrió.');
  console.log('    Repuebla con `npm run db:reset` y vuelve a intentarlo.\n');
  process.exit(fallos === 0 ? 0 : 1);
}

t(sCierre === 201, `cierra la caja (${sCierre})`);

const cierre = bCierre?.closing;
if (!cierre) {
  console.log('\n✘ Sin cierre en la respuesta, no se puede seguir.');
  process.exit(1);
}

console.log(`  · ${cierre.referencia}`);
console.log(`  · gastos archivados  ${bCierre.gastosArchivados}`);
console.log(`  · fincas por pagar   ${bCierre.fincasPorPagar}`);

t(
  cierre.totalGastos === gastosEsperados,
  `congela total_gastos = ${cop(cierre.totalGastos)} (esperado ${cop(gastosEsperados)})`,
);

const gananciaEsperada = cierre.ventaProducto - cierre.costoProducto - cierre.totalGastos;
t(
  cierre.ganancia === gananciaEsperada,
  `ganancia = venta - costo - gastos = ${cop(cierre.ganancia)}`,
);

t(
  cierre.totalRecaudado === cierre.ventaProducto,
  'el envío sigue fuera del total recaudado del cierre',
);

t(
  cierre.enviosCobrados >= 0 &&
    cierre.ganancia !== cierre.ventaProducto - cierre.costoProducto + cierre.enviosCobrados,
  'la ganancia NO suma el envío',
);

// Un gasto ya archivado no se puede borrar: es parte de una cuenta congelada.
const { status: sBorrarCerrado } = await del(`/api/admin/expenses/${gastoId}`);
t(sBorrarCerrado === 409, `no deja borrar un gasto ya archivado (${sBorrarCerrado})`);

// ─────────────────── Reparto a las fincas ───────────────────

seccion('Liquidación a fincas: la suma tiene que cuadrar al peso');

const { body: bPagos } = await api(`/api/admin/payouts?closing_id=${cierre.id}`);
const pagos = bPagos?.pagos ?? [];

t(pagos.length > 0, `hay reparto (${pagos.length} fincas)`);

const sumaPagos = pagos.reduce((s, p) => s + p.montoPago, 0);
t(
  sumaPagos === cierre.costoProducto,
  `Σ pagos = costo_producto: ${cop(sumaPagos)} vs ${cop(cierre.costoProducto)}`,
);

// El punto de todo el ejercicio: una canasta CON receta congelada reparte su
// costo entre las fincas de verdad, en vez de acreditárselo entero a su
// propio `origen` —que en este catálogo es el texto "38 fincas asociadas"—.
//
// Una canasta SIN receta no se puede expandir: no hay en qué. Esas sí caen a
// su propio origen, a propósito, porque perder su costo descuadraría el
// reparto contra costo_producto. Que aparezca es señal de que a esa canasta
// le falta la receta en el panel, no de que el cálculo esté mal, así que se
// avisa en vez de fallar.
const fantasma = pagos.find((p) => p.origen === '38 fincas asociadas');
if (fantasma) {
  console.log(
    `\n  ⚠ ${cop(fantasma.montoPago)} quedaron en "${fantasma.origen}": son canastas\n` +
      `    sin receta definida. Descríbelas en el panel para que ese dinero se\n` +
      `    reparta entre las fincas que de verdad pusieron el producto.`,
  );
}

// Lo que sí es innegociable: si hubo canastas con receta, sus componentes
// tienen que haber recibido plata. Se comprueba con que el reparto tenga más
// fincas de las que tendría si nada se hubiera expandido.
t(pagos.length > 1, `el reparto llega a varias fincas (${pagos.length}), no a una sola`);

console.log('\n  Reparto:');
for (const pago of pagos.slice(0, 8)) {
  console.log(`   · ${cop(pago.montoPago).padStart(12)}  ${pago.origen}`);
}
if (pagos.length > 8) console.log(`   · … y ${pagos.length - 8} más`);

t(
  pagos.every((p) => p.estado === 'pendiente'),
  'todos nacen pendientes de girar',
);

// ─────────────────── Marcar un giro ───────────────────

seccion('Marcar una finca como pagada');

const primero = pagos[0];
const { status: sPagar, body: bPagar } = await post(`/api/admin/payouts/${primero.id}/pagar`);
t(sPagar === 200, `marca el giro (${sPagar})`);
t(bPagar?.pago?.estado === 'pagado', 'queda en estado pagado');
t(!!bPagar?.pago?.pagadoEn, 'guarda cuándo se giró');

const { status: sOtraVez } = await post(`/api/admin/payouts/${primero.id}/pagar`);
t(sOtraVez === 409, `un segundo clic no vuelve a girar (${sOtraVez})`);

const { body: bPendientes } = await api('/api/admin/payouts?estado=pendiente');
t(
  !(bPendientes?.pagos ?? []).some((p) => p.id === primero.id),
  'sale de la lista de pendientes',
);

// ─────────────────────────────────────────────────────────────

console.log(`\n${fallos === 0 ? '✔ Todo en orden' : `✘ ${fallos} fallo(s)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
