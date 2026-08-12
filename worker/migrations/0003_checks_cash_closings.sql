-- ============================================================================
--  Añade los CHECK de integridad que le faltaban a `cash_closings`.
--
--  El resto de tablas con dinero (products, orders, order_items) ya validaban
--  `>= 0` en la base. Esta se había quedado sin ninguno, y es justo la que
--  guarda cifras **congeladas**: si una se escribe en negativo por un error de
--  cálculo, el descuadre queda grabado y no se puede recomputar, porque los
--  pedidos que lo originaron ya están archivados.
--
--  `ganancia` se deja sin CHECK a propósito: vender por debajo del costo es
--  una decisión comercial posible, no un dato corrupto.
--
--  ── Por qué esta migración es más larga de lo que parece ──
--
--  SQLite no permite añadir un CHECK con ALTER TABLE: hay que recrear la
--  tabla. Y `orders.closing_id` es una FK a `cash_closings(id)` con
--  ON DELETE SET NULL, así que el `DROP TABLE` **borra la relación**: cada
--  pedido archivado pierde su cierre y el histórico queda vacío.
--
--  El truco habitual de `PRAGMA foreign_keys = OFF` no sirve aquí — D1 no lo
--  respeta entre sentencias de un mismo fichero. Se comprobó ejecutándola:
--  los 3 pedidos archivados de la base local pasaron a 0. Por eso la relación
--  se guarda antes y se restaura después, de forma explícita.
--
--  Es idempotente en la práctica: si se vuelve a ejecutar, copia y restaura
--  los mismos datos.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0003_checks_cash_closings.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0003_checks_cash_closings.sql
-- ============================================================================

-- 1. Copia de seguridad de la relación pedido → cierre, que el DROP se lleva.
DROP TABLE IF EXISTS _respaldo_closing_id;
CREATE TABLE _respaldo_closing_id AS
  SELECT id AS order_id, closing_id FROM orders WHERE closing_id IS NOT NULL;

-- 2. Tabla nueva, ya con los CHECK.
DROP TABLE IF EXISTS cash_closings_nuevo;
CREATE TABLE cash_closings_nuevo (
  id                 TEXT    PRIMARY KEY,
  referencia         TEXT    NOT NULL UNIQUE,
  cerrado_por        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cerrado_por_nombre TEXT    NOT NULL,
  cerrado_en         TEXT    NOT NULL DEFAULT (datetime('now')),
  pedidos_count      INTEGER NOT NULL DEFAULT 0 CHECK (pedidos_count   >= 0),
  unidades_count     INTEGER NOT NULL DEFAULT 0 CHECK (unidades_count  >= 0),
  venta_producto     INTEGER NOT NULL DEFAULT 0 CHECK (venta_producto  >= 0),
  costo_producto     INTEGER NOT NULL DEFAULT 0 CHECK (costo_producto  >= 0),
  ganancia           INTEGER NOT NULL DEFAULT 0,
  envios_cobrados    INTEGER NOT NULL DEFAULT 0 CHECK (envios_cobrados >= 0),
  total_recaudado    INTEGER NOT NULL DEFAULT 0 CHECK (total_recaudado >= 0)
);

-- 3. Se copia por nombre de columna, no con SELECT *, para no depender del
--    orden en que estén declaradas.
INSERT INTO cash_closings_nuevo (
  id, referencia, cerrado_por, cerrado_por_nombre, cerrado_en,
  pedidos_count, unidades_count, venta_producto, costo_producto,
  ganancia, envios_cobrados, total_recaudado
)
SELECT
  id, referencia, cerrado_por, cerrado_por_nombre, cerrado_en,
  pedidos_count, unidades_count, venta_producto, costo_producto,
  ganancia, envios_cobrados, total_recaudado
FROM cash_closings;

DROP TABLE cash_closings;
ALTER TABLE cash_closings_nuevo RENAME TO cash_closings;

-- 4. El índice se va con la tabla vieja.
CREATE INDEX IF NOT EXISTS idx_closings_fecha ON cash_closings (cerrado_en DESC);

-- 5. Se devuelve cada pedido a su cierre.
UPDATE orders
   SET closing_id = (
         SELECT r.closing_id FROM _respaldo_closing_id r WHERE r.order_id = orders.id
       )
 WHERE id IN (SELECT order_id FROM _respaldo_closing_id);

DROP TABLE _respaldo_closing_id;
