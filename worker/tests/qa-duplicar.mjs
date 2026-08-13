/**
 * Duplicado de productos.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-duplicar.mjs [http://localhost:8788]
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
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.90' },
        body: JSON.stringify({ email, password: 'demo1234' }),
      })
    ).json()
  ).token;

const TOKEN = await login('inventario@agricultores.co');
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { headers: H, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log(`== Duplicar productos · ${BASE} ==`);

// Se parte de un producto con datos "gastados": stock, valoraciones y activo.
const { body: inv } = await api('/api/admin/products');
const original = inv.products.find((p) => p.stock > 0 && p.reviewCount > 0 && p.activo === 1);
console.log(
  `   Original: ${original.nombre} · stock ${original.stock} · ${original.reviewCount} valoraciones`,
);

seccion('1. Qué se copia y qué no');

const { status, body } = await api(`/api/admin/products/${original.id}/duplicar`, {
  method: 'POST',
});
const copia = body?.product;

t(status === 201, `Duplicado → ${status}`);
t(copia?.id !== original.id, 'Recibe un id nuevo');
t(copia?.slug === `${original.slug}-copia`, `Slug provisional: ${copia?.slug}`);
t(copia?.nombre === `${original.nombre} (copia)`, `Nombre marcado: ${copia?.nombre}`);

t(copia?.stock === 0, `Las existencias arrancan en 0 (eran ${original.stock})`);
t(copia?.activo === 0, 'Nace retirada de la venta, no a medio hacer en la tienda');
t(
  copia?.reviewCount === 0 && copia?.rating === 0,
  `Sin heredar valoraciones ajenas (el original tenía ${original.reviewCount})`,
);

seccion('2. Lo que sí debe venir igual');

for (const campo of [
  'precio',
  'precioCosto',
  'unidad',
  'cantidadUnidad',
  'origen',
  'categoriaId',
  'grupoAdmin',
  'imagen',
  'imagenAlt',
  'tagline',
]) {
  t(copia?.[campo] === original[campo], `${campo}: ${JSON.stringify(copia?.[campo])}`);
}

seccion('3. No aparece en la tienda hasta activarla');

const { products: publicos } = await (await fetch(`${BASE}/api/products`)).json();
t(
  !publicos.some((p) => p.id === copia.id),
  'La copia no sale en el catálogo público',
);

seccion('4. Duplicar dos veces seguidas');

const { body: segunda } = await api(`/api/admin/products/${original.id}/duplicar`, {
  method: 'POST',
});
t(
  segunda?.product?.slug === `${original.slug}-copia-2`,
  `La segunda copia no choca con la primera: ${segunda?.product?.slug}`,
);

const { body: tercera } = await api(`/api/admin/products/${original.id}/duplicar`, {
  method: 'POST',
});
t(tercera?.product?.slug === `${original.slug}-copia-3`, `Y la tercera: ${tercera?.product?.slug}`);

seccion('5. Permisos y errores');

const tokenPedidos = await login('pedidos@agricultores.co');
const ajeno = await fetch(`${BASE}/api/admin/products/${original.id}/duplicar`, {
  method: 'POST',
  headers: { authorization: `Bearer ${tokenPedidos}` },
});
t(ajeno.status === 403, `GESTOR_PEDIDOS no puede duplicar → ${ajeno.status}`);

const sinSesion = await fetch(`${BASE}/api/admin/products/${original.id}/duplicar`, {
  method: 'POST',
});
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

const inexistente = await api('/api/admin/products/no-existe/duplicar', { method: 'POST' });
t(inexistente.status === 404, `Producto inexistente → ${inexistente.status}`);

seccion('6. La copia se puede terminar y publicar');

const listo = await api(`/api/admin/products/${copia.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    nombre: 'Variante terminada QA',
    slug: 'variante-terminada-qa-' + Date.now(),
    categoriaId: copia.categoriaId,
    grupoAdmin: copia.grupoAdmin,
    precio: copia.precio,
    precioCosto: copia.precioCosto,
    unidad: copia.unidad,
    cantidadUnidad: copia.cantidadUnidad,
    origen: copia.origen,
    imagen: copia.imagen,
    imagenAlt: copia.imagenAlt,
  }),
});
t(listo.status === 200, `Se edita como cualquier otro → ${listo.status}`);

const activada = await api(`/api/admin/products/${copia.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 1, stock: 12 }),
});
t(
  activada.body?.product?.activo === 1 && activada.body?.product?.stock === 12,
  'Y se activa con su propio inventario, independiente del original',
);

const { body: invFinal } = await api('/api/admin/products');
const originalAhora = invFinal.products.find((p) => p.id === original.id);
t(
  originalAhora.stock === original.stock,
  `El original conserva su stock: ${originalAhora.stock}`,
);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
