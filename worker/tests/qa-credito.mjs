/**
 * Crédito a mayoristas: cupo, vencimiento, cartera y —lo importante— que el
 * dinero fiado entre a la caja el día que se cobra y ni antes ni nunca.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-credito.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);

const login = async (email, password = 'demo1234') => {
  const r = await (
    await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
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

// No hay GET /api/admin/orders/:id --solo DELETE--, asi que el pedido concreto
// se busca en el listado. Con abiertos=1 llegan los que aun no tienen cierre;
// tras cerrar caja hay que pedir el listado completo (ver mas abajo).
// El listado sin filtro tope en 100 filas por un limite de variables de D1
// (ver la nota del informe), asi que se pide acotado y no entero.
const pedido = async (id, query = 'abiertos=1') => {
  const { body } = await api('/api/admin/orders?' + query);
  return body?.orders?.find((o) => o.id === id) ?? null;
};

// ───────────────────────── Cuenta de mayorista ─────────────────────────

seccion('Preparando un mayorista con cupo');

const marca = Date.now();
const email = `qa-credito-${marca}@test.co`;
const TELEFONO_MAYORISTA = `3001${String(marca).slice(-6)}`;

const { body: creado } = await post('/api/admin/users', {
  email,
  nombre: `QA Mayorista ${marca}`,
  password: 'demo1234',
  roles: ['MAYORISTA_N1'],
});
const mayoristaId = creado?.user?.id;
t(!!mayoristaId, `cuenta creada (${email})`);

const CUPO = 200000;

// Desde la migración 0023 el cupo NO va en la cuenta: va en la ficha de la
// agenda, porque se le fía a una persona y no a un login. La ficha la crea el
// checkout al comprar, así que el cupo se abre DESPUÉS del primer pedido.
//
// Que el mayorista tenga cuenta sigue importando, pero para el PRECIO —los
// descuentos por nivel—, no para el crédito.

/** Pone cupo en la ficha con la que se fichó al mayorista al comprar. */
const abrirCupo = async (cupo, dias = 30) => {
  const { body } = await api('/api/admin/contacts?tipo=cliente&inactivos=1');
  const ficha = (body?.contactos ?? []).find((c) => c.telefono === TELEFONO_MAYORISTA);
  if (!ficha) {
    return { status: 0, ficha: null };
  }

  const { status } = await api(`/api/admin/contacts/${ficha.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      nombre: ficha.nombre,
      esCliente: true,
      esProveedor: ficha.esProveedor === 1,
      telefono: ficha.telefono,
      direccion: ficha.direccion,
      cupoCredito: cupo,
      diasCredito: dias,
      activo: true,
    }),
  });
  return { status, ficha };
};

// ───────────────────────── Pedidos del mayorista ─────────────────────────

const HM = await login(email);

const { body: catalogo } = await api('/api/admin/products');
const vendible = catalogo.products.find((p) => p.stock > 20 && !p.tieneVariantes && p.precio > 0);
t(!!vendible, `producto de prueba: ${vendible?.nombre}`);

/** Pedido hecho por el mayorista, aprobado y listo para fiar. */
const pedidoAprobado = async (cantidad) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: HM,
    body: JSON.stringify({
      clienteNombre: `QA Mayorista ${marca}`,
      clienteTelefono: TELEFONO_MAYORISTA,
      clienteDireccion: 'Bodega QA',
      items: [{ productId: vendible.id, cantidad }],
    }),
  });
  const { order } = await res.json();
  await post(`/api/admin/orders/${order.id}/aprobar`, { token: crypto.randomUUID() });
  return order;
};

seccion('Conceder crédito');

const a = await pedidoAprobado(2);

// El checkout ya lo fichó por teléfono; ahora se le abre el cupo en la ficha.
const { status: stCupo, ficha } = await abrirCupo(CUPO, 30);
t(stCupo === 200, `cupo de ${CUPO} abierto en la ficha "${ficha?.nombre}"`);

const { status: stNeg } = await api(`/api/admin/contacts/${ficha.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ nombre: ficha.nombre, esCliente: true, cupoCredito: -5 }),
});
t(stNeg === 400, 'un cupo negativo se rechaza con 400');

const { status: stFiar, body: fiado } = await post(`/api/admin/orders/${a.id}/credito`);
t(stFiar === 200, 'se concede el crédito sobre un pedido aprobado');
t(fiado?.order?.metodoPago === 'credito', `metodoPago = ${fiado?.order?.metodoPago}`);
t(!!fiado?.order?.venceEn, `vence el ${fiado?.order?.venceEn}`);

// El vencimiento tiene que caer a 30 días, no hoy ni el año que viene.
const dias = Math.round(
  (new Date(fiado?.order?.venceEn) - new Date()) / 86400000,
);
t(dias >= 29 && dias <= 30, `el vencimiento cae a ${dias} días (esperado ~30)`);

const { status: stRepe } = await post(`/api/admin/orders/${a.id}/credito`);
t(stRepe === 409, 'fiar dos veces el mismo pedido devuelve 409');

seccion('El cupo se respeta');

// Este pedido solo cabe si el cupo NO estuviera ya comprometido.
const grande = Math.ceil(CUPO / vendible.precio) + 1;
const b = await pedidoAprobado(Math.min(grande, 15));
const { status: stExceso, body: exceso } = await post(`/api/admin/orders/${b.id}/credito`);

if (stExceso === 409 && exceso?.error?.code === 'cupo-excedido') {
  t(true, `se pasa del cupo y se rechaza: «${exceso.error.message}»`);
  t(
    typeof exceso.error.details?.libre === 'number' && exceso.error.details.libre === CUPO - a.total,
    `dice cuánto queda libre: ${exceso.error.details?.libre} (esperado ${CUPO - a.total})`,
  );
} else {
  // Con stock bajo puede que el pedido grande no llegue a superar el cupo.
  t(stExceso === 200, `el segundo pedido cabía en el cupo (status ${stExceso})`);
}

seccion('Una cuenta sin cupo no puede comprar fiado');

const { body: pelado } = await post('/api/admin/users', {
  email: `qa-sincupo-${marca}@test.co`,
  nombre: 'QA Sin Cupo',
  password: 'demo1234',
  roles: ['MAYORISTA_N1'],
});
const HS = await login(`qa-sincupo-${marca}@test.co`);
const resSin = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: HS,
  body: JSON.stringify({
    clienteNombre: 'QA Sin Cupo',
    clienteTelefono: '3000000001',
    clienteDireccion: 'Bodega QA',
    items: [{ productId: vendible.id, cantidad: 1 }],
  }),
});
const { order: sinCupo } = await resSin.json();
await post(`/api/admin/orders/${sinCupo.id}/aprobar`, { token: crypto.randomUUID() });
const { status: stSin, body: errSin } = await post(`/api/admin/orders/${sinCupo.id}/credito`);
t(stSin === 409 && errSin?.error?.code === 'sin-cupo', `rechazado con «${errSin?.error?.code}»`);
t(!!pelado?.user?.id, 'la cuenta sin cupo existía');

seccion('El checkout público no puede autoconcederse crédito');

const resCol = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: HM,
  body: JSON.stringify({
    clienteNombre: 'QA Colado',
    clienteTelefono: '3000000002',
    clienteDireccion: 'Bodega QA',
    items: [{ productId: vendible.id, cantidad: 1 }],
    metodoPago: 'credito',
  }),
});
const { order: colado } = await resCol.json();
t(
  colado?.metodoPago !== 'credito',
  `pedir 'credito' desde la tienda cae en '${colado?.metodoPago}'`,
);

// ─────────────────── Lo importante: la caja ───────────────────

seccion('La deuda NO cuenta como recaudado');

const { body: resumen1 } = await api('/api/admin/reports/cash');
const { body: cartera1 } = await api('/api/admin/reports/cartera');

const enCartera = cartera1?.deudores?.find((d) => d.id === a.id);
t(!!enCartera, 'el pedido fiado aparece en la cartera');
t(enCartera?.tramo === 'corriente', `tramo = ${enCartera?.tramo} (aún no vence)`);
t(enCartera?.diasVencido <= 0, `diasVencido = ${enCartera?.diasVencido} (negativo = falta)`);

const antesDeCerrar = await pedido(a.id);
t(!!antesDeCerrar, 'el pedido se encuentra en el listado');
t(
  antesDeCerrar?.closingId == null,
  `sigue sin closing_id (${antesDeCerrar?.closingId}): ningún cierre lo ha barrido`,
);

seccion('Al cobrarla, entra a la caja');

const { status: stCobro, body: cobrado } = await post(`/api/admin/orders/${a.id}/recaudar`);
t(stCobro === 200, 'POST /recaudar acepta');
t(cobrado?.order?.estado === 'pago', `estado = ${cobrado?.order?.estado}`);

const { body: resumen2 } = await api('/api/admin/reports/cash');
const subio = (resumen2?.totalRecaudado ?? 0) - (resumen1?.totalRecaudado ?? 0);
// `subtotal` y no `total`: desde la migración 0019 el domicilio no cuenta como
// venta en ninguna cifra del panel, así que el recaudado sube solo lo que se
// vendió de producto. Este test esperaba `total` —producto + envío— y era la
// regla vieja, no un fallo del cobro.
t(
  subio === a.subtotal,
  `el recaudado sube el producto del pedido, sin domicilio: +${subio} (esperado ${a.subtotal})`,
);

const { body: cartera2 } = await api('/api/admin/reports/cartera');
t(
  !cartera2?.deudores?.some((d) => d.id === a.id),
  'y desaparece de la cartera',
);

const { status: stRe } = await post(`/api/admin/orders/${a.id}/recaudar`);
t(stRe === 409, 'recaudar dos veces devuelve 409');

seccion('El cierre de caja se lo lleva');

const { status: stCierre, body: cierre } = await post('/api/admin/reports/cash/close');
t([200, 201, 409].includes(stCierre), `cierre: status ${stCierre}`);

if (stCierre === 200 || stCierre === 201) {
  // Ya no esta "abierto": el cierre le puso closing_id. Se busca por estado.
  const cerrado = await pedido(a.id, 'estado=pago');
  t(!!cerrado?.closingId, `ya tiene closing_id (${cerrado?.closingId})`);

  // La prueba de que no se cuenta dos veces: el siguiente cierre no lo ve.
  const { body: resumen3 } = await api('/api/admin/reports/cash');
  const quedan = (resumen3?.totalRecaudado ?? 0);
  t(
    quedan === 0 || !cierre?.closing?.id || quedan < a.total,
    `tras cerrar, el pendiente baja a ${quedan}: no se recontará`,
  );
}

console.log(`\n${fallos === 0 ? '✔ Todo bien.' : `✘ ${fallos} fallo(s).`}`);
process.exitCode = fallos ? 1 : 0;
