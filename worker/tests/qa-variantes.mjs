/**
 * Variantes de producto: presentaciones (miel) y sabores (kambucha).
 *
 *   npm run worker:dev
 *   node worker/tests/qa-variantes.mjs [http://localhost:8788]
 *
 * Requiere la migración 0012 y el sembrado de ejemplo:
 *   npx wrangler d1 execute DB --local --file=worker/migrations/0012_variantes.sql
 *   npx wrangler d1 execute DB --local --file=worker/seed-variantes.sql
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
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.141' },
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

/** Pedido de invitado. Devuelve el estado y el cuerpo, sin lanzar. */
const pedir = async (items) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Variantes',
      clienteTelefono: '3016066121',
      clienteDireccion: 'Vereda El Rosario, Marinilla',
      // La cédula es obligatoria desde que identifica al cliente. Al azar
      // para no chocar con el índice único entre corridas del script.
      clienteCedula: cedulaQA(),
      envio: 5000,
      items,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const fichaAdmin = async (id) =>
  (await api('/api/admin/products')).body.products.find((p) => p.id === id);

console.log(`== Variantes de producto · ${BASE} ==`);

// ───────────────────────────── Preparación ─────────────────────────────

const catalogo = await publicos();
const madre = catalogo.find((p) => p.id === 'p-miel-base');
const hijas = catalogo.filter((p) => p.parentId === 'p-miel-base');

if (!madre || hijas.length !== 3) {
  console.log('✘ Falta el sembrado de ejemplo. Corre worker/seed-variantes.sql primero.');
  process.exit(1);
}

seccion('1. El catálogo trae el vínculo, no un endpoint aparte');

t(madre.parentId === null, 'La madre no tiene parentId');
t(
  madre.varianteEtiqueta === 'presentación',
  `Y dice qué distingue a sus hijas: "${madre.varianteEtiqueta}"`,
);
t(
  hijas.every((h) => h.parentId === 'p-miel-base'),
  `Las 3 presentaciones apuntan a la madre`,
);
t(
  hijas.every((h) => h.varianteEtiqueta === null),
  'Y ninguna de ellas lleva etiqueta propia (eso es cosa de la madre)',
);
t(
  hijas.map((h) => h.precio).sort((a, b) => a - b).join('/') === '16000/24000/45000',
  'Cada presentación con su precio: 16000/24000/45000',
);
t(madre.stock === 0, 'La madre no tiene inventario: no hay ningún tarro que sea "la miel" a secas');
t(
  hijas.every((h) => h.stock > 0),
  `El inventario vive en las hijas: ${hijas.map((h) => h.stock).join(' + ')}`,
);

const kambucha = catalogo.filter((p) => p.parentId === 'p-kambucha-base');
t(
  kambucha.length === 3 && new Set(kambucha.map((k) => k.precio)).size === 1,
  'Los 3 sabores de kambucha valen lo mismo (la variante no cambia el precio)',
);

seccion('2. La madre no se vende');

const conMadre = await pedir([{ productId: 'p-miel-base', cantidad: 1 }]);
t(conMadre.status === 400, `Pedir la madre → ${conMadre.status}`);
t(
  conMadre.body?.error?.code === 'producto-con-variantes',
  `Con un motivo que se entiende: ${conMadre.body?.error?.code}`,
);
t(
  /presentaciones|variantes/i.test(conMadre.body?.error?.message ?? ''),
  `Y un mensaje que dice qué hacer: "${conMadre.body?.error?.message}"`,
);

seccion('3. La variante sí, y descuenta su propio inventario');

const antes = (await publicos()).find((p) => p.id === 'p-miel-500').stock;
const compra = await pedir([{ productId: 'p-miel-500', cantidad: 2 }]);
t(compra.status === 201 || compra.status === 200, `Pedir 2 de 500 gr → ${compra.status}`);
t(
  compra.body?.order?.subtotal === 48000,
  `Cobra el precio de esa presentación: ${compra.body?.order?.subtotal} (2 × 24000)`,
);

const despues = await publicos();
t(
  despues.find((p) => p.id === 'p-miel-500').stock === antes - 2,
  `El stock de 500 gr baja 2: ${antes} → ${despues.find((p) => p.id === 'p-miel-500').stock}`,
);
t(
  despues.find((p) => p.id === 'p-miel-300').stock === hijas.find((h) => h.id === 'p-miel-300').stock,
  'Y el de 300 gr no se toca: cada presentación tiene su bodega',
);

seccion('4. Un pedido abierto tampoco se puede editar hacia la madre');

const pedido = compra.body.order;
const editado = await api(`/api/admin/orders/${pedido.id}/items`, {
  method: 'PATCH',
  body: JSON.stringify({
    items: [
      { productId: 'p-miel-500', cantidad: 2 },
      { productId: 'p-miel-base', cantidad: 1 },
    ],
  }),
});
t(editado.status === 400, `Añadir la madre a un pedido → ${editado.status}`);
t(
  editado.body?.error?.code === 'producto-con-variantes',
  `Mismo motivo que en la tienda: ${editado.body?.error?.code}`,
);

seccion('5. Solo un nivel de anidamiento');

const nueva = {
  nombre: `QA Variante ${Date.now()}`,
  categoriaId: 'mieles',
  grupoAdmin: 'agroindustriales',
  precio: 5000,
  // `create` lo da por opcional y `updateFull` lo exige: se manda siempre.
  precioCosto: 3000,
  unidad: 'gr',
  cantidadUnidad: 100,
  origen: 'QA',
  imagen: 'https://example.test/qa.jpg',
  imagenAlt: 'Imagen de prueba de control de calidad',
};

const hijaDeHija = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({ ...nueva, parentId: 'p-miel-500' }),
});
t(hijaDeHija.status === 400, `Colgar de una variante → ${hijaDeHija.status}`);
t(
  hijaDeHija.body?.error?.code === 'variante-anidada',
  `Motivo: ${hijaDeHija.body?.error?.code}`,
);

const sinMadre = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({ ...nueva, parentId: 'no-existe' }),
});
t(sinMadre.status === 400, `Colgar de un id inexistente → ${sinMadre.status}`);
t(
  sinMadre.body?.error?.code === 'padre-inexistente',
  `Motivo: ${sinMadre.body?.error?.code}`,
);

const creada = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({ ...nueva, parentId: 'p-miel-base' }),
});
t(creada.status === 201, `Colgar de una madre válida → ${creada.status}`);
t(
  creada.body?.product?.parentId === 'p-miel-base',
  `Y nace ya enganchada: parentId = ${creada.body?.product?.parentId}`,
);

seccion('6. Editar un producto no desengancha sus variantes por descuido');

// El formulario del panel todavía no manda `parentId`. Un PUT sin ese campo no
// puede soltar la variante de su madre: sería perder el vínculo al cambiar un
// precio, y sin que nadie lo viera.
const puesta = await api(`/api/admin/products/${creada.body.product.id}`, {
  method: 'PUT',
  body: JSON.stringify({ ...nueva, precio: 6000 }),
});
t(puesta.status === 200, `PUT sin parentId → ${puesta.status}`);
t(
  puesta.body?.product?.parentId === 'p-miel-base',
  `Sigue colgando de la madre: ${puesta.body?.product?.parentId}`,
);
t(puesta.body?.product?.precio === 6000, 'Y el cambio que sí se pidió se aplicó');

const soltada = await api(`/api/admin/products/${creada.body.product.id}`, {
  method: 'PUT',
  body: JSON.stringify({ ...nueva, parentId: null }),
});
t(
  soltada.body?.product?.parentId === null,
  'Mandar parentId: null explícitamente sí la suelta',
);

seccion('7. La madre no puede ser hija de nadie');

const circular = await api(`/api/admin/products/p-miel-base`, {
  method: 'PUT',
  body: JSON.stringify({
    nombre: madre.nombre,
    categoriaId: madre.categoriaId,
    grupoAdmin: madre.grupoAdmin,
    precio: madre.precio,
    precioCosto: 9900,
    unidad: madre.unidad,
    cantidadUnidad: madre.cantidadUnidad,
    origen: madre.origen,
    imagen: madre.imagen,
    imagenAlt: madre.imagenAlt,
    parentId: 'p-kambucha-base',
  }),
});
t(circular.status === 400, `Convertir en variante algo que ya agrupa variantes → ${circular.status}`);
t(
  circular.body?.error?.code === 'padre-con-variantes',
  `Motivo: ${circular.body?.error?.code}`,
);

const siMisma = await api(`/api/admin/products/p-kambucha-base`, {
  method: 'PUT',
  body: JSON.stringify({
    nombre: 'Kambucha',
    categoriaId: 'listos',
    grupoAdmin: 'agroindustriales',
    precio: 12000,
    precioCosto: 7200,
    unidad: 'mililitro',
    cantidadUnidad: 350,
    origen: 'Fermentario La Cascada · Marinilla',
    imagen: 'https://example.test/k.jpg',
    imagenAlt: 'Botella de kambucha',
    parentId: 'p-kambucha-base',
  }),
});
t(siMisma.status === 400, `Ser variante de sí misma → ${siMisma.status}`);
t(
  siMisma.body?.error?.code === 'variante-circular',
  `Motivo: ${siMisma.body?.error?.code}`,
);

seccion('8. Lo que manda el formulario del panel');

// El formulario de Inventario manda siempre los dos campos, y limpia la
// etiqueta al colgar el producto de una madre. Esta sección fija ese contrato:
// si cambia el formulario sin cambiar el Worker, se entera aquí.

const conEtiqueta = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({
    ...nueva,
    nombre: `QA Madre ${Date.now()}`,
    parentId: null,
    varianteEtiqueta: 'tamaño',
  }),
});
t(conEtiqueta.status === 201, `Crear una ficha madre con su etiqueta → ${conEtiqueta.status}`);
t(
  conEtiqueta.body?.product?.varianteEtiqueta === 'tamaño',
  `La etiqueta se guarda: "${conEtiqueta.body?.product?.varianteEtiqueta}"`,
);
t(
  conEtiqueta.body?.product?.parentId === null,
  'Y sigue siendo una ficha suelta, lista para agrupar',
);

const madreQa = conEtiqueta.body.product;

// Ahora se le cuelga una variante, como haría «Añadir variante».
const variante = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({
    ...nueva,
    nombre: `${madreQa.nombre} · 500 gr`,
    parentId: madreQa.id,
    varianteEtiqueta: null,
  }),
});
t(variante.status === 201, `Colgarle una variante → ${variante.status}`);

// Y se intenta convertir la madre en variante: ya no se puede, porque tiene
// hijas. Es exactamente lo que el formulario esconde al ver que es madre.
const yaNoPuede = await api(`/api/admin/products/${madreQa.id}`, {
  method: 'PUT',
  body: JSON.stringify({ ...nueva, nombre: madreQa.nombre, parentId: 'p-miel-base' }),
});
t(
  yaNoPuede.body?.error?.code === 'padre-con-variantes',
  `La ficha madre ya no se puede colgar de nadie: ${yaNoPuede.body?.error?.code}`,
);

// Guardar la madre sin tocar el vínculo mantiene su etiqueta.
const reguardada = await api(`/api/admin/products/${madreQa.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    ...nueva,
    nombre: madreQa.nombre,
    parentId: null,
    varianteEtiqueta: 'tamaño',
  }),
});
t(
  reguardada.body?.product?.varianteEtiqueta === 'tamaño',
  'Reguardarla conserva la etiqueta',
);

// Y al soltar una variante de su madre, la etiqueta se queda a null: el
// formulario la limpia porque en una ficha hija no significa nada.
const soltadaLimpia = await api(`/api/admin/products/${variante.body.product.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    ...nueva,
    nombre: variante.body.product.nombre,
    parentId: null,
    varianteEtiqueta: null,
  }),
});
t(
  soltadaLimpia.body?.product?.parentId === null &&
    soltadaLimpia.body?.product?.varianteEtiqueta === null,
  'Soltar una variante la deja suelta y sin etiqueta muerta',
);

for (const id of [madreQa.id, variante.body.product.id]) {
  await api(`/api/admin/products/${id}`, { method: 'PATCH', body: JSON.stringify({ activo: 0 }) });
}

seccion('9. Limpieza');

// La creada en la sección 5 queda desactivada para no ensuciar el catálogo. No
// se borra: `order_items` podría apuntarla si alguien corre esto dos veces.
const apagada = await api(`/api/admin/products/${creada.body.product.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 0 }),
});
t(apagada.status === 200, 'El producto de prueba queda desactivado');

const restaurada = await fichaAdmin('p-miel-base');
t(restaurada?.parentId === null, 'Y la madre de la miel sigue siendo madre');

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
