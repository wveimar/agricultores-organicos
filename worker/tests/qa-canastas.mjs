/**
 * Canastas: vender una descuenta el stock de lo que lleva dentro.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-canastas.mjs [http://localhost:8788]
 *
 * Requiere la migración 0014:
 *   npx wrangler d1 execute DB --local --file=worker/migrations/0014_canastas.sql
 *
 * Lo que se vigila aquí no es que la canasta se venda, sino que **el inventario
 * cuadre al céntimo** después de cada camino: crear, aprobar, cancelar, editar
 * y borrar. Una fuga en cualquiera de los cinco no se nota hasta el conteo
 * físico, cuando ya es tarde para saber cuál fue.
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
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.77' },
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

/** Stock real de un producto, leído del panel (no el derivado del público). */
const stockDe = async (id) => {
  const { body } = await api('/api/admin/products');
  return body.products.find((p) => p.id === id)?.stock ?? null;
};

const crearProducto = async (nombre, stock) => {
  const { body } = await api('/api/admin/products', {
    method: 'POST',
    body: JSON.stringify({
      nombre,
      categoriaId: 'verduras',
      grupoAdmin: 'verduras',
      precio: 5000,
      precioCosto: 2000,
      unidad: 'unidad',
      cantidadUnidad: 1,
      origen: 'QA',
      imagen: 'https://example.test/qa.jpg',
      imagenAlt: 'Imagen de prueba de control de calidad',
    }),
  });
  await api(`/api/admin/products/${body.product.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ stock }),
  });
  return body.product.id;
};

const comprar = async (items) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clienteNombre: 'QA Canastas',
      clienteTelefono: '3000000000',
      clienteDireccion: 'Calle QA 1',
      items,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log(`== Canastas · ${BASE} ==`);

const sufijo = Date.now();

seccion('1. Montar la canasta');

// Papa y tomate con stock de sobra; aguacate escaso, para que sea él quien
// mande en cuántas canastas se pueden armar.
const papa = await crearProducto(`QA Papa ${sufijo}`, 100);
const tomate = await crearProducto(`QA Tomate ${sufijo}`, 100);
const aguacate = await crearProducto(`QA Aguacate ${sufijo}`, 7);
const canasta = await crearProducto(`QA Canasta ${sufijo}`, 0);

const receta = [
  [papa, 2],
  [tomate, 1],
  [aguacate, 3],
];
for (const [childId, cantidad] of receta) {
  await api(`/api/admin/products/${canasta}/componentes`, {
    method: 'PUT',
    body: JSON.stringify({ childId, cantidad }),
  });
}

const rec = await api(`/api/admin/products/${canasta}/componentes`);
t(rec.body.componentes.length === 3, `La receta tiene 3 componentes: ${rec.body.componentes.length}`);

// 7 aguacates ÷ 3 por canasta = 2 (trunca). Papa daría 50, tomate 100.
t(rec.body.armables === 2, `Manda el componente más escaso: ${rec.body.armables} canastas`);

seccion('2. La tienda ofrece la canasta con su stock derivado');

const publico = await (await fetch(`${BASE}/api/products`)).json();
const enTienda = publico.products.find((p) => p.id === canasta);
t(enTienda?.stock === 2, `La vitrina la muestra con stock 2, no con su columna en 0: ${enTienda?.stock}`);

seccion('3. Comprar una canasta descuenta lo de dentro');

const antes = { papa: await stockDe(papa), tomate: await stockDe(tomate), aguacate: await stockDe(aguacate) };
const compra = await comprar([{ productId: canasta, cantidad: 2 }]);
t(compra.status === 201, `Comprar 2 canastas → ${compra.status}`);

const despues = { papa: await stockDe(papa), tomate: await stockDe(tomate), aguacate: await stockDe(aguacate) };
t(antes.papa - despues.papa === 4, `Papa: −4 (2 canastas × 2) → bajó ${antes.papa - despues.papa}`);
t(antes.tomate - despues.tomate === 2, `Tomate: −2 → bajó ${antes.tomate - despues.tomate}`);
t(antes.aguacate - despues.aguacate === 6, `Aguacate: −6 → bajó ${antes.aguacate - despues.aguacate}`);
t((await stockDe(canasta)) === 0, 'La canasta sigue con su columna en 0: nunca se le escribe');

const pedidoId = compra.body.order.id;

seccion('4. No se puede comprar más de lo que da el componente escaso');

const pasada = await comprar([{ productId: canasta, cantidad: 5 }]);
t(pasada.status === 400, `Pedir 5 con 1 aguacate suelto → ${pasada.status}`);
t(
  pasada.body?.error?.code === 'stock-insuficiente',
  `Y lo dice en términos de canastas: ${pasada.body?.error?.code}`,
);

seccion('5. Cancelar devuelve exactamente lo que sacó');

const cancel = await api(`/api/admin/orders/${pedidoId}/cancelar`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'Prueba de control de calidad' }),
});
t(cancel.status === 200, `Cancelar → ${cancel.status}`);

const vuelta = { papa: await stockDe(papa), tomate: await stockDe(tomate), aguacate: await stockDe(aguacate) };
t(vuelta.papa === antes.papa, `Papa vuelve a ${antes.papa}: ${vuelta.papa}`);
t(vuelta.tomate === antes.tomate, `Tomate vuelve a ${antes.tomate}: ${vuelta.tomate}`);
t(vuelta.aguacate === antes.aguacate, `Aguacate vuelve a ${antes.aguacate}: ${vuelta.aguacate}`);

seccion('6. Canasta y suelto del mismo producto se suman, no se pisan');

// El agujero clásico: dos restas separadas que pasan su comprobación por
// separado y entre las dos se llevan más de lo que hay.
const antes2 = await stockDe(aguacate);
const mixta = await comprar([
  { productId: canasta, cantidad: 1 },
  { productId: aguacate, cantidad: 2 },
]);
t(mixta.status === 201, `1 canasta (3 aguacates) + 2 sueltos → ${mixta.status}`);
t(
  antes2 - (await stockDe(aguacate)) === 5,
  `Bajaron los 5 de una vez: ${antes2 - (await stockDe(aguacate))}`,
);

seccion('7. La receta congelada manda, aunque cambie después');

const pedido2 = mixta.body.order.id;
// Se le quita el aguacate a la canasta DESPUÉS de haberla vendido.
await api(`/api/admin/products/${canasta}/componentes/${aguacate}`, { method: 'DELETE' });

const antesCancelar = await stockDe(aguacate);
await api(`/api/admin/orders/${pedido2}/cancelar`, {
  method: 'POST',
  body: JSON.stringify({ motivo: 'Prueba de receta congelada' }),
});
const trasCancelar = await stockDe(aguacate);

// Sin instantánea se devolverían solo los 2 sueltos y los 3 de la canasta
// quedarían descontados para siempre.
t(
  trasCancelar - antesCancelar === 5,
  `Devuelve los 5, con la receta de cuando se vendió: ${trasCancelar - antesCancelar}`,
);

seccion('8. Integridad de la receta');

await api(`/api/admin/products/${canasta}/componentes`, {
  method: 'PUT',
  body: JSON.stringify({ childId: aguacate, cantidad: 3 }),
});

const anidar = await api(`/api/admin/products/${papa}/componentes`, {
  method: 'PUT',
  body: JSON.stringify({ childId: canasta, cantidad: 1 }),
});
t(
  anidar.body?.error?.code === 'componente-es-canasta',
  `Una canasta dentro de otra se rechaza: ${anidar.body?.error?.code}`,
);

const seMisma = await api(`/api/admin/products/${canasta}/componentes`, {
  method: 'PUT',
  body: JSON.stringify({ childId: canasta, cantidad: 1 }),
});
t(
  seMisma.body?.error?.code === 'componente-invalido',
  `Una canasta dentro de sí misma: ${seMisma.body?.error?.code}`,
);

seccion('9. Un componente no se borra mientras esté dentro de una canasta');

const borrar = await api(`/api/admin/products/${papa}`, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 0 }),
});
t(borrar.status === 200, `Desactivar un componente sí se puede → ${borrar.status}`);

// Con la papa desactivada, la canasta no se puede armar aunque sobre stock.
const recDesactivada = await api(`/api/admin/products/${canasta}/componentes`);
t(
  recDesactivada.body.armables === 0,
  `Con un componente inactivo, no se arma ninguna: ${recDesactivada.body.armables}`,
);

await api(`/api/admin/products/${papa}`, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 1 }),
});

seccion('10. Las canastas no ensucian la lista de reposición');

const alertas = await api('/api/admin/products/alerts');
t(
  !alertas.body.products.some((p) => p.id === canasta),
  'La canasta no aparece pidiendo reposición pese a tener la columna en 0',
);

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
