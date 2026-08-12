/**
 * Cancelación de pedidos: devolución de stock, trazabilidad y concurrencia.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-cancelacion.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);

const login = async (email) => {
  const r = await (
    await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.1' },
      body: JSON.stringify({ email, password: 'demo1234' }),
    })
  ).json();
  return { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' };
};

const H = await login('admin@agricultores.co');
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: H, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stockDe = async (id) => {
  const { body } = await api('/api/admin/products');
  return body.products.find((p) => p.id === id)?.stock ?? 0;
};

const crearPedido = async (productId, cantidad) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Cancelación',
      clienteTelefono: '3002145588',
      clienteDireccion: 'Calle 10 #43-20, Medellín',
      envio: 0,
      items: [{ productId, cantidad }],
    }),
  });
  return (await res.json()).order;
};

console.log(`== Cancelación de pedidos · ${BASE} ==`);

const { body: inv } = await api('/api/admin/products');
const producto = inv.products.find((p) => p.activo !== 0 && p.stock >= 10);
console.log(`   Producto de prueba: ${producto.nombre} (stock ${producto.stock})`);

// ──────────────────── Devolución del stock reservado ────────────────────

seccion('1. El stock apartado vuelve al inventario');

const stockInicial = await stockDe(producto.id);
const pedido = await crearPedido(producto.id, 3);
const stockTrasPedir = await stockDe(producto.id);

t(stockTrasPedir === stockInicial - 3, `Al pedir 3, el stock baja: ${stockInicial} → ${stockTrasPedir}`);
t(pedido.stockReservado === 1, 'El pedido queda con el stock apartado');

const cancelado = await api(`/api/admin/orders/${pedido.id}/cancelar`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'El cliente se arrepintió' }),
});
t(cancelado.status === 200, `Cancelación → ${cancelado.status}`);
t(cancelado.body?.order?.estado === 'cancelado', `Estado: ${cancelado.body?.order?.estado}`);
t(cancelado.body?.unidadesDevueltas === 3, `Devuelve 3 unidades: ${cancelado.body?.unidadesDevueltas}`);

const stockFinal = await stockDe(producto.id);
t(stockFinal === stockInicial, `El stock vuelve a su sitio: ${stockTrasPedir} → ${stockFinal}`);

seccion('2. Queda traza de quién y por qué');

const { body: hist } = await api(`/api/admin/orders/${pedido.id}/historial`);
const paso = hist.history.find((h) => h.estado === 'cancelado');
t(!!paso, 'El historial registra el paso a cancelado');
t(!!paso?.actorNombre, `Con el nombre de quien canceló: ${paso?.actorNombre ?? '—'}`);

// ──────────────────── Estados desde los que no se puede ────────────────────

seccion('3. Solo se cancela lo que aún no salió');

const repetida = await api(`/api/admin/orders/${pedido.id}/cancelar`, { method: 'POST' });
t(repetida.status === 409, `Cancelar dos veces → ${repetida.status}`);

const stockTrasRepetir = await stockDe(producto.id);
t(stockTrasRepetir === stockInicial, `Y NO devuelve stock otra vez: ${stockTrasRepetir}`);

const paraAprobar = await crearPedido(producto.id, 1);
await api(`/api/admin/orders/${paraAprobar.id}/aprobar`, { method: 'POST' });
const trasAprobar = await api(`/api/admin/orders/${paraAprobar.id}/cancelar`, { method: 'POST' });
t(trasAprobar.status === 409, `Un pedido aprobado ya no se cancela → ${trasAprobar.status}`);

await api(`/api/admin/orders/${paraAprobar.id}/enviar`, { method: 'POST' });
const trasEnviar = await api(`/api/admin/orders/${paraAprobar.id}/cancelar`, { method: 'POST' });
t(trasEnviar.status === 409, `Un pedido enviado tampoco → ${trasEnviar.status}`);

const inexistente = await api('/api/admin/orders/no-existe-este/cancelar', { method: 'POST' });
t(inexistente.status === 404, `Un pedido inexistente → ${inexistente.status}`);

// ─────────────────────────── Permisos ───────────────────────────

seccion('4. Permisos');

const HInv = await login('inventario@agricultores.co');
const otro = await crearPedido(producto.id, 1);
const ajeno = await fetch(`${BASE}/api/admin/orders/${otro.id}/cancelar`, {
  method: 'POST',
  headers: HInv,
});
t(ajeno.status === 403, `ADMIN_INVENTARIO no puede cancelar → ${ajeno.status}`);

const sinSesion = await fetch(`${BASE}/api/admin/orders/${otro.id}/cancelar`, { method: 'POST' });
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

// ─────────────────── Dos cancelaciones a la vez ───────────────────

seccion('5. Dos personas cancelan el mismo pedido a la vez');

const stockAntes = await stockDe(producto.id);
console.log(`   Pedido ${otro.referencia} con 1 unidad apartada · stock ${stockAntes}`);

const [a, b] = await Promise.all([
  fetch(`${BASE}/api/admin/orders/${otro.id}/cancelar`, { method: 'POST', headers: H }),
  fetch(`${BASE}/api/admin/orders/${otro.id}/cancelar`, { method: 'POST', headers: H }),
]);

console.log(`   A → ${a.status}   B → ${b.status}`);
const exitos = [a, b].filter((r) => r.status === 200).length;
t(exitos === 1, `Solo una prospera (fueron ${exitos})`);

const stockDespues = await stockDe(producto.id);
t(
  stockDespues === stockAntes + 1,
  `El stock sube UNA sola vez: ${stockAntes} → ${stockDespues} (no ${stockAntes + 2})`,
);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
