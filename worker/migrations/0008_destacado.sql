-- ============================================================================
--  Marca "más vendido", separada de `badge`.
--
--  ── Por qué una columna nueva y no reutilizar `badge` ──
--
--  `badge` es **excluyente**: un producto lleva una sola etiqueta. Hoy en
--  producción hay 10 con 'bestseller', 6 con 'nuevo', 6 con 'temporada' y 1
--  con 'ultimas-unidades'. Si "destacado" viviera ahí, marcar como más vendida
--  la "Fresa de Temporada" le borraría su etiqueta de temporada, y son dos
--  cosas que pueden ser ciertas a la vez.
--
--  Con una columna aparte, la decisión de destacar es independiente de la
--  etiqueta que luzca la tarjeta — y también del stock, que es lo que se pidió:
--  destacar es una decisión comercial, no un reflejo de la bodega.
--
--  Se siembra desde `badge = 'bestseller'` para no perder el criterio que ya
--  estaba aplicado a mano.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0008_destacado.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0008_destacado.sql
-- ============================================================================

ALTER TABLE products
  ADD COLUMN destacado INTEGER NOT NULL DEFAULT 0 CHECK (destacado IN (0, 1));

UPDATE products SET destacado = 1 WHERE badge = 'bestseller';

-- La home pide solo los destacados activos: un índice parcial deja fuera todo
-- lo demás y resuelve la consulta sin recorrer el catálogo.
CREATE INDEX IF NOT EXISTS idx_products_destacado
  ON products (destacado) WHERE activo = 1 AND destacado = 1;
