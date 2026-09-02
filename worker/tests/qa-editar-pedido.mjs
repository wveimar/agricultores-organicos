/**
 * Editar productos de un pedido: PATCH /api/admin/orders/:id/items.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-editar-pedido.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

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
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.170' },
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

const pedir = async (items, nombre = 'QA Editar') => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: nombre,
      clienteTelefono: '3016066121',
      clienteDireccion: 'Vereda El Rosario, Marinilla',
      // La cédula es obligatoria desde que identifica al cliente. Al azar
      // para no chocar con el índice único entre corridas del script.
      clienteCedula: cedulaQA(),
      envio: 0,
      items,
    }),
  });
  const body = await res.json();
  if (!body.order) throw new Error(`No se pudo crear el pedido: ${JSON.stringify(body)}`);
  return body.order;
};

const stockDe = async (id) => (await publicos()).find((p) => p.id === id)?.stock;

const editar = (orderId, items) =>
  api(`/api/admin/orders/${orderId}/items`, { method: 'PATCH', body: JSON.stringify({ items }) });

console.log(`== Editar productos de un pedido · ${BASE} ==`);

const catalogo = await publicos();
const barato = catalogo.find((p) => p.stock > 15 && p.precio > 0 && p.precio < 8_000);
const otro = catalogo.find((p) => p.id !== barato.id && p.stock > 10 && p.precio < 8_000);

if (!barato || !otro) {
  console.log('✘ El catálogo sembrado no tiene productos suficientes para la prueba.');
  process.exit(1);
}

// ─────────────────────── 1. Aumentar cantidad ajusta el stock ───────────────────────

seccion('1. Aumentar cantidad descuenta la diferencia');

const stockAntes1 = await stockDe(barato.id);
const p1 = await pedir([{ productId: barato.id, cantidad: 2 }]);
t((await stockDe(barato.id)) === stockAntes1 - 2, 'Al crear el pedido baja 2');

const subida = await editar(p1.id, [{ productId: barato.id, cantidad: 5 }]);
t(subida.status === 200, `Subir de 2 a 5 → ${subida.status}`);
t(
  (await stockDe(barato.id)) === stockAntes1 - 5,
  `Solo se descuenta la diferencia (3 más): stock en ${await stockDe(barato.id)}`,
);
t(
  subida.body.order.subtotal === barato.precio * 5,
  `Subtotal recalculado: ${subida.body.order.subtotal} = ${barato.precio} × 5`,
);
t(
  subida.body.order.items.find((i) => i.productId === barato.id).precioUnitario === barato.precio,
  'El precio unitario de la línea no cambió, solo la cantidad',
);

// ─────────────────────── 2. Bajar cantidad devuelve stock ───────────────────────

seccion('2. Bajar cantidad devuelve la diferencia');

const bajada = await editar(p1.id, [{ productId: barato.id, cantidad: 1 }]);
t(bajada.status === 200, `Bajar de 5 a 1 → ${bajada.status}`);
t(
  (await stockDe(barato.id)) === stockAntes1 - 1,
  `Se devuelven 4 unidades: stock en ${await stockDe(barato.id)}`,
);

// ─────────────────────── 3. Añadir un producto nuevo ───────────────────────

seccion('3. Añadir una línea nueva');

const stockOtroAntes = await stockDe(otro.id);
const conNuevo = await editar(p1.id, [
  { productId: barato.id, cantidad: 1 },
  { productId: otro.id, cantidad: 3 },
]);
t(conNuevo.status === 200, `Añadir ${otro.nombre} → ${conNuevo.status}`);
t(conNuevo.body.order.items.length === 2, 'El pedido ahora tiene 2 líneas');
t((await stockDe(otro.id)) === stockOtroAntes - 3, 'Se descontó la línea nueva');
t(
  conNuevo.body.order.items.find((i) => i.productId === otro.id).precioUnitario === otro.precio,
  'La línea nueva toma el precio actual del catálogo',
);
t(
  conNuevo.body.order.subtotal === barato.precio * 1 + otro.precio * 3,
  `Subtotal con las dos líneas: ${conNuevo.body.order.subtotal}`,
);

// ─────────────────────── 4. Quitar una línea devuelve su stock ───────────────────────

seccion('4. Quitar una línea la borra y devuelve su stock');

const sinBarato = await editar(p1.id, [{ productId: otro.id, cantidad: 3 }]);
t(sinBarato.status === 200, `Quitar ${barato.nombre} → ${sinBarato.status}`);
t(sinBarato.body.order.items.length === 1, 'Solo queda 1 línea');
t(
  !sinBarato.body.order.items.some((i) => i.productId === barato.id),
  'La línea quitada ya no aparece',
);
t((await stockDe(barato.id)) === stockAntes1, 'Su stock volvió por completo al original');

// ─────────────────────── 5. Regla de envío se recalcula ───────────────────────

seccion('5. El envío se recalcula con la regla vigente');

const caro = [...catalogo].sort((a, b) => b.precio - a.precio).find((p) => p.stock > 6);
const cantidadGrande = Math.ceil(UMBRAL_GRATIS / caro.precio) + 1;

if (cantidadGrande <= caro.stock) {
  const grande = await editar(p1.id, [{ productId: caro.id, cantidad: cantidadGrande }]);
  t(grande.status === 200, `Subir a un pedido grande → ${grande.status}`);
  t(grande.body.order.subtotal >= UMBRAL_GRATIS, `Subtotal ${grande.body.order.subtotal} supera el umbral`);
  t(grande.body.order.envio === 0, `Envío pasa a gratis: ${grande.body.order.envio}`);
  t(
    grande.body.order.total === grande.body.order.subtotal,
    'Total = subtotal cuando el envío es gratis',
  );

  const chico = await editar(p1.id, [{ productId: otro.id, cantidad: 1 }]);
  t(chico.body.order.subtotal < UMBRAL_GRATIS, `De vuelta bajo el umbral: ${chico.body.order.subtotal}`);
  t(chico.body.order.envio === COSTO_ENVIO, `Envío vuelve a cobrarse: ${chico.body.order.envio}`);
  t(
    chico.body.order.total === chico.body.order.subtotal + COSTO_ENVIO,
    'Total = subtotal + envío',
  );
} else {
  console.log('     (sin stock suficiente para armar un pedido sobre el umbral)');
}

// ─────────────────────── 6. Queda traza de la edición ───────────────────────

seccion('6. Queda registrado en el historial');

const historial = await api(`/api/admin/orders/${p1.id}/historial`);
t(historial.status === 200, `Historial → ${historial.status}`);
t(
  historial.body.history.filter((h) => h.estado === 'editado').length >= 3,
  `Al menos 3 ediciones registradas: ${historial.body.history.filter((h) => h.estado === 'editado').length}`,
);
t(
  historial.body.history[historial.body.history.length - 1].actorNombre != null,
  'La última entrada trae el nombre de quien editó',
);
t(
  historial.body.history.some((h) => h.estado === 'verificacion'),
  'Y sigue estando la traza original de creación (no se sobrescribió)',
);

// ─────────────────────── 7. Sin stock suficiente ───────────────────────

seccion('7. Sin stock suficiente no aplica nada');

const antesDeFallar = await api(`/api/admin/orders/${p1.id}`).then(() =>
  editar(p1.id, [{ productId: otro.id, cantidad: 1 }]),
); // vuelve a un estado conocido: solo "otro" x1
const stockOtroConocido = await stockDe(otro.id);
const subtotalConocido = antesDeFallar.body.order.subtotal;

const pideDemasiado = await editar(p1.id, [
  { productId: otro.id, cantidad: 1 },
  { productId: barato.id, cantidad: 999_999 },
]);
t(pideDemasiado.status === 400, `Pedir 999999 unidades → ${pideDemasiado.status}`);
t(
  pideDemasiado.body?.error?.code === 'stock-insuficiente',
  `Con el motivo correcto: ${pideDemasiado.body?.error?.code}`,
);
t(
  Array.isArray(pideDemasiado.body?.error?.details?.shortfalls),
  'Trae el detalle de qué faltó',
);
t((await stockDe(otro.id)) === stockOtroConocido, 'El stock no se tocó: la operación no dejó nada a medias');

const sinCambios = await api(`/api/admin/orders/${p1.id}`);
// No hay GET de un solo pedido en la API de admin; se confirma vía el listado.
const { body: listado } = await api('/api/admin/orders?abiertos=1');
const pedidoActual = listado.orders.find((o) => o.id === p1.id);
t(pedidoActual.subtotal === subtotalConocido, 'El subtotal del pedido tampoco cambió');

// ─────────────────────── 8. Carrito vacío rechazado ───────────────────────

seccion('8. No se puede dejar el pedido sin líneas');

const vacio = await editar(p1.id, []);
t(vacio.status === 400, `items: [] → ${vacio.status}`);
t(vacio.body?.error?.code === 'carrito-vacio', `Con su motivo: ${vacio.body?.error?.code}`);

// ─────────────────────── 9. Estados que no admiten edición ───────────────────────

seccion('9. Un pedido enviado o cancelado no se puede editar');

const paraCancelar = await pedir([{ productId: otro.id, cantidad: 1 }], 'QA No editable');
await api(`/api/admin/orders/${paraCancelar.id}/cancelar`, { method: 'POST' });

const editarCancelado = await editar(paraCancelar.id, [{ productId: otro.id, cantidad: 2 }]);
t(editarCancelado.status === 409, `Editar uno cancelado → ${editarCancelado.status}`);
t(
  editarCancelado.body?.error?.code === 'estado-invalido',
  `Con su motivo: ${editarCancelado.body?.error?.code}`,
);

const paraEnviar = await pedir([{ productId: otro.id, cantidad: 1 }], 'QA Enviado');
await api(`/api/admin/orders/${paraEnviar.id}/aprobar`, { method: 'POST' });
await api(`/api/admin/orders/${paraEnviar.id}/enviar`, { method: 'POST' });

const editarEnviado = await editar(paraEnviar.id, [{ productId: otro.id, cantidad: 2 }]);
t(editarEnviado.status === 409, `Editar uno enviado → ${editarEnviado.status}`);

// ─────────────────────── 10. Un pedido aprobado sí se puede editar ───────────────────────

seccion('10. Un pedido aprobado admite editar (todavía no se despachó)');

const paraAprobar = await pedir([{ productId: otro.id, cantidad: 2 }], 'QA Aprobado editable');
await api(`/api/admin/orders/${paraAprobar.id}/aprobar`, { method: 'POST' });

const stockOtroPreEdicion = await stockDe(otro.id);
const editarAprobado = await editar(paraAprobar.id, [{ productId: otro.id, cantidad: 4 }]);
t(editarAprobado.status === 200, `Editar uno aprobado → ${editarAprobado.status}`);
t(
  (await stockDe(otro.id)) === stockOtroPreEdicion - 2,
  'Y el inventario en vivo se ajusta igual que en verificación',
);

// ─────────────────────── 11. Producto inexistente o inactivo ───────────────────────

seccion('11. No se puede añadir un producto que no existe');

const inexistente = await editar(paraAprobar.id, [
  { productId: 'otro', cantidad: 1 },
  { productId: 'producto-fantasma-qa', cantidad: 1 },
]);
t(inexistente.status === 400, `Producto inexistente → ${inexistente.status}`);
t(
  inexistente.body?.error?.code === 'producto-invalido',
  `Con su motivo: ${inexistente.body?.error?.code}`,
);

// ─────────────────────── 12. Permisos ───────────────────────

seccion('12. Permisos');

const sinSesion = await fetch(`${BASE}/api/admin/orders/${paraAprobar.id}/items`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ productId: otro.id, cantidad: 1 }] }),
});
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

const tokenInv = await login('inventario@agricultores.co');
const conInventario = await fetch(`${BASE}/api/admin/orders/${paraAprobar.id}/items`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${tokenInv}`, 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ productId: otro.id, cantidad: 1 }] }),
});
t(conInventario.status === 403, `ADMIN_INVENTARIO no puede editar pedidos → ${conInventario.status}`);

const inexistenteId = await editar('no-existe-jamas', [{ productId: otro.id, cantidad: 1 }]);
t(inexistenteId.status === 404, `Pedido inexistente → ${inexistenteId.status}`);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;


/**
 * Una cédula de prueba distinta en cada llamada.
 *
 * `contacts.documento` es único, así que un número fijo haría fallar la
 * segunda corrida del script contra la misma base. El prefijo 9 la marca
 * como inventada: ninguna cédula colombiana real empieza así.
 */
function cedulaQA() {
  return `9${Math.floor(Math.random() * 1_000_000_000)}`;
}
