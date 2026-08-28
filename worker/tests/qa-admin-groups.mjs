/**
 * Grupos del panel de compras (migración 0025).
 *
 * Eran tres literales fijos —'frutas' / 'verduras' / 'agroindustriales'—
 * repetidos en un CHECK de `products`, otro de `categories` y un tipo de
 * TypeScript. Ahora son filas de `admin_groups`, editables desde el panel.
 *
 * Lo que se comprueba:
 *  · Los tres de siempre siguen ahí, sembrados por la migración.
 *  · Se puede crear uno nuevo, con id propio y la casilla de filtro fino.
 *  · Un producto y una categoría pueden usar ese grupo nuevo — es lo que
 *    demuestra que el CHECK de verdad se quitó del camino de escritura.
 *  · No se puede borrar un grupo en uso; sí uno vacío.
 *  · No se puede repetir el identificador.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-admin-groups.mjs [http://localhost:8788]
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
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.81' },
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
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) });
const put = (p, body) => api(p, { method: 'PUT', body: JSON.stringify(body) });
const del = (p) => api(p, { method: 'DELETE' });

const marca = Date.now();

// ─────────────────────────── Lo sembrado ───────────────────────────

seccion('Los tres de siempre');

const { body: bLista } = await api('/api/admin/admin-groups');
const grupos = bLista?.grupos ?? [];

t(grupos.length >= 3, `hay al menos los tres sembrados (${grupos.length})`);
const agro = grupos.find((g) => g.id === 'agroindustriales');
t(!!agro, 'existe "agroindustriales"');
t(agro?.mostrarFiltroFino === 1, 'con el filtro fino encendido');
t(
  grupos.find((g) => g.id === 'frutas')?.mostrarFiltroFino === 0,
  '"frutas" lo tiene apagado',
);

// ─────────────────────────── Crear uno nuevo ───────────────────────────

seccion('Crear un grupo nuevo');

const { status: sCrear, body: bCrear } = await post('/api/admin/admin-groups', {
  nombre: `QA Lácteos ${marca}`,
  mostrarFiltroFino: true,
  orden: 999,
});

t(sCrear === 201, `se crea (${sCrear})`);
const grupo = bCrear?.grupo;
t(!!grupo?.id && grupo.id !== 'agroindustriales', `con id propio: "${grupo?.id}"`);
t(grupo?.mostrarFiltroFino === 1, 'con el filtro fino que se pidió');

const { status: sRepe, body: bRepe } = await post('/api/admin/admin-groups', {
  id: grupo.id,
  nombre: 'Otro nombre',
});
t(
  sRepe === 409 && bRepe?.error?.code === 'grupo-repetido',
  `el mismo id no se puede repetir (${bRepe?.error?.code})`,
);

// ─────────── El punto central: un producto SÍ puede usarlo ───────────

seccion('Un producto puede clasificarse en el grupo nuevo (el CHECK ya no lo impide)');

const { body: catalogo } = await api('/api/admin/products');
const producto = catalogo.products[0];

const { status: sProd, body: bProd } = await put(`/api/admin/products/${producto.id}`, {
  nombre: producto.nombre,
  categoriaId: producto.categoriaId,
  grupoAdmin: grupo.id,
  precio: producto.precio,
  precioCosto: producto.precioCosto ?? 0,
  unidad: producto.unidad,
  origen: producto.origen,
  imagen: producto.imagen,
  imagenAlt: producto.imagenAlt,
});
t(sProd === 200, `se actualiza el producto con el grupo nuevo (${sProd})`);
t(bProd?.product?.grupoAdmin === grupo.id, `queda con ese grupo: "${bProd?.product?.grupoAdmin}"`);

const { status: sInvalido, body: bInvalido } = await put(`/api/admin/products/${producto.id}`, {
  nombre: producto.nombre,
  categoriaId: producto.categoriaId,
  grupoAdmin: 'no-existe-este-grupo',
  precio: producto.precio,
  precioCosto: producto.precioCosto ?? 0,
  unidad: producto.unidad,
  origen: producto.origen,
  imagen: producto.imagen,
  imagenAlt: producto.imagenAlt,
});
t(
  sInvalido === 400 && bInvalido?.error?.code === 'grupo-invalido',
  `un grupo inexistente sí se rechaza (${bInvalido?.error?.code})`,
);

// Y una categoría también.
const { body: categorias } = await api('/api/admin/categories');
const categoria = categorias.categories[0];

const { status: sCat, body: bCat } = await put(`/api/admin/categories/${categoria.id}`, {
  grupoAdmin: grupo.id,
});
t(sCat === 200, `una categoría también puede usarlo (${sCat})`);
t(bCat?.category?.grupoAdmin === grupo.id, 'queda con ese grupo');

// ─────────────────────────── El borrado ───────────────────────────

seccion('No se borra un grupo en uso');

const { status: sBorrarEnUso, body: bBorrarEnUso } = await del(
  `/api/admin/admin-groups/${grupo.id}`,
);
t(
  sBorrarEnUso === 409 && bBorrarEnUso?.error?.code === 'grupo-en-uso',
  `se rechaza (${bBorrarEnUso?.error?.code})`,
);
t(
  bBorrarEnUso?.error?.details?.categorias === 1 && bBorrarEnUso?.error?.details?.productos === 1,
  `dice cuántas categorías y productos lo usan: ${JSON.stringify(bBorrarEnUso?.error?.details)}`,
);
console.log(`  · «${bBorrarEnUso?.error?.message}»`);

// Se le quita el uso y entonces sí se puede.
await put(`/api/admin/categories/${categoria.id}`, { grupoAdmin: 'agroindustriales' });
await put(`/api/admin/products/${producto.id}`, {
  nombre: producto.nombre,
  categoriaId: producto.categoriaId,
  grupoAdmin: 'agroindustriales',
  precio: producto.precio,
  precioCosto: producto.precioCosto ?? 0,
  unidad: producto.unidad,
  origen: producto.origen,
  imagen: producto.imagen,
  imagenAlt: producto.imagenAlt,
});

const { status: sBorrarLibre } = await del(`/api/admin/admin-groups/${grupo.id}`);
t(sBorrarLibre === 200, `libre de uso, sí se borra (${sBorrarLibre})`);

const { body: bTrasBorrar } = await api('/api/admin/admin-groups');
t(
  !(bTrasBorrar?.grupos ?? []).some((g) => g.id === grupo.id),
  'y desaparece de la lista',
);

// ─────────────────────────── Editar y desactivar ───────────────────────────

seccion('Editar y desactivar');

const { status: sOtroNuevo, body: bOtroNuevo } = await post('/api/admin/admin-groups', {
  nombre: `QA Editable ${marca}`,
});
const editable = bOtroNuevo.grupo;

const { status: sEditar, body: bEditar } = await put(
  `/api/admin/admin-groups/${editable.id}`,
  { nombre: `QA Editable renombrado ${marca}`, activo: 0 },
);
t(sEditar === 200, `se edita el nombre y se desactiva (${sEditar})`);
t(bEditar?.grupo?.nombre === `QA Editable renombrado ${marca}`, 'con el nombre nuevo');
t(bEditar?.grupo?.activo === 0, 'y desactivado');

const { body: bActivos } = await api('/api/admin/admin-groups');
// Sigue en la lista (todos, activos e inactivos) — la pantalla es desde donde
// se reactivan, así que no debe desaparecer.
t(
  (bActivos?.grupos ?? []).some((g) => g.id === editable.id),
  'un grupo desactivado sigue en la lista completa',
);

// ─────────────────────────────────────────────────────────────

console.log(`\n${fallos === 0 ? '✔ Todo en orden' : `✘ ${fallos} fallo(s)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
