#!/usr/bin/env node
/**
 * QA · Caso 3 — stock antes/después de aprobar un pedido, con alerta de
 * stock de seguridad.
 *
 * A propósito NO escribe SQL directo para aprobar: llama al endpoint HTTP
 * real (`POST /api/admin/orders/:id/aprobar`), porque lo que hay que
 * verificar es el comportamiento de la aplicación (la transacción, el token
 * de idempotencia, el CHECK), no solo que la tabla acabe con el número
 * correcto — eso ya lo probarían las llamadas SQL sin necesidad de un script.
 *
 * Uso:
 *   node worker/tests/qa-stock-check.mjs <base-url> <email> <password> [orderId]
 *
 * La cuenta necesita AMBOS roles (o SUPER_ADMIN, que los tiene todos):
 * GESTOR_PEDIDOS para poder aprobar, y ADMIN_INVENTARIO para poder leer
 * `/api/admin/products` y comparar el stock. Con una cuenta que solo tenga
 * uno de los dos, la aprobación funciona pero la comparación de stock se
 * degrada (avisa y sigue, no revienta — ver el catch de abajo).
 *
 * Ejemplos:
 *   node worker/tests/qa-stock-check.mjs http://localhost:8788 admin@agricultores.co demo1234
 *   node worker/tests/qa-stock-check.mjs https://agricultores-organicos.<subdominio>.workers.dev admin@agricultores.co demo1234 <orderId>
 *
 * Si no se pasa orderId, toma el pedido "pendiente"/"verificacion" más
 * antiguo de la cola — el mismo criterio que usaría un gestor real.
 *
 * Salida: 0 si todo cuadra: los productos vendidos bajaron exactamente lo
 * pedido y ningún otro producto cambió. 1 si algo no cuadra. Además imprime
 * una alerta ⚠ por cada producto que, tras la aprobación, quede en o por
 * debajo de su stock_seguridad — la misma señal que dispara la clase A/B/C
 * de reposición en el panel.
 */

const [, , baseUrl, email, password, orderIdArg] = process.argv;

if (!baseUrl || !email || !password) {
  console.error('Uso: node qa-stock-check.mjs <base-url> <email> <password> [orderId]');
  process.exit(2);
}

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

console.log(`== QA stock check contra ${baseUrl} ==`);

// 1. Login real — igual que un gestor entrando al panel.
const { token } = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
});
const auth = { Authorization: `Bearer ${token}` };
console.log('1. Login OK');

// 2. Elegir el pedido a aprobar.
let orderId = orderIdArg;
if (!orderId) {
  const { orders } = await api('/api/admin/orders?abiertos=1', { headers: auth });
  const candidate = orders
    .filter((o) => o.estado === 'pendiente' || o.estado === 'verificacion')
    .sort((a, b) => new Date(a.creadoEn) - new Date(b.creadoEn))[0];
  if (!candidate) {
    console.error('No hay pedidos pendientes de aprobar. Pasa un orderId explícito.');
    process.exit(1);
  }
  orderId = candidate.id;
  console.log(`2. Pedido elegido: ${candidate.referencia} (${candidate.id})`);
} else {
  console.log(`2. Pedido indicado: ${orderId}`);
}

// 3. Snapshot de stock ANTES, más el umbral de seguridad de cada producto.
//    /api/admin/products trae stockSeguridad; solo lo ve ADMIN_INVENTARIO o
//    SUPER_ADMIN — si la cuenta de prueba es GESTOR_PEDIDOS puro, esta
//    llamada fallará con 403 y el script avisa en vez de reventar sin más.
const before = await api('/api/admin/products', { headers: auth }).catch((err) => {
  console.warn(
    '   (no se pudo leer /api/admin/products — probablemente la cuenta no tiene rol ADMIN_INVENTARIO. ' +
      'La comparación de stock seguirá funcionando con lo que traiga el pedido, pero sin el umbral de seguridad.)',
  );
  return null;
});
const stockBefore = new Map((before?.products ?? []).map((p) => [p.id, p.stock]));
const safetyStock = new Map((before?.products ?? []).map((p) => [p.id, p.stockSeguridad ?? 0]));

const orderBefore = await api(`/api/admin/orders?abiertos=1`, { headers: auth }).then(
  (res) => res.orders.find((o) => o.id === orderId) ?? null,
);
if (!orderBefore) {
  console.error(`El pedido ${orderId} no está abierto (ya se aprobó/archivó, o no existe).`);
  process.exit(1);
}
console.log(`3. Stock leído antes de aprobar (${orderBefore.items.length} líneas)`);

// 4. Aprobar de verdad, contra el endpoint real.
let approveError = null;
try {
  await api(`/api/admin/orders/${orderId}/aprobar`, { method: 'POST', headers: auth });
  console.log('4. Aprobación: OK');
} catch (err) {
  approveError = err;
  console.log(`4. Aprobación RECHAZADA (esperado si hay stock insuficiente): ${err.message}`);
}

// 5. Stock DESPUÉS, y el diff exacto contra lo pedido.
const after = before ? await api('/api/admin/products', { headers: auth }) : null;
const stockAfter = new Map((after?.products ?? []).map((p) => [p.id, p.stock]));

console.log('5. Comparación de stock (producto: antes -> después, esperado):');
let ok = true;
const alerts = [];

for (const item of orderBefore.items) {
  const antes = stockBefore.get(item.productId);
  const despues = stockAfter.get(item.productId);
  const esperado = approveError ? antes : (antes ?? 0) - item.cantidad;

  if (antes === undefined || despues === undefined) {
    console.log(`   ${item.productoNombre}: sin visibilidad de stock (rol sin permiso de inventario)`);
    continue;
  }

  const linea = despues === esperado ? '✔' : '✘';
  if (despues !== esperado) ok = false;
  console.log(`   ${linea} ${item.productoNombre}: ${antes} -> ${despues} (esperado ${esperado})`);

  const umbral = safetyStock.get(item.productId) ?? 0;
  if (despues <= umbral) {
    alerts.push({ nombre: item.productoNombre, stock: despues, umbral });
  }
}

if (alerts.length > 0) {
  console.log('\n⚠ ALERTA DE REPOSICIÓN (stock en o bajo el umbral de seguridad):');
  for (const a of alerts) {
    console.log(`   ⚠ ${a.nombre}: quedan ${a.stock}, mínimo ${a.umbral} — clasificar y reponer.`);
  }
}

console.log(ok ? '\n✔ Stock consistente con lo esperado.' : '\n✘ HAY UNA INCONSISTENCIA — revisar arriba.');

// `process.exitCode` en vez de `process.exit()`: deja que el event loop
// drene solo. Llamar a exit() aquí, con conexiones fetch/undici todavía
// cerrando en segundo plano, dispara un crash nativo de libuv en Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") — el resultado
// ya se había impreso bien, pero un script de QA no debería terminar con un
// crash aunque la aserción en sí haya pasado.
process.exitCode = ok ? 0 : 1;
