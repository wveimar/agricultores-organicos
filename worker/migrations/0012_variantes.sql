-- ============================================================================
--  Variantes de producto: presentaciones (Miel 300/500/1000 gr) y sabores
--  (Kambucha Jamaica / Lulada / Mango).
--
--  ── Por qué cada variante es una fila y no una columna con opciones ──
--
--  Porque cada una tiene su propio inventario físico: en la bodega hay tarros
--  de 300 gr y tarros de 1000 gr, y se agotan por separado. El
--  `CHECK (stock_actual >= 0)` de esta misma tabla es lo único que garantiza
--  que dos aprobaciones concurrentes no vendan el mismo tarro dos veces, y ese
--  CHECK protege **una fila**. Guardar las tres presentaciones dentro de un
--  JSON en una sola fila dejaría el control de stock en manos de la aplicación,
--  que es justo donde no queremos que esté.
--
--  Además `order_items.product_id` apunta a esta tabla: con una fila por
--  variante, el histórico de ventas ya distingue solo cuál se vendió, y el
--  consolidado semanal le dice al apicultor "12 de 500 gr" sin cambiar nada.
--
--  ── Qué añade esta migración ──
--
--  · `parent_id` — apunta al producto "sombrilla" que agrupa las variantes.
--    NULL = producto normal o producto padre. La tienda solo pinta tarjetas de
--    filas con `parent_id IS NULL`; al pulsar "Elegir" abre las hijas.
--
--  · `variante_etiqueta` — cómo se llama lo que distingue a las hijas, en el
--    padre: 'presentación' para la miel, 'sabor' para la kambucha. Sirve para
--    que el modal diga "Elige la presentación" y no un genérico "Elige una
--    opción". Se guarda en vez de deducirse de si los precios coinciden: esa
--    deducción acierta en estos dos casos y falla en cuanto existan dos
--    tamaños al mismo precio.
--
--  ── Sobre las restricciones ──
--
--  El ON DELETE es SET NULL y no CASCADE a propósito. Borrar un padre con
--  CASCADE se llevaría por delante el inventario de sus hijas —filas a las que
--  apunta `order_items`— y eso no se deshace. Con SET NULL las variantes
--  reaparecen como productos sueltos en la vitrina: es un desorden visible y
--  reparable en un minuto desde el panel, que es infinitamente preferible a
--  una pérdida silenciosa de datos de venta.
--
--  El CHECK impide que una fila sea su propia madre. Sin él, un `UPDATE` con
--  el id equivocado dejaría un producto invisible para siempre: no es padre de
--  nadie que se pueda abrir, y la vitrina lo descarta por tener `parent_id`.
--
--  Va con ALTER TABLE y no recreando la tabla porque `order_items` tiene una
--  FK a `products` con ON DELETE RESTRICT: soltarla exigiría mover también
--  todo el histórico de ventas.
--
--  Un solo nivel de anidamiento: una hija no puede tener hijas. SQLite no
--  puede comprobarlo con un CHECK (no admite subconsultas), así que lo impone
--  el Worker al crear y editar productos.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0012_variantes.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0012_variantes.sql
-- ============================================================================

ALTER TABLE products
  ADD COLUMN parent_id TEXT REFERENCES products(id) ON DELETE SET NULL
  CHECK (parent_id IS NULL OR parent_id <> id);

ALTER TABLE products
  ADD COLUMN variante_etiqueta TEXT;

-- El catálogo público pregunta "¿quiénes son las hijas de este id?" una vez
-- por padre. Índice parcial: las filas sin madre —la inmensa mayoría del
-- catálogo— no ocupan sitio en él.
CREATE INDEX IF NOT EXISTS idx_products_parent
  ON products (parent_id) WHERE parent_id IS NOT NULL;
