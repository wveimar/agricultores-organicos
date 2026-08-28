/**
 * Crédito a un cliente SIN cuenta (migración 0023).
 *
 * Es el caso que estaba bloqueado: fiar exigía `orders.user_id`, y cuatro de
 * cada cinco pedidos son de invitado. Ahora el cupo vive en la ficha de la
 * agenda, que todo pedido tiene.
 *
 * Lo que se comprueba:
 *  · Que a un pedido de invitado se le pueda fiar, con cupo en su ficha.
 *  · Que sin cupo el rechazo diga dónde abrirlo (y no «hace falta cuenta»).
 *  · Que el cupo siga siendo un tope real: dos pedidos que juntos se pasan.
 *  · Que la deuda entre a la cartera y salga al cobrarla.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-credito-invitado.mjs [http://localhost:8788]
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
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.61' },
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
const patch = (p, body) => api(p, { method: 'PATCH', body: JSON.stringify(body) });

const marca = Date.now();
const TELEFONO = `32055${String(marca).slice(-5)}`;

// ─────────────────── Un pedido de invitado, sin cuenta ───────────────────

seccion('Un pedido hecho sin cuenta');

const { body: catalogo } = await api('/api/admin/products');
const vendible = catalogo.products.find(
  (p) => p.stock > 10 && p.precio > 0 && !p.esCanasta && !p.tieneVariantes,
);

/** Pedido de invitado —sin cabecera de sesión— aprobado y listo para fiar. */
const pedidoInvitado = async (cantidad) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: `QA Restaurante ${marca}`,
      clienteTelefono: TELEFONO,
      clienteDireccion: 'Plaza principal, local 3',
      items: [{ productId: vendible.id, cantidad }],
    }),
  });
  const { order } = await res.json();
  await post(`/api/admin/orders/${order.id}/aprobar`, { token: crypto.randomUUID() });
  return order;
};

const a = await pedidoInvitado(2);
t(!!a?.id, `pedido creado: ${a?.referencia} por ${cop(a?.total)}`);

// La ficha la creó el checkout al comprar (migración 0022).
const { body: bAgenda } = await api('/api/admin/contacts?tipo=cliente');
const ficha = (bAgenda?.contactos ?? []).find((c) => c.telefono === TELEFONO);
t(!!ficha, `el checkout lo fichó en la agenda: "${ficha?.nombre}"`);
t(ficha?.cupoCredito === 0, `nace sin cupo (${ficha?.cupoCredito})`);

// ─────────────────── Sin cupo, el mensaje tiene que ayudar ───────────────────

seccion('Sin cupo no se le fía, pero se dice dónde abrirlo');

const { status: sSinCupo, body: bSinCupo } = await post(`/api/admin/orders/${a.id}/credito`);
t(
  sSinCupo === 409 && bSinCupo?.error?.code === 'sin-cupo',
  `rechazado con «${bSinCupo?.error?.code}» (${sSinCupo})`,
);
// El mensaje viejo mandaba a registrar al cliente; el nuevo manda a Contactos.
// Se comprueba a dónde envía, no si aparece la palabra "cuenta" — el texto
// actual la usa justamente para decir que NO hace falta.
const mensajeSinCupo = bSinCupo?.error?.message ?? '';
t(
  /Contactos/.test(mensajeSinCupo) && !/reg[íi]stra|crea.*cuenta/i.test(mensajeSinCupo),
  'el mensaje manda a Contactos, no a crear una cuenta',
);
console.log(`  · «${mensajeSinCupo}»`);

// ─────────────────── Con cupo en la ficha, sí se le fía ───────────────────

seccion('Abrirle cupo en la ficha y fiarle');

// El cupo se elige para que UN pedido quepa y DOS no: es lo que permite
// probar el tope y, después de cobrar, que el espacio se libere.
const CUPO = Math.floor(a.total * 1.6);

const { status: sCupo } = await patch(`/api/admin/contacts/${ficha.id}`, {
  nombre: ficha.nombre,
  esCliente: true,
  esProveedor: false,
  telefono: ficha.telefono,
  direccion: ficha.direccion,
  cupoCredito: CUPO,
  diasCredito: 30,
  activo: true,
});
t(sCupo === 200, `se le abre cupo de ${cop(CUPO)} a 30 días (${sCupo})`);

const { status: sFiar, body: bFiar } = await post(`/api/admin/orders/${a.id}/credito`);
t(sFiar === 200, `AHORA SÍ se le fía sin tener cuenta (${sFiar})`);
t(bFiar?.order?.metodoPago === 'credito', `metodoPago = ${bFiar?.order?.metodoPago}`);
t(!!bFiar?.order?.venceEn, `con vencimiento: ${bFiar?.order?.venceEn}`);

const dias = Math.round((new Date(bFiar?.order?.venceEn) - new Date()) / 86400000);
t(dias >= 29 && dias <= 30, `el plazo sale de la ficha: ${dias} días (esperado ~30)`);

// ─────────────────── El cupo sigue siendo un tope real ───────────────────

seccion('El cupo sigue limitando');

// Del mismo tamaño que el primero: solo se pasa del cupo mientras el otro
// siga sin pagar.
const b = await pedidoInvitado(2);
const { status: sExceso, body: bExceso } = await post(`/api/admin/orders/${b.id}/credito`);
t(
  sExceso === 409 && bExceso?.error?.code === 'cupo-excedido',
  `un segundo pedido que se pasa se rechaza (${bExceso?.error?.code})`,
);
t(
  bExceso?.error?.details?.deuda === a.total,
  `cuenta la deuda de la MISMA ficha: ${cop(bExceso?.error?.details?.deuda)}`,
);
console.log(`  · «${bExceso?.error?.message}»`);

// ─────────────────── La deuda entra y sale de la cartera ───────────────────

seccion('La cartera y el cobro');

const { body: bCartera } = await api('/api/admin/reports/cartera');
const enCartera = (bCartera?.deudores ?? []).find((d) => d.id === a.id);
t(!!enCartera, 'el pedido fiado aparece en la cartera');
t(enCartera?.tramo === 'corriente', `tramo = ${enCartera?.tramo} (aún no vence)`);

const { status: sCobro } = await post(`/api/admin/orders/${a.id}/recaudar`);
t(sCobro === 200, `se cobra la deuda (${sCobro})`);

const { body: bCartera2 } = await api('/api/admin/reports/cartera');
t(
  !(bCartera2?.deudores ?? []).some((d) => d.id === a.id),
  'y desaparece de la cartera',
);

// Con la deuda saldada, el cupo vuelve a estar libre.
const { status: sSegundo } = await post(`/api/admin/orders/${b.id}/credito`);
t(sSegundo === 200, `pagado lo anterior, el cupo se libera y ya cabe (${sSegundo})`);

// ─────────────────────────────────────────────────────────────

console.log(`\n${fallos === 0 ? '✔ Todo en orden' : `✘ ${fallos} fallo(s)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
