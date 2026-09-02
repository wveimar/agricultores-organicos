/**
 * Compras a fincas (migración 0021).
 *
 * Lo que hay que comprobar aquí es que el inventario y la contabilidad no se
 * separen nunca: registrar sube el stock y fija el costo, editar ajusta la
 * diferencia, borrar la devuelve — y ninguna de las tres puede dejar el
 * inventario diciendo algo que no es. La prueba central es la última: que
 * borrar una compra cuya mercancía ya se vendió se rechace con un mensaje
 * útil, en vez de dejar stock negativo o reventar con un 500.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-compras.mjs [http://localhost:8788]
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
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.31' },
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

const RUTA = '/api/admin/providers/purchases';

/** El producto tal como lo ve el panel ahora mismo. */
const producto = async (id) => {
  const { body } = await api('/api/admin/products');
  return body?.products?.find((p) => p.id === id) ?? null;
};

// ─────────────────────── Elegir un producto de prueba ───────────────────────

seccion('Preparando');

const { body: catalogo } = await api('/api/admin/products');
// Sin variantes y sin ser canasta: los dos casos tienen stock derivado y la
// compra debe rechazarlos (se prueba más abajo).
const objetivo = catalogo.products.find(
  (p) => !p.tieneVariantes && p.stock > 0 && p.precioCosto > 0 && p.origen,
);
t(!!objetivo, `producto de prueba: ${objetivo?.nombre} (${objetivo?.origen})`);

if (!objetivo) {
  console.log('\n✘ Sin producto utilizable, no se puede seguir.');
  process.exit(1);
}

const stockInicial = objetivo.stock;
const costoInicial = objetivo.precioCosto;
console.log(`  · stock inicial ${stockInicial} · costo ${cop(costoInicial)}`);

// ─────────────────────────── Registrar la compra ───────────────────────────

seccion('Registrar una compra sube el inventario');

const COMPRA = 40;
const COSTO_NUEVO = costoInicial + 350;

const { status: sCrear, body: bCrear } = await post(RUTA, {
  origen: objetivo.origen,
  notas: 'QA compra inicial',
  items: [{ productId: objetivo.id, cantidad: COMPRA, costoUnitario: COSTO_NUEVO }],
});

t(sCrear === 201, `crea la compra (${sCrear})`);

const compra = bCrear?.compra;
t(compra?.estado === 'pendiente', `nace pendiente de pago (${compra?.estado})`);
t(
  compra?.totalPago === COMPRA * COSTO_NUEVO,
  `total calculado en el servidor: ${cop(compra?.totalPago)} (esperado ${cop(COMPRA * COSTO_NUEVO)})`,
);
t(compra?.items?.length === 1, `guarda el detalle (${compra?.items?.length} línea)`);

const trasCompra = await producto(objetivo.id);
t(
  trasCompra.stock === stockInicial + COMPRA,
  `stock: ${stockInicial} → ${trasCompra.stock} (esperado ${stockInicial + COMPRA})`,
);
t(
  trasCompra.precioCosto === COSTO_NUEVO,
  `precio_costo se actualiza al costo comprado: ${cop(trasCompra.precioCosto)}`,
);

// ────────────────────────── Validaciones del servidor ──────────────────────────

seccion('El servidor no se fía del navegador');

const { status: sVacia } = await post(RUTA, {
  origen: objetivo.origen,
  items: [],
});
t(sVacia === 400, `una compra sin líneas se rechaza (${sVacia})`);

const { status: sCero } = await post(RUTA, {
  origen: objetivo.origen,
  items: [{ productId: objetivo.id, cantidad: 0, costoUnitario: 100 }],
});
t(sCero === 400, `cantidad 0 se rechaza antes del CHECK de D1 (${sCero})`);

const { status: sRepe } = await post(RUTA, {
  origen: objetivo.origen,
  items: [
    { productId: objetivo.id, cantidad: 1, costoUnitario: 100 },
    { productId: objetivo.id, cantidad: 2, costoUnitario: 100 },
  ],
});
t(sRepe === 400, `el mismo producto dos veces se rechaza (${sRepe})`);

// Una canasta CON receta no tiene stock propio: su disponibilidad se calcula
// desde los componentes, así que sumarle unidades sería escribir en una
// columna que nadie lee. Ojo: una canasta SIN receta sí usa su `stock_actual`
// como cualquier producto, y comprarla es legítimo — por eso hay que darle
// una receta antes de probar la guardia, o se estaría probando otra cosa.
const canasta = catalogo.products.find((p) => p.categoriaId === 'canastas');
if (canasta) {
  const relleno = catalogo.products.find(
    (p) => p.id !== canasta.id && p.categoriaId !== 'canastas' && !p.tieneVariantes,
  );

  const { status: sReceta } = await api(`/api/admin/products/${canasta.id}/componentes`, {
    method: 'PUT',
    body: JSON.stringify({ childId: relleno.id, cantidad: 2 }),
  });
  t(sReceta === 200, `se le define receta a "${canasta.nombre}" (${sReceta})`);

  const { status: sCanasta, body: bCanasta } = await post(RUTA, {
    origen: canasta.origen,
    items: [{ productId: canasta.id, cantidad: 1, costoUnitario: 1000 }],
  });
  t(
    sCanasta === 400 && bCanasta?.error?.code === 'canasta-sin-stock',
    `comprar una canasta con receta se rechaza (${sCanasta}, ${bCanasta?.error?.code})`,
  );
  console.log(`  · mensaje: «${bCanasta?.error?.message}»`);
} else {
  console.log('  · sin canastas en el catálogo, se omite esa comprobación');
}

// ──────────────────────────────── Editar ────────────────────────────────

seccion('Editar ajusta la diferencia de inventario');

const NUEVA_CANTIDAD = 25;
const { status: sEditar, body: bEditar } = await patch(`${RUTA}/${compra.id}`, {
  origen: objetivo.origen,
  notas: 'QA compra corregida',
  items: [{ productId: objetivo.id, cantidad: NUEVA_CANTIDAD, costoUnitario: COSTO_NUEVO }],
});

t(sEditar === 200, `edita la compra (${sEditar})`);
t(
  bEditar?.compra?.totalPago === NUEVA_CANTIDAD * COSTO_NUEVO,
  `el total se recalcula: ${cop(bEditar?.compra?.totalPago)}`,
);

const trasEditar = await producto(objetivo.id);
t(
  trasEditar.stock === stockInicial + NUEVA_CANTIDAD,
  `stock ajustado a la baja: ${trasCompra.stock} → ${trasEditar.stock} (esperado ${stockInicial + NUEVA_CANTIDAD})`,
);

// ──────────────────────────────── Borrar ────────────────────────────────

seccion('Borrar devuelve el inventario');

const { status: sBorrar } = await del(`${RUTA}/${compra.id}`);
t(sBorrar === 200, `borra la compra (${sBorrar})`);

const trasBorrar = await producto(objetivo.id);
t(
  trasBorrar.stock === stockInicial,
  `stock vuelve al inicial: ${trasEditar.stock} → ${trasBorrar.stock} (esperado ${stockInicial})`,
);

// ────────────── Lo importante: no dejar el inventario mintiendo ──────────────

seccion('Una compra ya vendida no se puede deshacer');

// Se compra poco y se vende todo: al intentar borrar, el inventario no da.
const { body: bChica } = await post(RUTA, {
  origen: objetivo.origen,
  items: [{ productId: objetivo.id, cantidad: 5, costoUnitario: COSTO_NUEVO }],
});
const chica = bChica?.compra;

const conStock = await producto(objetivo.id);

// Un pedido que se lleva TODO el inventario, aprobado para que descuente.
const resPedido = await fetch(`${BASE}/api/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    clienteNombre: 'QA Compras',
    clienteTelefono: '3000000009',
    clienteDireccion: 'Bodega QA',
    // La cédula es obligatoria desde que identifica al cliente. Al azar
    // para no chocar con el índice único entre corridas del script.
    clienteCedula: cedulaQA(),
    items: [{ productId: objetivo.id, cantidad: conStock.stock }],
  }),
});
const { order } = await resPedido.json();
await post(`/api/admin/orders/${order.id}/aprobar`, { token: crypto.randomUUID() });

const vacio = await producto(objetivo.id);
t(vacio.stock === 0, `el pedido se llevó todo el stock (queda ${vacio.stock})`);

const { status: sBloqueo, body: bBloqueo } = await del(`${RUTA}/${chica.id}`);
t(
  sBloqueo === 409 && bBloqueo?.error?.code === 'stock-ya-vendido',
  `borrar se rechaza con 409 y código propio (${sBloqueo}, ${bBloqueo?.error?.code})`,
);
t(
  typeof bBloqueo?.error?.details?.disponibles === 'number',
  `el error dice cuánto queda: ${JSON.stringify(bBloqueo?.error?.details)}`,
);
console.log(`  · mensaje: «${bBloqueo?.error?.message}»`);

const trasIntento = await producto(objetivo.id);
t(trasIntento.stock === 0, `el stock no se movió tras el rechazo (${trasIntento.stock})`);

// ─────────────────────────── Confirmar el pago ───────────────────────────

seccion('Confirmar el pago');

const { status: sPagar, body: bPagar } = await post(`${RUTA}/${chica.id}/pagar`);
t(sPagar === 200, `marca la compra como pagada (${sPagar})`);
t(bPagar?.compra?.estado === 'pagado', `estado = ${bPagar?.compra?.estado}`);
t(!!bPagar?.compra?.pagadoEn, 'guarda cuándo se pagó');

const { status: sOtra } = await post(`${RUTA}/${chica.id}/pagar`);
t(sOtra === 409, `un segundo clic no vuelve a pagar (${sOtra})`);

const { status: sEditarPagada } = await patch(`${RUTA}/${chica.id}`, {
  origen: objetivo.origen,
  items: [{ productId: objetivo.id, cantidad: 1, costoUnitario: 100 }],
});
t(sEditarPagada === 409, `una compra pagada ya no se edita (${sEditarPagada})`);

const { status: sBorrarPagada } = await del(`${RUTA}/${chica.id}`);
t(sBorrarPagada === 409, `una compra pagada ya no se borra (${sBorrarPagada})`);

// ──────────────────────────────── Listado ────────────────────────────────

seccion('Historial y filtros');

const { body: bTodas } = await api(RUTA);
t((bTodas?.compras?.length ?? 0) > 0, `lista las compras (${bTodas?.compras?.length})`);
t(
  bTodas?.compras?.every((c) => Array.isArray(c.items)),
  'cada compra trae su detalle, sin una segunda petición',
);

const { body: bPagadas } = await api(`${RUTA}?estado=pagado`);
t(
  (bPagadas?.compras ?? []).every((c) => c.estado === 'pagado'),
  `el filtro por estado funciona (${bPagadas?.compras?.length} pagadas)`,
);

const { body: bOrigen } = await api(`${RUTA}?origen=${encodeURIComponent(objetivo.origen)}`);
t(
  (bOrigen?.compras ?? []).every((c) => c.origen === objetivo.origen),
  `el filtro por finca funciona (${bOrigen?.compras?.length} de "${objetivo.origen}")`,
);

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
