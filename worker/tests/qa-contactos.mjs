/**
 * Agenda de proveedores y clientes (migración 0022).
 *
 * Lo importante que se comprueba aquí:
 *
 *  · Que un contacto pueda ser proveedor Y cliente a la vez, que es lo que
 *    motivó una sola tabla en vez de dos.
 *  · Que el checkout de invitado FICHE al cliente por teléfono y no lo
 *    duplique cuando el mismo número vuelve a comprar.
 *  · Que una compra se pueda registrar contra un proveedor de la agenda, y que
 *    la compra copie su nombre en vez de leerlo por JOIN.
 *  · Que un contacto con historial no se pueda borrar — se desactiva.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-contactos.mjs [http://localhost:8788]
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
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.55' },
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
const del = (p) => api(p, { method: 'DELETE' });

const marca = Date.now();

// ─────────────────────── Sembrado de la migración ───────────────────────

seccion('Lo que sembró la migración');

const { body: bAgenda } = await api('/api/admin/contacts?inactivos=1');
const agenda = bAgenda?.contactos ?? [];

t(agenda.length > 0, `la agenda no está vacía (${agenda.length} fichas)`);
t(
  agenda.some((c) => c.esProveedor === 1),
  `hay proveedores creados desde products.origen (${agenda.filter((c) => c.esProveedor === 1).length})`,
);
t(
  agenda.some((c) => c.esCliente === 1),
  `hay clientes creados desde los pedidos (${agenda.filter((c) => c.esCliente === 1).length})`,
);

// ─────────────────────────── Alta manual ───────────────────────────

seccion('Crear un contacto que es proveedor Y cliente');

const TELEFONO = `30012${String(marca).slice(-5)}`;

const { status: sCrear, body: bCrear } = await post('/api/admin/contacts', {
  nombre: `QA Vereda ${marca}`,
  esProveedor: true,
  esCliente: true,
  telefono: TELEFONO,
  direccion: 'Vereda QA, km 3',
  notas: 'Cosecha los martes',
  banco: 'Bancolombia',
  tipoCuenta: 'ahorros',
  numeroCuenta: '12345678901',
  titular: 'QA Titular',
  documento: '900123456',
});

t(sCrear === 201, `crea el contacto (${sCrear})`);
const contacto = bCrear?.contacto;
t(contacto?.esProveedor === 1 && contacto?.esCliente === 1, 'es proveedor y cliente a la vez');
t(contacto?.banco === 'Bancolombia', `guarda los datos de giro (${contacto?.banco})`);
t(contacto?.activo === 1, 'nace activo');

// ──────────────────────────── Validaciones ────────────────────────────

seccion('El servidor protege la agenda');

const { status: sSinTipo, body: bSinTipo } = await post('/api/admin/contacts', {
  nombre: 'QA sin tipo',
  esProveedor: false,
  esCliente: false,
});
t(
  sSinTipo === 400 && bSinTipo?.error?.code === 'sin-tipo',
  `sin marcar proveedor ni cliente se rechaza (${bSinTipo?.error?.code})`,
);

const { status: sRepe, body: bRepe } = await post('/api/admin/contacts', {
  nombre: 'QA teléfono robado',
  esCliente: true,
  telefono: TELEFONO,
});
t(
  sRepe === 409 && bRepe?.error?.code === 'telefono-repetido',
  `un teléfono repetido se rechaza con 409 (${bRepe?.error?.code})`,
);
console.log(`  · mensaje: «${bRepe?.error?.message}»`);

const { status: sCuenta } = await post('/api/admin/contacts', {
  nombre: 'QA tipo cuenta raro',
  esProveedor: true,
  tipoCuenta: 'cripto',
});
t(sCuenta === 400, `un tipo de cuenta fuera del CHECK se rechaza (${sCuenta})`);

// El teléfono se normaliza: con espacios y sin ellos es la misma persona.
const { status: sEspacios, body: bEspacios } = await post('/api/admin/contacts', {
  nombre: 'QA con espacios',
  esCliente: true,
  telefono: TELEFONO.replace(/(\d{3})(\d{3})/, '$1 $2 '),
});
t(
  sEspacios === 409,
  `"300 123 45" y "3001234 5" cuentan como el mismo número (${sEspacios})`,
);

// ─────────────────── El checkout ficha al cliente ───────────────────

seccion('Comprar como invitado crea la ficha del cliente');

const { body: catalogo } = await api('/api/admin/products');
const vendible = catalogo.products.find((p) => p.stock > 4 && !p.esCanasta && !p.tieneVariantes);

const TEL_CLIENTE = `31099${String(marca).slice(-5)}`;

const pedir = async (nombre) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: nombre,
      clienteTelefono: TEL_CLIENTE,
      clienteDireccion: 'Casa QA 123',
      items: [{ productId: vendible.id, cantidad: 1 }],
    }),
  });
  return (await res.json()).order;
};

await pedir(`QA Cliente ${marca}`);

const { body: bTras1 } = await api('/api/admin/contacts?tipo=cliente');
const fichado = (bTras1?.contactos ?? []).filter((c) => c.telefono === TEL_CLIENTE);
t(fichado.length === 1, `el invitado quedó fichado una vez (${fichado.length})`);
t(fichado[0]?.esCliente === 1, 'marcado como cliente');

// Segunda compra del mismo número: NO debe crear otra ficha.
await pedir(`QA Cliente ${marca} (segunda)`);

const { body: bTras2 } = await api('/api/admin/contacts?tipo=cliente');
const fichado2 = (bTras2?.contactos ?? []).filter((c) => c.telefono === TEL_CLIENTE);
t(fichado2.length === 1, `volver a comprar no lo duplica (sigue habiendo ${fichado2.length})`);
t(
  (fichado2[0]?.pedidos ?? 0) >= 2,
  `la ficha acumula sus pedidos (${fichado2[0]?.pedidos})`,
);
t(
  (fichado2[0]?.compradoPorEl ?? 0) > 0,
  `y cuánto ha comprado (${fichado2[0]?.compradoPorEl})`,
);

// ─────────────── Comprarle al proveedor de la agenda ───────────────

seccion('Una compra contra un proveedor de la agenda');

const { status: sCompra, body: bCompra } = await post('/api/admin/providers/purchases', {
  contactId: contacto.id,
  notas: 'QA compra desde agenda',
  items: [{ productId: vendible.id, cantidad: 3, costoUnitario: 1500 }],
});

t(sCompra === 201, `registra la compra con contactId (${sCompra})`);
t(bCompra?.compra?.contactId === contacto.id, 'queda enlazada a la ficha');
t(
  bCompra?.compra?.origen === contacto.nombre,
  `copia el nombre del proveedor: "${bCompra?.compra?.origen}"`,
);
t(
  bCompra?.compra?.proveedorBanco === 'Bancolombia',
  `trae los datos de giro para pagarle (${bCompra?.compra?.proveedorBanco})`,
);

// Un contacto que solo es cliente no puede recibir compras.
const { body: bSoloCliente } = await post('/api/admin/contacts', {
  nombre: `QA Solo Cliente ${marca}`,
  esCliente: true,
});
const { status: sNoProv, body: bNoProv } = await post('/api/admin/providers/purchases', {
  contactId: bSoloCliente.contacto.id,
  items: [{ productId: vendible.id, cantidad: 1, costoUnitario: 100 }],
});
t(
  sNoProv === 400 && bNoProv?.error?.code === 'no-es-proveedor',
  `comprarle a alguien que solo es cliente se rechaza (${bNoProv?.error?.code})`,
);
console.log(`  · mensaje: «${bNoProv?.error?.message}»`);

// ─────────────────── Editar, desactivar y borrar ───────────────────

seccion('Editar, desactivar y borrar');

const { status: sEditar, body: bEditar } = await patch(`/api/admin/contacts/${contacto.id}`, {
  nombre: `QA Vereda ${marca} (corregida)`,
  esProveedor: true,
  esCliente: true,
  telefono: TELEFONO,
  direccion: 'Vereda QA, km 4',
  banco: 'Nequi',
  tipoCuenta: 'nequi',
  numeroCuenta: TELEFONO,
  activo: true,
});
t(sEditar === 200, `edita la ficha (${sEditar})`);
t(bEditar?.contacto?.banco === 'Nequi', `cambia los datos de giro (${bEditar?.contacto?.banco})`);

// Corregir la ficha NO reescribe la compra ya registrada.
const { body: bCompras } = await api(
  `/api/admin/providers/purchases?contact_id=${contacto.id}`,
);
t(
  bCompras?.compras?.[0]?.origen === `QA Vereda ${marca}`,
  `la compra conserva el nombre de ese día: "${bCompras?.compras?.[0]?.origen}"`,
);

const { status: sBorrar, body: bBorrar } = await del(`/api/admin/contacts/${contacto.id}`);
t(
  sBorrar === 409 && bBorrar?.error?.code === 'contacto-con-historial',
  `con historial detrás no se puede borrar (${bBorrar?.error?.code})`,
);
console.log(`  · mensaje: «${bBorrar?.error?.message}»`);

const { body: bDesactivado } = await patch(`/api/admin/contacts/${contacto.id}`, {
  nombre: bEditar.contacto.nombre,
  esProveedor: true,
  esCliente: true,
  telefono: TELEFONO,
  activo: false,
});
t(bDesactivado?.contacto?.activo === 0, 'pero sí se puede desactivar');

const { body: bActivos } = await api('/api/admin/contacts');
t(
  !(bActivos?.contactos ?? []).some((c) => c.id === contacto.id),
  'y desaparece de la lista de activos',
);

// Uno sin historial sí se borra.
const { status: sBorrarLimpio } = await del(`/api/admin/contacts/${bSoloCliente.contacto.id}`);
t(sBorrarLimpio === 200, `uno sin historial sí se borra (${sBorrarLimpio})`);

// ─────────────────────────────────────────────────────────────

console.log(`\n${fallos === 0 ? '✔ Todo en orden' : `✘ ${fallos} fallo(s)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
