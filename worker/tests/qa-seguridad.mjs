/**
 * Pruebas de integración de seguridad y concurrencia contra el Worker real.
 *
 *   npm run worker:dev              # en otra terminal
 *   node worker/tests/qa-seguridad.mjs [http://localhost:8788]
 *
 * Se ejecuta contra un Worker de verdad y su D1, no contra dobles: lo que se
 * quiere comprobar —que el CHECK de la base revierte una transacción, que una
 * firma manipulada se rechaza— solo existe ahí.
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);

const login = async (email, password = 'demo1234') => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const conToken = (token) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

console.log(`== Seguridad e integridad · ${BASE} ==`);

// ───────────────────────────── Autenticación ─────────────────────────────

seccion('1. Autenticación');

const sesion = await login('admin@agricultores.co');
t(sesion.status === 200 && !!sesion.body?.token, `Login válido devuelve token (${sesion.status})`);
const TOKEN = sesion.body.token;

const malaClave = await login('admin@agricultores.co', 'claveIncorrecta');
t(malaClave.status === 401, `Contraseña incorrecta → ${malaClave.status}`);

const noExiste = await login('fantasma@agricultores.co');
t(noExiste.status === 401, `Correo inexistente → ${noExiste.status} (mismo error, no delata cuentas)`);

const sinToken = await fetch(`${BASE}/api/admin/products`);
t(sinToken.status === 401, `Sin cabecera Authorization → ${sinToken.status}`);

const basura = await fetch(`${BASE}/api/admin/products`, {
  headers: { authorization: 'Bearer no-es-un-jwt' },
});
t(basura.status === 401, `Token con formato inválido → ${basura.status}`);

const sinBearer = await fetch(`${BASE}/api/admin/products`, {
  headers: { authorization: TOKEN },
});
t(sinBearer.status === 401, `Token sin el prefijo "Bearer" → ${sinBearer.status}`);

// Firma manipulada: se conservan cabecera y payload, se cambia la firma.
const [h, p] = TOKEN.split('.');
const firmaFalsa = await fetch(`${BASE}/api/admin/products`, {
  headers: { authorization: `Bearer ${h}.${p}.firmaInventadaAAAAAAAAAAAAAAAAAAAAAAAAAAA` },
});
t(firmaFalsa.status === 401, `Firma manipulada → ${firmaFalsa.status}`);

// Confusión de algoritmo: `alg: none` con la firma vacía. Es el ataque clásico
// contra implementaciones caseras de JWT.
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');
const algNone = `${b64url({ alg: 'none', typ: 'JWT' })}.${p}.`;
const conAlgNone = await fetch(`${BASE}/api/admin/products`, {
  headers: { authorization: `Bearer ${algNone}` },
});
t(conAlgNone.status === 401, `alg: "none" → ${conAlgNone.status}`);

// Escalada de privilegios: se reescribe el payload con roles de SUPER_ADMIN
// manteniendo la firma original, que ya no cuadra.
const payloadOriginal = JSON.parse(Buffer.from(p, 'base64url').toString());
const payloadElevado = b64url({ ...payloadOriginal, roles: ['SUPER_ADMIN'], sub: 'u-99' });
const elevado = await fetch(`${BASE}/api/admin/products`, {
  headers: { authorization: `Bearer ${h}.${payloadElevado}.${TOKEN.split('.')[2]}` },
});
t(elevado.status === 401, `Payload reescrito con más privilegios → ${elevado.status}`);

// Expiración: un exp en el pasado, firmado con la firma original (que no
// corresponde) debe caer igualmente.
const expirado = b64url({ ...payloadOriginal, exp: Math.floor(Date.now() / 1000) - 60 });
const conExpirado = await fetch(`${BASE}/api/admin/products`, {
  headers: { authorization: `Bearer ${h}.${expirado}.${TOKEN.split('.')[2]}` },
});
t(conExpirado.status === 401, `Token caducado → ${conExpirado.status}`);

const valido = await fetch(`${BASE}/api/admin/products`, { headers: conToken(TOKEN) });
t(valido.status === 200, `Token legítimo sigue funcionando → ${valido.status}`);

// ────────────────────────────── Autorización ──────────────────────────────

seccion('2. Autorización por rol');

const gestor = await login('pedidos@agricultores.co');
const tokenGestor = gestor.body.token;

const inventarioAjeno = await fetch(`${BASE}/api/admin/products`, {
  headers: conToken(tokenGestor),
});
t(inventarioAjeno.status === 403, `GESTOR_PEDIDOS sobre inventario → ${inventarioAjeno.status}`);

const inventario = await login('inventario@agricultores.co');
const cierreAjeno = await fetch(`${BASE}/api/admin/reports/cash/close`, {
  method: 'POST',
  headers: conToken(inventario.body.token),
});
t(cierreAjeno.status === 403, `ADMIN_INVENTARIO cerrando caja → ${cierreAjeno.status}`);

// ───────────────────────── Concurrencia sobre el stock ─────────────────────

seccion('3. Dos compras a la vez del último disponible');

const H = conToken(TOKEN);

// Se deja un producto con exactamente 1 unidad.
const { products } = await (await fetch(`${BASE}/api/products`)).json();
const objetivo = products.find((x) => x.stock > 0);
await fetch(`${BASE}/api/admin/products/${objetivo.id}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ stock: 1 }),
});
console.log(`   Producto: ${objetivo.nombre} · stock puesto a 1`);

const pedir = (quien) =>
  fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: `Cliente ${quien}`,
      clienteTelefono: '3002145588',
      clienteDireccion: 'Calle 10 #43-20, Medellín',
      envio: 0,
      items: [{ productId: objetivo.id, cantidad: 1 }],
    }),
  });

// Se lanzan sin await entre medias: salen a la vez.
const [a, b] = await Promise.all([pedir('A'), pedir('B')]);
const cuerpos = await Promise.all([a.json().catch(() => null), b.json().catch(() => null)]);

const exitos = [a, b].filter((r) => r.status === 201).length;
const rechazos = [a, b].filter((r) => r.status >= 400).length;

console.log(`   A → ${a.status}   B → ${b.status}`);
t(exitos === 1, `Exactamente un pedido prospera (fueron ${exitos})`);
t(rechazos === 1, `Exactamente uno se rechaza (fueron ${rechazos})`);

const rechazado = cuerpos.find((c) => c?.error);
t(
  rechazado?.error?.code === 'stock-insuficiente',
  `El rechazo dice por qué: ${rechazado?.error?.code ?? '—'}`,
);

const { products: despues } = await (await fetch(`${BASE}/api/products?categoria=${objetivo.categoriaId}`)).json();
const stockFinal = despues.find((x) => x.id === objetivo.id)?.stock ?? 0;
t(stockFinal === 0, `El stock queda en 0, nunca en negativo (quedó ${stockFinal})`);

// La reserva del que falló no puede haber quedado a medias.
const listado = await (await fetch(`${BASE}/api/admin/orders?abiertos=1`, { headers: H })).json();
const delProducto = listado.orders.filter((o) =>
  o.items.some((i) => i.productId === objetivo.id),
);
const unidadesReservadas = delProducto.reduce(
  (suma, o) => suma + o.items.filter((i) => i.productId === objetivo.id).reduce((s, i) => s + i.cantidad, 0),
  0,
);
t(
  unidadesReservadas <= 1,
  `No hay pedidos huérfanos: ${unidadesReservadas} unidad(es) comprometida(s)`,
);

// ──────────────────────── Validación de entrada ────────────────────────

seccion('4. Validación de entrada');

const cantidadNegativa = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA', clienteTelefono: '3002145588',
    clienteDireccion: 'Calle 10 #43-20, Medellín', envio: 0,
    items: [{ productId: objetivo.id, cantidad: -5 }],
  }),
});
t(cantidadNegativa.status >= 400, `Cantidad negativa → ${cantidadNegativa.status}`);

const envioNegativo = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA', clienteTelefono: '3002145588',
    clienteDireccion: 'Calle 10 #43-20, Medellín', envio: -9900,
    items: [{ productId: objetivo.id, cantidad: 1 }],
  }),
});
t(envioNegativo.status >= 400, `Envío negativo → ${envioNegativo.status}`);

const sinItems = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA', clienteTelefono: '3002145588',
    clienteDireccion: 'Calle 10 #43-20, Medellín', envio: 0, items: [],
  }),
});
t(sinItems.status >= 400, `Pedido sin líneas → ${sinItems.status}`);

const sqli = await login("admin@agricultores.co' OR '1'='1");
t(sqli.status === 401, `Comilla suelta en el correo → ${sqli.status} (consultas parametrizadas)`);

const precioNegativo = await fetch(`${BASE}/api/admin/products/${objetivo.id}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ precio: -1 }),
});
t(precioNegativo.status === 400, `Precio negativo → ${precioNegativo.status}`);

console.log(
  fallos === 0
    ? '\n✔ Todo en orden.'
    : `\n✘ ${fallos} comprobación(es) sin pasar.`,
);
if (fallos > 0) process.exitCode = 1;
