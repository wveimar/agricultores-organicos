/**
 * Categorías del catálogo en tabla, editables desde el panel.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-categorias.mjs [http://localhost:8788]
 *
 * Requiere la migración 0013:
 *   npx wrangler d1 execute DB --local --file=worker/migrations/0013_categorias.sql
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
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.142' },
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

console.log(`== Categorías en tabla · ${BASE} ==`);

seccion('1. La tienda las lee de la base, no del código');

const publicas = await fetch(`${BASE}/api/categories`);
const { categories: chips } = await publicas.json();

t(publicas.status === 200, `GET /api/categories → ${publicas.status}`);
t(chips.length >= 10, `Trae las sembradas por la migración: ${chips.length}`);
t(
  chips.every((c) => c.activo === 1),
  'Y solo las activas: una apagada no debe pintar chip',
);
t(
  chips.every((c, i, todas) => i === 0 || todas[i - 1].orden <= c.orden),
  'Vienen ya ordenadas por `orden`, no por id',
);

const verduras = chips.find((c) => c.id === 'verduras');
t(verduras?.grupoAdmin === 'verduras', `El grupo viaja con la fila: ${verduras?.grupoAdmin}`);

// El fallo que motivó todo esto: 'fermentos' se coló como texto libre y sus
// productos no salían bajo ningún chip. Ahora tiene que estar en la lista.
t(
  chips.some((c) => c.id === 'fermentos'),
  'La categoría «fermentos», que llegó por texto libre, ya es una fila',
);

seccion('2. El panel las ve todas, con cuántos productos tienen');

const admin = await api('/api/admin/categories');
t(admin.status === 200, `GET /api/admin/categories → ${admin.status}`);
t(
  admin.body.categories.length >= chips.length,
  'Incluye las desactivadas: es la pantalla desde donde se reactivan',
);
t(
  admin.body.categories.every((c) => typeof c.productos === 'number'),
  'Cada una dice cuántos productos tiene, que es lo que decide si se puede borrar',
);

const verdurasAdmin = admin.body.categories.find((c) => c.id === 'verduras');
t(verdurasAdmin.productos > 0, `«verduras» tiene ${verdurasAdmin.productos} producto(s)`);

seccion('3. Crear');

const sufijo = Date.now();
const creada = await api('/api/admin/categories', {
  method: 'POST',
  body: JSON.stringify({
    nombre: `QA Panadería ${sufijo}`,
    descripcion: 'Horneado el mismo día.',
    grupoAdmin: 'agroindustriales',
    orden: 500,
  }),
});

t(creada.status === 201, `POST → ${creada.status}`);
t(
  /^qa-panaderia-\d+$/.test(creada.body?.category?.id ?? ''),
  `El id sale del nombre, sin tildes: ${creada.body?.category?.id}`,
);

const nuevaId = creada.body.category.id;

const repetida = await api('/api/admin/categories', {
  method: 'POST',
  body: JSON.stringify({ nombre: `QA Panadería ${sufijo}` }),
});
t(
  repetida.body?.error?.code === 'categoria-repetida',
  `Dos con el mismo nombre chocan: ${repetida.body?.error?.code}`,
);

const sinLetras = await api('/api/admin/categories', {
  method: 'POST',
  body: JSON.stringify({ nombre: '!!!' }),
});
t(
  sinLetras.body?.error?.code === 'id-invalido',
  `Un nombre sin letras ni números no da id: ${sinLetras.body?.error?.code}`,
);

const grupoRaro = await api('/api/admin/categories', {
  method: 'POST',
  body: JSON.stringify({ nombre: `QA Grupo ${sufijo}`, grupoAdmin: 'lacteos' }),
});
t(
  grupoRaro.body?.error?.code === 'grupo-invalido',
  `El grupo solo acepta los tres del panel: ${grupoRaro.body?.error?.code}`,
);

seccion('4. Aparece en la tienda en cuanto se crea');

const trasCrear = await (await fetch(`${BASE}/api/categories`)).json();
t(
  trasCrear.categories.some((c) => c.id === nuevaId),
  'Sin recompilar nada: la vitrina ya la ofrece',
);

seccion('5. Editar');

const editada = await api(`/api/admin/categories/${nuevaId}`, {
  method: 'PUT',
  body: JSON.stringify({ nombre: 'QA Panadería fina', orden: 510 }),
});
t(editada.body?.category?.nombre === 'QA Panadería fina', 'Cambia el nombre');
t(editada.body?.category?.orden === 510, 'Y la posición del chip');
t(
  editada.body?.category?.id === nuevaId,
  'El id no se mueve aunque cambie el nombre: es por donde apuntan los productos',
);

// Mandar el id en el cuerpo no debe renombrarlo: sería dejar huérfanos a sus
// productos sin que nadie lo pidiera.
await api(`/api/admin/categories/${nuevaId}`, {
  method: 'PUT',
  body: JSON.stringify({ id: 'otro-id-cualquiera', nombre: 'QA Panadería fina' }),
});
const sigueAhi = await api('/api/admin/categories');
t(
  sigueAhi.body.categories.some((c) => c.id === nuevaId),
  'Mandar `id` en el PUT no la renombra',
);

const vacio = await api(`/api/admin/categories/${nuevaId}`, {
  method: 'PUT',
  body: JSON.stringify({}),
});
t(vacio.body?.error?.code === 'sin-cambios', `Un PUT vacío se rechaza: ${vacio.body?.error?.code}`);

seccion('6. Desactivar la esconde de la tienda sin perder nada');

await api(`/api/admin/categories/${nuevaId}`, {
  method: 'PUT',
  body: JSON.stringify({ activo: 0 }),
});

const apagadas = await (await fetch(`${BASE}/api/categories`)).json();
t(
  !apagadas.categories.some((c) => c.id === nuevaId),
  'Ya no pinta chip en la vitrina',
);

const enPanel = await api('/api/admin/categories');
t(
  enPanel.body.categories.some((c) => c.id === nuevaId),
  'Pero el panel la sigue viendo, que es desde donde se reactiva',
);

await api(`/api/admin/categories/${nuevaId}`, {
  method: 'PUT',
  body: JSON.stringify({ activo: 1 }),
});

seccion('7. No se borra una categoría con productos dentro');

// Se archiva un producto de verdad en la categoría nueva y se intenta borrar.
const producto = await api('/api/admin/products', {
  method: 'POST',
  body: JSON.stringify({
    nombre: `QA Pan ${sufijo}`,
    categoriaId: nuevaId,
    grupoAdmin: 'agroindustriales',
    precio: 6000,
    precioCosto: 3000,
    unidad: 'unidad',
    cantidadUnidad: 1,
    origen: 'QA',
    imagen: 'https://example.test/pan.jpg',
    imagenAlt: 'Imagen de prueba de control de calidad',
  }),
});
t(producto.status === 201, `Archivar un producto en ella → ${producto.status}`);

const conProductos = await api(`/api/admin/categories/${nuevaId}`, { method: 'DELETE' });
t(conProductos.status === 409, `Borrarla ahora → ${conProductos.status}`);
t(
  conProductos.body?.error?.code === 'categoria-en-uso',
  `Con un motivo que se entiende: ${conProductos.body?.error?.code}`,
);
t(
  /\b1\b/.test(conProductos.body?.error?.message ?? ''),
  `Y diciendo cuántos hay que mover: "${conProductos.body?.error?.message}"`,
);

seccion('8. Vaciada, sí se borra');

// Se mueve el producto a otra categoría y se desactiva, para no dejar basura.
await api(`/api/admin/products/${producto.body.product.id}`, {
  method: 'PUT',
  body: JSON.stringify({
    nombre: producto.body.product.nombre,
    categoriaId: 'listos',
    grupoAdmin: 'agroindustriales',
    precio: 6000,
    precioCosto: 3000,
    unidad: 'unidad',
    cantidadUnidad: 1,
    origen: 'QA',
    imagen: 'https://example.test/pan.jpg',
    imagenAlt: 'Imagen de prueba de control de calidad',
  }),
});
await api(`/api/admin/products/${producto.body.product.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 0 }),
});

const borrada = await api(`/api/admin/categories/${nuevaId}`, { method: 'DELETE' });
t(borrada.status === 200, `Ya vacía → ${borrada.status}`);

const otraVez = await api(`/api/admin/categories/${nuevaId}`, { method: 'DELETE' });
t(otraVez.status === 404, `Borrarla dos veces → ${otraVez.status}`);

seccion('9. Quién puede tocarlas');

const sinSesion = await fetch(`${BASE}/api/admin/categories`);
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

const gestor = await login('pedidos@agricultores.co');
if (gestor) {
  const ajeno = await fetch(`${BASE}/api/admin/categories`, {
    headers: { authorization: `Bearer ${gestor}` },
  });
  t(ajeno.status === 403, `Un GESTOR_PEDIDOS no las administra → ${ajeno.status}`);
} else {
  console.log('  · sin cuenta de gestor en esta base, se omite');
}

seccion('10. Limpieza');

const finales = await api('/api/admin/categories');
const restos = finales.body.categories.filter((c) => c.id.startsWith('qa-'));
for (const resto of restos) {
  await api(`/api/admin/categories/${resto.id}`, { method: 'DELETE' });
}
t(true, `Categorías de prueba retiradas: ${restos.length}`);

const intactas = await (await fetch(`${BASE}/api/categories`)).json();
t(
  intactas.categories.some((c) => c.id === 'verduras'),
  'Y las de verdad siguen en su sitio',
);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
