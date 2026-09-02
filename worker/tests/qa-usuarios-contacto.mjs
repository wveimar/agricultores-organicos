/**
 * Enlace entre la cuenta de usuario y su ficha de contacto (migración 0024).
 *
 * El problema que esto resuelve: el checkout de un mayorista logueado seguía
 * buscando/creando su ficha por el TELÉFONO que escribiera ese día, sin mirar
 * su cuenta. Si un día lo escribía distinto, el cupo que se le había abierto
 * en una ficha quedaba sin efecto en la otra.
 *
 * Lo que se comprueba:
 *  · Sin enlace, dos teléfonos distintos crean dos fichas (el problema real).
 *  · Con la cuenta enlazada a mano, TODOS sus pedidos van a esa ficha, sin
 *    importar qué teléfono teclee.
 *  · Enlazar a un contacto que es solo proveedor se rechaza.
 *  · Dos cuentas no pueden compartir la misma ficha.
 *  · Desenlazar (contactId: null) funciona y vuelve al camino por teléfono.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-usuarios-contacto.mjs [http://localhost:8788]
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
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.71' },
      body: JSON.stringify({ email, password }),
    })
  ).json();
  return { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' };
};

const HA = await login('admin@agricultores.co');
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: HA, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (p, body) =>
  api(p, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
const patch = (p, body) => api(p, { method: 'PATCH', body: JSON.stringify(body) });

const marca = Date.now();

// ─────────────────────── El mayorista y su cuenta ───────────────────────

seccion('Un mayorista con cuenta');

const email = `qa-vinculo-${marca}@test.co`;
const { body: creado } = await post('/api/admin/users', {
  email,
  nombre: `QA Vínculo ${marca}`,
  password: 'demo1234',
  roles: ['MAYORISTA_N1'],
});
const mayoristaId = creado?.user?.id;
t(!!mayoristaId, `cuenta creada (${email})`);
t(creado?.user?.contactId === null, 'nace sin ficha enlazada');

const HM = await login(email);
const { body: catalogo } = await api('/api/admin/products');
const vendible = catalogo.products.find(
  (p) => p.stock > 10 && !p.esCanasta && !p.tieneVariantes && p.precio > 0,
);

const comprar = async (headers, telefono, nombre) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      clienteNombre: nombre,
      clienteTelefono: telefono,
      clienteDireccion: 'Bodega QA',
      // La cédula es obligatoria desde que identifica al cliente. Al azar
      // para no chocar con el índice único entre corridas del script.
      clienteCedula: cedulaQA(),
      items: [{ productId: vendible.id, cantidad: 1 }],
    }),
  });
  return (await res.json()).order;
};

// ────────────── Sin enlace: el problema que se está resolviendo ──────────────

seccion('Sin enlace, dos teléfonos crean dos fichas (el problema)');

const TEL_A = `3011${String(marca).slice(-6)}`;
const TEL_B = `3022${String(marca).slice(-6)}`;

const p1 = await comprar(HM, TEL_A, `QA Vínculo ${marca}`);
const p2 = await comprar(HM, TEL_B, `QA Vínculo ${marca}`);

t(
  p1?.contactId && p2?.contactId && p1.contactId !== p2.contactId,
  `dos teléfonos distintos = dos fichas distintas (${p1?.contactId} ≠ ${p2?.contactId})`,
);

// ────────────────────────── El enlace manual ──────────────────────────

seccion('Enlazar la cuenta a una ficha, a mano');

const { body: bAgenda } = await api('/api/admin/contacts?tipo=cliente&inactivos=1');
const fichaA = (bAgenda?.contactos ?? []).find((c) => c.telefono === TEL_A);
t(!!fichaA, 'la primera ficha existe');

const { status: sEnlace, body: bEnlace } = await patch(`/api/admin/users/${mayoristaId}`, {
  contactId: fichaA.id,
});
t(sEnlace === 200, `se enlaza la cuenta a esa ficha (${sEnlace})`);
t(bEnlace?.user?.contactId === fichaA.id, 'el usuario ahora trae el contactId');
t(bEnlace?.user?.contactoNombre === fichaA.nombre, `y su nombre: "${bEnlace?.user?.contactoNombre}"`);

// Abrirle cupo a esa ficha para probar que el crédito la sigue después.
const CUPO = 500000;
await patch(`/api/admin/contacts/${fichaA.id}`, {
  nombre: fichaA.nombre,
  esCliente: true,
  // Su propio documento: editar la ficha no debe cambiarle la cedula.
  documento: fichaA.documento,
  telefono: fichaA.telefono,
  direccion: fichaA.direccion,
  cupoCredito: CUPO,
  diasCredito: 30,
  activo: true,
});

// ──────────────── Con enlace: cualquier teléfono cae en la MISMA ficha ────────────────

seccion('Con la cuenta enlazada, todo pedido va a la MISMA ficha');

const p3 = await comprar(HM, TEL_B, `QA Vínculo ${marca}`); // teléfono B, distinto del enlazado
t(
  p3?.contactId === fichaA.id,
  `pedido con teléfono B cae en la ficha A de todos modos (${p3?.contactId} === ${fichaA.id})`,
);

const p4 = await comprar(HM, '3000000000', 'Cualquier Nombre'); // ni el teléfono ni el nombre coinciden
t(
  p4?.contactId === fichaA.id,
  `y con un teléfono y nombre cualquiera, sigue siendo la ficha A (${p4?.contactId})`,
);

// El cupo abierto en la ficha A ahora sí protege TODOS sus pedidos.
const { status: sFiar, body: bFiar } = await post(`/api/admin/orders/${p3.id}/aprobar`, {
  token: crypto.randomUUID(),
});
t(sFiar === 200, 'se puede aprobar el pedido (paso previo a fiar)');

const { status: sCredito } = await post(`/api/admin/orders/${p3.id}/credito`);
t(sCredito === 200, `y se le fía usando el cupo de la ficha enlazada (${sCredito})`);

// ──────────────────────── Validaciones del enlace ────────────────────────

seccion('El enlace tiene sus propias reglas');

const { body: bProveedor } = await post('/api/admin/contacts', {
  nombre: `QA Solo Finca ${marca}`,
  esProveedor: true,
  documento: cedulaQA(),
});
const { status: sNoCliente, body: bNoCliente } = await patch(
  `/api/admin/users/${mayoristaId}`,
  { contactId: bProveedor.contacto.id },
);
t(
  sNoCliente === 400 && bNoCliente?.error?.code === 'no-es-cliente',
  `no se puede enlazar a un contacto que solo es proveedor (${bNoCliente?.error?.code})`,
);

// Segunda cuenta intentando robarle la ficha a la primera.
const { body: creado2 } = await post('/api/admin/users', {
  email: `qa-vinculo2-${marca}@test.co`,
  nombre: `QA Vínculo 2 · ${marca}`,
  password: 'demo1234',
  roles: ['MAYORISTA_N1'],
});
const { status: sChoque, body: bChoque } = await patch(
  `/api/admin/users/${creado2.user.id}`,
  { contactId: fichaA.id },
);
t(
  sChoque === 409 && bChoque?.error?.code === 'contacto-ya-enlazado',
  `otra cuenta no puede enlazar la misma ficha (${bChoque?.error?.code})`,
);
console.log(`  · «${bChoque?.error?.message}»`);

// ────────────────────────── Desenlazar ──────────────────────────

seccion('Desenlazar vuelve al camino por teléfono');

const { status: sDesenlace, body: bDesenlace } = await patch(
  `/api/admin/users/${mayoristaId}`,
  { contactId: null },
);
t(sDesenlace === 200, `se desenlaza (${sDesenlace})`);
t(bDesenlace?.user?.contactId === null, 'queda sin ficha');

const p5 = await comprar(HM, TEL_A, `QA Vínculo ${marca}`);
t(
  p5?.contactId === fichaA.id,
  'desenlazada, vuelve a caer por teléfono — y coincide porque es el mismo número',
);

// Ahora sí se le puede enlazar la ficha a la segunda cuenta.
const { status: sAhoraSi } = await patch(`/api/admin/users/${creado2.user.id}`, {
  contactId: fichaA.id,
});
t(sAhoraSi === 200, `libre la ficha, la segunda cuenta sí se puede enlazar (${sAhoraSi})`);

// ─────────────────────────────────────────────────────────────

console.log(`\n${fallos === 0 ? '✔ Todo en orden' : `✘ ${fallos} fallo(s)`}\n`);
process.exit(fallos === 0 ? 0 : 1);


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
