/**
 * Precios de mayorista: tarifas, precio efectivo y cobro real.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-mayoristas.mjs [http://localhost:8788]
 *
 * Requiere la migración 0011 aplicada y una cuenta SUPER_ADMIN de siembra.
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

let ip = 100;
const login = async (email, password = 'demo1234') => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++}` },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  return body.token ?? null;
};

const admin = { authorization: `Bearer ${await login('admin@agricultores.co')}`, 'content-type': 'application/json' };

const api = async (p, init = {}, headers = admin) => {
  const res = await fetch(`${BASE}${p}`, { headers, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const publicos = async (token) =>
  (
    await (
      await fetch(`${BASE}/api/products`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    ).json()
  ).products;

/** La misma fórmula que `worker/src/pricing.ts` y `core/models/pricing.ts`. */
const esperado = (precio, pct) => (pct <= 0 ? precio : Math.round((precio * (100 - Math.min(pct, 100))) / 100));

console.log(`== Precios de mayorista · ${BASE} ==`);

// ─────────────────────────── Preparación ───────────────────────────

const catalogo = await publicos();
const producto = catalogo.find((p) => p.stock > 10 && p.precio > 3_000);
const otro = catalogo.find((p) => p.id !== producto.id && p.stock > 10 && p.precio > 3_000);

if (!producto || !otro) {
  console.log('✘ El catálogo sembrado no tiene productos suficientes.');
  process.exit(1);
}

// Una cuenta de mayorista nivel 2, creada para la prueba.
const correo = `qa-mayorista-${Date.now()}@agricultores.co`;
const alta = await api('/api/admin/users', {
  method: 'POST',
  body: JSON.stringify({
    email: correo,
    nombre: 'QA Mayorista',
    password: 'demo1234',
    roles: ['MAYORISTA_N2'],
  }),
});

seccion('1. El rol de mayorista se puede asignar');
t(alta.status === 201 || alta.status === 200, `Alta de cuenta con MAYORISTA_N2 → ${alta.status}`);
t(
  (alta.body?.user?.roles ?? []).includes('MAYORISTA_N2'),
  `La cuenta queda con el rol: ${JSON.stringify(alta.body?.user?.roles)}`,
);

const tokenMayorista = await login(correo);
t(tokenMayorista !== null, 'La cuenta de mayorista puede iniciar sesión');

// ─────────────────────────── Tarifas ───────────────────────────

seccion('2. Fijar una tarifa');

const tarifa = await api(`/api/admin/wholesale/MAYORISTA_N2/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 20 }),
});
t(tarifa.status === 200, `PUT descuento 20 % → ${tarifa.status}`);
t(
  tarifa.body?.precioMayorista === esperado(producto.precio, 20),
  `Precio calculado: ${tarifa.body?.precioMayorista} (esperado ${esperado(producto.precio, 20)})`,
);

const listado = await api('/api/admin/wholesale/MAYORISTA_N2');
t(listado.status === 200, `GET tarifas del nivel → ${listado.status}`);
t(
  listado.body.products.length === catalogo.length ||
    listado.body.products.length >= catalogo.length,
  `Devuelve el catálogo completo, no solo lo que tiene tarifa: ${listado.body.products.length} filas`,
);
const fila = listado.body.products.find((p) => p.productId === producto.id);
t(fila?.porcentaje === 20, `La fila del producto trae su descuento: ${fila?.porcentaje}`);
t(
  listado.body.products.some((p) => p.porcentaje === null),
  'Y los productos sin trato especial vienen con porcentaje null',
);

seccion('3. Validaciones de la tarifa');

const negativo = await api(`/api/admin/wholesale/MAYORISTA_N2/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: -5 }),
});
t(negativo.status === 400, `Porcentaje negativo → ${negativo.status}`);

const excesivo = await api(`/api/admin/wholesale/MAYORISTA_N2/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 150 }),
});
t(excesivo.status === 400, `Porcentaje > 100 → ${excesivo.status}`);

const nivelMalo = await api(`/api/admin/wholesale/MAYORISTA_N9/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 10 }),
});
t(nivelMalo.status === 400, `Nivel inexistente → ${nivelMalo.status}`);

const productoMalo = await api('/api/admin/wholesale/MAYORISTA_N2/no-existe-jamas', {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 10 }),
});
t(productoMalo.status === 404, `Producto inexistente → ${productoMalo.status}`);

// ─────────────────────────── Catálogo público ───────────────────────────

seccion('4. El catálogo devuelve el precio de cada quien');

const comoInvitado = (await publicos()).find((p) => p.id === producto.id);
t(
  comoInvitado.precioMayorista === undefined,
  'Sin sesión no llega ningún precio de mayorista',
);
t(comoInvitado.precio === producto.precio, `Y el precio es el de lista: ${comoInvitado.precio}`);

const comoMayorista = (await publicos(tokenMayorista)).find((p) => p.id === producto.id);
t(
  comoMayorista.precioMayorista === esperado(producto.precio, 20),
  `Con sesión de mayorista llega su precio: ${comoMayorista.precioMayorista}`,
);
t(comoMayorista.descuentoMayorista === 20, `Y el porcentaje aplicado: ${comoMayorista.descuentoMayorista}`);

const sinTarifa = (await publicos(tokenMayorista)).find((p) => p.id === otro.id);
t(
  sinTarifa.precioMayorista === undefined,
  'Un producto sin tarifa no trae precio especial ni para el mayorista',
);

// Un admin NO es mayorista: `requireRole` deja pasar a SUPER_ADMIN por
// cualquier puerta, y esa escalada no debe alcanzar a los precios.
const comoAdmin = (await publicos(admin.authorization.slice('Bearer '.length))).find(
  (p) => p.id === producto.id,
);
t(
  comoAdmin.precioMayorista === undefined,
  'SUPER_ADMIN no recibe precio de mayorista (la escalada de roles no llega al precio)',
);

// ─────────────────────────── El cobro real ───────────────────────────

seccion('5. El pedido se cobra al precio del servidor');

const pedir = async (token, items) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      clienteNombre: 'QA Precio',
      clienteTelefono: '3016066121',
      clienteDireccion: 'Vereda El Rosario, Marinilla',
      // La cédula es obligatoria desde que identifica al cliente. Al azar
      // para no chocar con el índice único entre corridas del script.
      clienteCedula: cedulaQA(),
      envio: 0,
      items,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const pedidoInvitado = await pedir(null, [{ productId: producto.id, cantidad: 2 }]);
t(pedidoInvitado.status === 201, `Pedido de invitado → ${pedidoInvitado.status}`);
t(
  pedidoInvitado.body.order.subtotal === producto.precio * 2,
  `Invitado paga precio de lista: ${pedidoInvitado.body.order.subtotal}`,
);

const pedidoMayorista = await pedir(tokenMayorista, [{ productId: producto.id, cantidad: 2 }]);
t(pedidoMayorista.status === 201, `Pedido de mayorista → ${pedidoMayorista.status}`);
t(
  pedidoMayorista.body.order.subtotal === esperado(producto.precio, 20) * 2,
  `Mayorista paga con descuento: ${pedidoMayorista.body.order.subtotal} ` +
    `(esperado ${esperado(producto.precio, 20) * 2})`,
);
t(
  pedidoMayorista.body.order.items[0].precioUnitario === esperado(producto.precio, 20),
  `La línea congela el precio cobrado, no el de lista: ${pedidoMayorista.body.order.items[0].precioUnitario}`,
);

seccion('6. El envío se calcula sobre el subtotal ya descontado');

t(
  pedidoMayorista.body.order.envio ===
    (pedidoMayorista.body.order.subtotal >= UMBRAL_GRATIS ? 0 : COSTO_ENVIO),
  `Envío coherente con el subtotal real: ${pedidoMayorista.body.order.envio}`,
);
t(
  pedidoMayorista.body.order.total ===
    pedidoMayorista.body.order.subtotal + pedidoMayorista.body.order.envio,
  'Total = subtotal + envío',
);

// El cliente manda un envío que no le corresponde: el servidor lo ignora.
const conEnvioFalso = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA Envío falso',
    clienteTelefono: '3016066121',
    clienteDireccion: 'Marinilla',
    // La cédula es obligatoria desde que identifica al cliente. Al azar
    // para no chocar con el índice único entre corridas del script.
    clienteCedula: cedulaQA(),
    envio: 0,
    items: [{ productId: producto.id, cantidad: 1 }],
  }),
});
const cuerpoFalso = await conEnvioFalso.json();
const subtotalFalso = cuerpoFalso.order.subtotal;
t(
  cuerpoFalso.order.envio === (subtotalFalso >= UMBRAL_GRATIS ? 0 : COSTO_ENVIO),
  `Un "envio: 0" del cliente sobre un pedido pequeño se ignora: cobra ${cuerpoFalso.order.envio}`,
);

seccion('7. Un token manipulado no da descuento');

const tokenRoto = tokenMayorista.slice(0, -6) + 'AAAAAA';
const conTokenRoto = await pedir(tokenRoto, [{ productId: producto.id, cantidad: 1 }]);
t(conTokenRoto.status === 201, `Un token inválido no rompe la compra → ${conTokenRoto.status}`);
t(
  conTokenRoto.body.order.subtotal === producto.precio,
  `Pero se cobra precio de lista: ${conTokenRoto.body.order.subtotal}`,
);

seccion('8. Retirar la tarifa');

const retirada = await api(`/api/admin/wholesale/MAYORISTA_N2/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 0 }),
});
t(retirada.status === 200, `PUT porcentaje 0 → ${retirada.status}`);
t(retirada.body?.porcentaje === null, 'Devuelve porcentaje null: la fila se borró');

const trasRetirar = (await publicos(tokenMayorista)).find((p) => p.id === producto.id);
t(
  trasRetirar.precioMayorista === undefined,
  'Y el mayorista vuelve a ver el precio de lista',
);

const pedidoSinTarifa = await pedir(tokenMayorista, [{ productId: producto.id, cantidad: 1 }]);
t(
  pedidoSinTarifa.body.order.subtotal === producto.precio,
  `También al cobrar: ${pedidoSinTarifa.body.order.subtotal}`,
);

seccion('9. Aplicación masiva');

const masiva = await api('/api/admin/wholesale/MAYORISTA_N3', {
  method: 'PUT',
  body: JSON.stringify({ productIds: [producto.id, otro.id], porcentaje: 15 }),
});
t(masiva.status === 200, `PUT masivo → ${masiva.status}`);
t(masiva.body?.aplicados === 2, `Aplicado a 2 productos: ${masiva.body?.aplicados}`);

const tarifaN3 = await api('/api/admin/wholesale/MAYORISTA_N3');
const conDescuentoN3 = tarifaN3.body.products.filter((p) => p.porcentaje === 15);
t(conDescuentoN3.length === 2, `El nivel N3 queda con 2 tarifas al 15 %: ${conDescuentoN3.length}`);

// El nivel N2 no se tocó: las tarifas son independientes entre niveles.
const tarifaN2 = await api('/api/admin/wholesale/MAYORISTA_N2');
const otroEnN2 = tarifaN2.body.products.find((p) => p.productId === otro.id);
t(otroEnN2?.porcentaje === null, 'Y el nivel N2 sigue sin tarifa para ese producto');

const masivaVacia = await api('/api/admin/wholesale/MAYORISTA_N3', {
  method: 'PUT',
  body: JSON.stringify({ productIds: [], porcentaje: 10 }),
});
t(masivaVacia.status === 400, `Lista vacía → ${masivaVacia.status}`);

const masivaConFantasma = await api('/api/admin/wholesale/MAYORISTA_N3', {
  method: 'PUT',
  body: JSON.stringify({ productIds: [producto.id, 'fantasma-qa'], porcentaje: 10 }),
});
t(masivaConFantasma.status === 400, `Con un producto inexistente → ${masivaConFantasma.status}`);
const siguePuesto = (await api('/api/admin/wholesale/MAYORISTA_N3')).body.products.find(
  (p) => p.productId === producto.id,
);
t(
  siguePuesto?.porcentaje === 15,
  `Y no se aplicó nada a medias: sigue en 15 %, no en 10 (${siguePuesto?.porcentaje})`,
);

seccion('10. Varios niveles a la vez: gana el mejor descuento');

await api(`/api/admin/wholesale/MAYORISTA_N1/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 5 }),
});
await api(`/api/admin/wholesale/MAYORISTA_N2/${producto.id}`, {
  method: 'PUT',
  body: JSON.stringify({ porcentaje: 30 }),
});

const dobleNivel = await api(`/api/admin/users/${alta.body.user.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ roles: ['MAYORISTA_N1', 'MAYORISTA_N2'] }),
});
t(dobleNivel.status === 200, `Cuenta con dos niveles → ${dobleNivel.status}`);

const tokenDoble = await login(correo);
const conDosNiveles = (await publicos(tokenDoble)).find((p) => p.id === producto.id);
t(
  conDosNiveles.descuentoMayorista === 30,
  `Se aplica el mayor de los dos (5 % y 30 %): ${conDosNiveles.descuentoMayorista}`,
);

seccion('11. Permisos');

const sinSesion = await fetch(`${BASE}/api/admin/wholesale/MAYORISTA_N2`);
t(sinSesion.status === 401, `Ver tarifas sin sesión → ${sinSesion.status}`);

const tokenInventario = await login('inventario@agricultores.co');
const conInventario = await fetch(`${BASE}/api/admin/wholesale/MAYORISTA_N2`, {
  headers: { authorization: `Bearer ${tokenInventario}` },
});
t(conInventario.status === 403, `ADMIN_INVENTARIO no ve las tarifas → ${conInventario.status}`);

const mayoristaMirando = await fetch(`${BASE}/api/admin/wholesale/MAYORISTA_N2`, {
  headers: { authorization: `Bearer ${tokenDoble}` },
});
t(
  mayoristaMirando.status === 403,
  `Un mayorista no puede ver las tarifas de nadie → ${mayoristaMirando.status}`,
);

const mayoristaEditando = await fetch(`${BASE}/api/admin/wholesale/MAYORISTA_N3/${producto.id}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${tokenDoble}`, 'content-type': 'application/json' },
  body: JSON.stringify({ porcentaje: 99 }),
});
t(
  mayoristaEditando.status === 403,
  `Ni ponerse descuento a sí mismo → ${mayoristaEditando.status}`,
);

seccion('12. Redondeo al peso');

for (const [precio, pct] of [
  [3333, 15],
  [1999, 33],
  [10_001, 7],
  [4500, 100],
  [2500, 1],
]) {
  const calculado = esperado(precio, pct);
  t(
    Number.isInteger(calculado) && calculado >= 0 && calculado <= precio,
    `${precio} con −${pct} % = ${calculado} (entero, entre 0 y el precio)`,
  );
}

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
