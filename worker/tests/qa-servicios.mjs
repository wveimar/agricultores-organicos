/**
 * Productos tipo "servicio": reserva por fecha y cupo (migración 0038).
 *
 *   npm run worker:dev
 *   node worker/tests/qa-servicios.mjs [http://localhost:8788]
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

const cedulaQA = () => `9${Math.floor(Math.random() * 1_000_000_000)}`;

const crearPedido = async (body) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log(`== Productos tipo servicio · ${BASE} ==`);

// ──────────────────── Crear el producto-servicio y su sesión ────────────────────

seccion('1. Un producto "servicio" nace sin stock ni unidad, con una sesión');

const nuevo = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({
    nombre: `QA Tour ${Date.now()}`,
    categoriaId: 'mieles',
    grupoAdmin: 'agroindustriales',
    precio: 80_000,
    precioCosto: 0,
    imagen: 'https://example.test/qa-tour.jpg',
    imagenAlt: 'Tour de prueba de control de calidad',
    tipo: 'servicio',
  }),
});
t(nuevo.status === 201, `Crear producto servicio → ${nuevo.status}`);
t(nuevo.body?.product?.tipo === 'servicio', `Queda como servicio: ${nuevo.body?.product?.tipo}`);
const productoId = nuevo.body.product.id;

const manana = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const sesion = await api(`/api/admin/products/${productoId}/sesiones`, {
  method: 'POST',
  body: JSON.stringify({ inicio: manana, ubicacion: 'Plaza principal', cupoTotal: 5 }),
});
t(sesion.status === 201, `Crear sesión con cupo 5 → ${sesion.status}`);
const sessionId = sesion.body.sesiones[0].id;
t(sesion.body.sesiones[0].cupoReservado === 0, 'Nace sin reservas');

seccion('2. Una sesión no se puede abrir para un producto físico');

const { body: inv } = await api('/api/admin/products');
const fisico = inv.products.find((p) => p.tipo !== 'servicio' && p.activo !== 0);
const sesionEnFisico = await api(`/api/admin/products/${fisico.id}/sesiones`, {
  method: 'POST',
  body: JSON.stringify({ inicio: manana, cupoTotal: 3 }),
});
t(sesionEnFisico.status === 400, `Rechazada → ${sesionEnFisico.status}`);
t(
  sesionEnFisico.body?.error?.code === 'producto-no-es-servicio',
  `Motivo: ${sesionEnFisico.body?.error?.code}`,
);

// ──────────────────── Reservar contra el cupo ────────────────────

seccion('3. Reservar sube el cupo y no pide dirección');

const reserva = await crearPedido({
  clienteNombre: 'QA Servicios',
  clienteTelefono: '3002145588',
  clienteCedula: cedulaQA(),
  items: [{ productId: productoId, cantidad: 3, sessionId }],
});
t(reserva.status === 201, `Reservar 3 cupos sin dirección → ${reserva.status}`);
t(reserva.body?.order?.clienteDireccion === '', 'Queda sin dirección');
t(reserva.body?.order?.envio === 0, 'Sin costo de envío');

const trasReservar = await api(`/api/admin/products/${productoId}/sesiones`);
const cupoTrasReservar = trasReservar.body.sesiones.find((s) => s.id === sessionId).cupoReservado;
t(cupoTrasReservar === 3, `El cupo reservado sube a 3: ${cupoTrasReservar}`);

seccion('4. No se puede reservar por encima del cupo que queda');

const sobrecupo = await crearPedido({
  clienteNombre: 'QA Servicios 2',
  clienteTelefono: '3002145589',
  clienteCedula: cedulaQA(),
  items: [{ productId: productoId, cantidad: 3, sessionId }],
});
t(sobrecupo.status === 400, `Pedir 3 cuando solo quedan 2 → ${sobrecupo.status}`);
t(sobrecupo.body?.error?.code === 'cupo-insuficiente', `Motivo: ${sobrecupo.body?.error?.code}`);

seccion('5. Sin sesión, no se puede reservar');

const sinSesion = await crearPedido({
  clienteNombre: 'QA Servicios 3',
  clienteTelefono: '3002145590',
  clienteCedula: cedulaQA(),
  items: [{ productId: productoId, cantidad: 1 }],
});
t(sinSesion.status === 400, `Sin sessionId → ${sinSesion.status}`);
t(sinSesion.body?.error?.code === 'sesion-requerida', `Motivo: ${sinSesion.body?.error?.code}`);

seccion('6. No se mezclan productos físicos y servicios en un pedido');

const mezclado = await crearPedido({
  clienteNombre: 'QA Servicios 4',
  clienteTelefono: '3002145591',
  clienteDireccion: 'Calle 10 #43-20, Medellín',
  clienteCedula: cedulaQA(),
  items: [
    { productId: productoId, cantidad: 1, sessionId },
    { productId: fisico.id, cantidad: 1 },
  ],
});
t(mezclado.status === 400, `Carrito mixto → ${mezclado.status}`);
t(mezclado.body?.error?.code === 'tipos-mezclados', `Motivo: ${mezclado.body?.error?.code}`);

// ──────────────────── Cancelar libera el cupo ────────────────────

seccion('7. Cancelar el pedido libera el cupo reservado');

const cancelado = await api(`/api/admin/orders/${reserva.body.order.id}/cancelar`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'QA: liberar cupo' }),
});
t(cancelado.status === 200, `Cancelación → ${cancelado.status}`);
t(cancelado.body?.unidadesDevueltas === 3, `Libera 3 cupos: ${cancelado.body?.unidadesDevueltas}`);

const trasCancelar = await api(`/api/admin/products/${productoId}/sesiones`);
const cupoTrasCancelar = trasCancelar.body.sesiones.find((s) => s.id === sessionId).cupoReservado;
t(cupoTrasCancelar === 0, `El cupo vuelve a 0: ${cupoTrasCancelar}`);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
