-- ============================================================================
--  Cantidad de la presentación que se vende.
--
--  Hasta ahora `unidad` cargaba con dos cosas a la vez: la magnitud y, cuando
--  hacía falta, también el tamaño — de ahí etiquetas como "bolsa 500 g" y
--  "frasco 350 g", con el peso escrito dentro del nombre. Eso no se puede
--  filtrar, ni comparar, ni cambiar sin tocar código.
--
--  Con esta columna, la presentación es `cantidad_unidad` + `unidad`:
--  500 gr, 5 unidades, 1 kg. `precio` sigue siendo lo que se cobra por esa
--  presentación completa, no por unidad de medida.
--
--  Va con ALTER TABLE y no recreando la tabla: `products` tiene una FK desde
--  `order_items` con ON DELETE RESTRICT, así que soltarla exigiría mover
--  también el histórico de ventas. Añadir una columna con valor por defecto
--  sí lo permite SQLite, y es una operación instantánea.
--
--  El DEFAULT 1 deja todo el catálogo existente como estaba: "1 kg", "1
--  unidad", que es exactamente lo que significaba antes.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0007_cantidad_unidad.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0007_cantidad_unidad.sql
-- ============================================================================

ALTER TABLE products
  ADD COLUMN cantidad_unidad INTEGER NOT NULL DEFAULT 1 CHECK (cantidad_unidad > 0);
