/**
 * Más vendidos administrables y borrado de pedidos.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-destacados-borrado.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

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
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.120' },
        body: JSON.stringify({ email, password: 'demo1234' }),
      })
    ).json()
  ).token;

const H = { authorization: `Bearer ${await login('admin@agricultores.co')}`, 'content-type': 'application/json' };
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: H, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const publicos = async () => (await (await fetch(`${BASE}/api/products`)).json()).products;

console.log(`== Más vendidos y borrado de pedidos · ${BASE} ==`);

// ─────────────────────────── Más vendidos ───────────────────────────

seccion('1. Destacar es independiente del stock');

const { body: inv } = await api('/api/admin/products');
const agotado = inv.products.find((p) => p.activo === 1 && p.stock === 0);
const conStock = inv.products.find((p) => p.activo === 1 && p.stock > 3 && p.destacado === 0);

t(inv.products[0].destacado !== undefined, 'El inventario expone el campo destacado');

const destacar = await api(`/api/admin/products/${conStock.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ destacado: 1 }),
});
t(destacar.status === 200 && destacar.body?.product?.destacado === 1,
  `Se destaca ${conStock.nombre} → ${destacar.status}`);

if (agotado) {
  const destacarAgotado = await api(`/api/admin/products/${agotado.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ destacado: 1 }),
  });
  t(
    destacarAgotado.status === 200 && destacarAgotado.body?.product?.destacado === 1,
    `Un producto AGOTADO también se puede destacar (${agotado.nombre})`,
  );
  const enTienda = (await publicos()).find((p) => p.id === agotado.id);
  t(enTienda?.destacado === 1 && enTienda?.stock === 0,
    'Y llega al público destacado y con stock 0: la tarjeta avisa de agotado');
  await api(`/api/admin/products/${agotado.id}`, {
    method: 'PATCH', body: JSON.stringify({ destacado: 0 }),
  });
} else {
  console.log('     (sin productos agotados activos para probar ese caso)');
}

seccion('2. Llega al catálogo público y se puede quitar');

const enPublico = (await publicos()).find((p) => p.id === conStock.id);
t(enPublico?.destacado === 1, 'El destacado sale en /api/products');

const quitar = await api(`/api/admin/products/${conStock.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ destacado: 0 }),
});
t(quitar.body?.product?.destacado === 0, 'Se puede quitar de la portada');

const invalido = await api(`/api/admin/products/${conStock.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ destacado: 7 }),
});
t(invalido.status === 400, `destacado = 7 → ${invalido.status} (no llega al CHECK de D1)`);

seccion('3. No pisa la etiqueta del producto');

const conEtiqueta = inv.products.find((p) => p.badge === 'temporada');
if (conEtiqueta) {
  const marcado = await api(`/api/admin/products/${conEtiqueta.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ destacado: 1 }),
  });
  t(
    marcado.body?.product?.badge === 'temporada' && marcado.body?.product?.destacado === 1,
    `"${conEtiqueta.nombre}" es de temporada Y más vendido a la vez`,
  );
  await api(`/api/admin/products/${conEtiqueta.id}`, {
    method: 'PATCH', body: JSON.stringify({ destacado: 0 }),
  });
} else {
  console.log('     (sin productos con etiqueta temporada)');
}

// ─────────────────────────── Borrado de pedidos ───────────────────────────

seccion('4. Borrar un pedido devuelve su inventario');

const producto = (await publicos()).find((p) => p.stock > 5);
const stockAntes = producto.stock;

const creado = await (
  await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Borrado', clienteTelefono: '3002145588',
      clienteDireccion: 'Calle 10 #43-20, Medellín', envio: 0,
      items: [{ productId: producto.id, cantidad: 2 }],
    }),
  })
).json();

const trasPedir = (await publicos()).find((p) => p.id === producto.id).stock;
t(trasPedir === stockAntes - 2, `Al pedir 2 baja el stock: ${stockAntes} → ${trasPedir}`);

const borrado = await api(`/api/admin/orders/${creado.order.id}`, { method: 'DELETE' });
t(borrado.status === 200, `DELETE → ${borrado.status}`);
t(borrado.body?.unidadesDevueltas === 2, `Devuelve 2 unidades: ${borrado.body?.unidadesDevueltas}`);

const trasBorrar = (await publicos()).find((p) => p.id === producto.id).stock;
t(trasBorrar === stockAntes, `El stock vuelve a su sitio: ${trasPedir} → ${trasBorrar}`);

seccion('5. Se lleva las líneas y la traza (ON DELETE CASCADE)');

const historial = await api(`/api/admin/orders/${creado.order.id}/historial`);
t(historial.status === 404 || (historial.body?.history ?? []).length === 0,
  `No queda historial del pedido borrado → ${historial.status}`);

const { body: lista } = await api('/api/admin/orders?abiertos=1');
t(!lista.orders.some((o) => o.id === creado.order.id), 'Ya no aparece en el listado');

const otraVez = await api(`/api/admin/orders/${creado.order.id}`, { method: 'DELETE' });
t(otraVez.status === 404, `Borrarlo dos veces → ${otraVez.status}`);

seccion('6. Lo que NO se puede borrar');

// Un pedido archivado en un cierre de caja.
const paraCerrar = await (
  await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Cierre', clienteTelefono: '3002145588',
      clienteDireccion: 'Calle 10 #43-20, Medellín', envio: 0,
      items: [{ productId: producto.id, cantidad: 1 }],
    }),
  })
).json();

await api(`/api/admin/orders/${paraCerrar.order.id}/aprobar`, { method: 'POST' });
const cierre = await api('/api/admin/reports/cash/close', { method: 'POST' });
t(cierre.status === 201, `Se cierra la caja → ${cierre.status}`);

const archivado = await api(`/api/admin/orders/${paraCerrar.order.id}`, { method: 'DELETE' });
t(archivado.status === 409, `Un pedido dentro de un cierre → ${archivado.status}`);
t(
  archivado.body?.error?.code === 'pedido-archivado',
  `Con su motivo: ${archivado.body?.error?.code}`,
);

const inexistente = await api('/api/admin/orders/no-existe-jamas', { method: 'DELETE' });
t(inexistente.status === 404, `Pedido inexistente → ${inexistente.status}`);

seccion('7. Permisos');

const tokenInv = await login('inventario@agricultores.co');
const ajeno = await fetch(`${BASE}/api/admin/orders/${paraCerrar.order.id}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${tokenInv}` },
});
t(ajeno.status === 403, `ADMIN_INVENTARIO no puede borrar pedidos → ${ajeno.status}`);

const sinSesion = await fetch(`${BASE}/api/admin/orders/${paraCerrar.order.id}`, {
  method: 'DELETE',
});
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
