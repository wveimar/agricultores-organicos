-- ============================================================================
--  Datos de ejemplo para las variantes de producto (migración 0012).
--
--  ── OJO: esto es opcional y va aparte de la migración ──
--
--  La migración 0012 solo añade las columnas y es segura de correr en remoto.
--  Este archivo **crea productos**. Si la miel y la kambucha ya existen en
--  producción con otros ids, correr esto las duplicaría. Revisa antes:
--
--    npx wrangler d1 execute DB --remote \
--      --command "SELECT id, nombre FROM products WHERE nombre LIKE '%iel%' OR nombre LIKE '%ambucha%'"
--
--  Si ya están creadas, no ejecutes este archivo: enlaza las que hay con
--  UPDATE, que es lo que hace la sección de abajo comentada.
--
--  Todo va con INSERT OR IGNORE y con ids fijos, así que ejecutarlo dos veces
--  no crea nada nuevo ni pisa el stock que haya.
--
--    npx wrangler d1 execute DB --local  --file=worker/seed-variantes.sql
--    npx wrangler d1 execute DB --remote --file=worker/seed-variantes.sql
--
--  ── Cómo se reparte la información entre madre e hijas ──
--
--  La madre es una **portada**: nombre, foto, origen y texto. No tiene stock
--  (0) porque no hay ningún tarro que se llame "Miel de Abejas" a secas; lo
--  que se vende son los de 300, 500 y 1000 gr, y cada uno lleva su inventario.
--  El Worker rechaza pedir una madre directamente, y la tienda ni siquiera lo
--  ofrece: su botón abre el modal de variantes.
--
--  Su `precio` es el de la hija más barata. No se cobra nunca, pero cualquier
--  consulta que lo lea —un informe, un export— muestra "desde cuánto" en vez
--  de un 0 que parecería un producto regalado.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ────────────────────────── Miel de Abejas · por peso ──────────────────────────
--
-- Tres presentaciones, tres precios. El precio por gramo baja con el tamaño
-- (53,3 → 48,0 → 45,0 $/gr), que es como se vende de verdad en la finca.

INSERT OR IGNORE INTO products (
  id, slug, nombre, tagline, categoria_id, grupo_admin,
  precio, precio_costo, unidad, cantidad_unidad, origen,
  rating, review_count, badge, destacado, stock_actual, stock_seguridad,
  imagen, imagen_alt, parent_id, variante_etiqueta
) VALUES (
  'p-miel-base', 'miel-de-abejas', 'Miel de Abejas',
  'Cruda y sin filtrar: cristaliza con el frío, y eso es buena señal',
  'mieles', 'agroindustriales',
  16000, 9900, 'gr', 300, 'Apiario Flor de Monte · Cauca',
  4.9, 265, 'bestseller', 1, 0, 0,
  'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?auto=format&fit=crop&w=900&h=1125&q=80',
  'Cuchara de miel goteando dentro de un frasco de vidrio lleno',
  NULL, 'presentación'
);

INSERT OR IGNORE INTO products (
  id, slug, nombre, tagline, categoria_id, grupo_admin,
  precio, precio_costo, unidad, cantidad_unidad, origen,
  rating, review_count, stock_actual, stock_seguridad,
  imagen, imagen_alt, parent_id
) VALUES
  ('p-miel-300', 'miel-de-abejas-300gr', 'Miel de Abejas · 300 gr',
   'El tarro de diario, para el café y las tostadas',
   'mieles', 'agroindustriales',
   16000, 9900, 'gr', 300, 'Apiario Flor de Monte · Cauca',
   4.9, 118, 24, 8,
   'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?auto=format&fit=crop&w=900&h=1125&q=80',
   'Frasco pequeño de miel de abejas sobre una mesa de madera',
   'p-miel-base'),

  ('p-miel-500', 'miel-de-abejas-500gr', 'Miel de Abejas · 500 gr',
   'El tamaño que más sale: rinde un mes largo en casa',
   'mieles', 'agroindustriales',
   24000, 14800, 'gr', 500, 'Apiario Flor de Monte · Cauca',
   4.9, 96, 18, 6,
   'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?auto=format&fit=crop&w=900&h=1125&q=80',
   'Frasco mediano de miel de abejas junto a un panal',
   'p-miel-base'),

  ('p-miel-1000', 'miel-de-abejas-1000gr', 'Miel de Abejas · 1000 gr',
   'El kilo completo, el mejor precio por gramo',
   'mieles', 'agroindustriales',
   45000, 27800, 'gr', 1000, 'Apiario Flor de Monte · Cauca',
   4.9, 51, 9, 4,
   'https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?auto=format&fit=crop&w=900&h=1125&q=80',
   'Frasco grande de un kilo de miel de abejas a contraluz',
   'p-miel-base');

-- ─────────────────────────── Kambucha · por sabor ───────────────────────────
--
-- Mismo precio las tres: aquí la variante no cambia lo que se paga, solo de
-- qué inventario sale. Por eso la ficha del padre muestra un precio único y no
-- un "desde", y el modal habla de sabor y no de presentación.

INSERT OR IGNORE INTO products (
  id, slug, nombre, tagline, categoria_id, grupo_admin,
  precio, precio_costo, unidad, cantidad_unidad, origen,
  rating, review_count, badge, destacado, stock_actual, stock_seguridad,
  imagen, imagen_alt, parent_id, variante_etiqueta
) VALUES (
  'p-kambucha-base', 'kambucha', 'Kambucha',
  'Fermentada 14 días en casa, viva y con burbuja fina',
  'listos', 'agroindustriales',
  12000, 7200, 'mililitro', 350, 'Fermentario La Cascada · Marinilla',
  4.7, 143, 'nuevo', 1, 0, 0,
  'https://images.unsplash.com/photo-1596803244618-8dbee441d70b?auto=format&fit=crop&w=900&h=1125&q=80',
  'Botella de kambucha con la etiqueta hacia el frente sobre fondo claro',
  NULL, 'sabor'
);

INSERT OR IGNORE INTO products (
  id, slug, nombre, tagline, categoria_id, grupo_admin,
  precio, precio_costo, unidad, cantidad_unidad, origen,
  rating, review_count, stock_actual, stock_seguridad,
  imagen, imagen_alt, parent_id
) VALUES
  ('p-kambucha-jamaica', 'kambucha-jamaica', 'Kambucha · Jamaica',
   'Ácida y rojísima, la más pedida',
   'listos', 'agroindustriales',
   12000, 7200, 'mililitro', 350, 'Fermentario La Cascada · Marinilla',
   4.8, 64, 30, 10,
   'https://images.unsplash.com/photo-1596803244618-8dbee441d70b?auto=format&fit=crop&w=900&h=1125&q=80',
   'Botella de kambucha de flor de jamaica, de color rojo intenso',
   'p-kambucha-base'),

  ('p-kambucha-lulada', 'kambucha-lulada', 'Kambucha · Lulada',
   'Con lulo del Valle: ácida, verde y refrescante',
   'listos', 'agroindustriales',
   12000, 7200, 'mililitro', 350, 'Fermentario La Cascada · Marinilla',
   4.6, 41, 22, 10,
   'https://images.unsplash.com/photo-1596803244618-8dbee441d70b?auto=format&fit=crop&w=900&h=1125&q=80',
   'Botella de kambucha de lulo, de color verde claro',
   'p-kambucha-base'),

  ('p-kambucha-mango', 'kambucha-mango', 'Kambucha · Mango',
   'La dulce del trío, con mango de azúcar maduro',
   'listos', 'agroindustriales',
   12000, 7200, 'mililitro', 350, 'Fermentario La Cascada · Marinilla',
   4.7, 38, 26, 10,
   'https://images.unsplash.com/photo-1596803244618-8dbee441d70b?auto=format&fit=crop&w=900&h=1125&q=80',
   'Botella de kambucha de mango, de color amarillo anaranjado',
   'p-kambucha-base');

-- ─────────────────────── El grupo del panel (0025) ───────────────────────
--
-- Los INSERT de arriba solo llenan `grupo_admin`, la columna VIEJA: este
-- fichero es anterior a la migración 0025, que movió el grupo de verdad a
-- `grupo_admin_id`. El efecto era que estas fichas quedaban sin grupo, y
-- guardarlas desde el panel fallaba con `grupo-invalido` antes siquiera de
-- llegar a las comprobaciones de variantes — lo que hacía fallar a
-- `qa-variantes.mjs` por un problema del sembrado, no del producto.
--
-- El grupo se deduce de la categoría, que es de donde lo saca el panel.
UPDATE products
   SET grupo_admin_id = (
     SELECT c.grupo_admin_id FROM categories c WHERE c.id = products.categoria_id
   )
 WHERE grupo_admin_id IS NULL
   AND id IN ('p-miel-base', 'p-miel-300', 'p-miel-500', 'p-miel-1000',
              'p-kambucha-base', 'p-kambucha-jamaica', 'p-kambucha-lulada',
              'p-kambucha-mango');

-- ============================================================================
--  Si los productos YA existen en producción, esto es lo que hay que hacer en
--  vez de lo de arriba: enlazar las filas que ya están, sin crear ninguna.
--  Sustituye los ids por los reales y descomenta.
--
--  UPDATE products SET variante_etiqueta = 'presentación' WHERE id = '<id de la madre>';
--  UPDATE products SET parent_id = '<id de la madre>'     WHERE id IN ('<hija 1>', '<hija 2>');
--  -- La madre deja de venderse sola: su stock se va a las hijas.
--  UPDATE products SET stock_actual = 0 WHERE id = '<id de la madre>';
-- ============================================================================
