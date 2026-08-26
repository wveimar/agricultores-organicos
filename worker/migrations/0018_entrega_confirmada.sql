-- ============================================================================
--  Añade `entregado_en` a `orders` y el evento 'entregado' al CHECK de
--  `order_status_log`.
--
--  Antes solo se podía confirmar una entrega junto con su cobro (pagar(), que
--  exige metodo_pago = 'contraentrega'). Eso deja fuera a los pedidos que se
--  pagaron por transferencia: también salen a la calle y también hay que
--  saber si el domiciliario ya tocó la puerta o siguen en camino, aunque no
--  haya nada que cobrar.
--
--  `entregado_en` es esa marca, separada a propósito de `estado`: el pedido
--  se queda en 'enviado', no hay estado nuevo que inventar ni transición que
--  romper — mismo truco que `efectivo_liquidado` en la migración 0015.
--
--  Es una columna nullable sin CHECK, así que se agrega con ALTER TABLE
--  simple: no hace falta recrear `orders` como en 0005/0017. El evento del
--  log sí exige recrear `order_status_log`, con el mismo patrón simple que
--  0009 — nadie la referencia, no hay CASCADE que temer.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0018_entrega_confirmada.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0018_entrega_confirmada.sql
-- ============================================================================

ALTER TABLE orders ADD COLUMN entregado_en TEXT;

DROP TABLE IF EXISTS _respaldo_log_0018;
CREATE TABLE _respaldo_log_0018 AS SELECT * FROM order_status_log;

DROP TABLE order_status_log;
CREATE TABLE order_status_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  estado        TEXT    NOT NULL CHECK (estado IN (
    'verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'editado',
    'pago', 'liquidado', 'rechazado', 'entregado'
  )),
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log (order_id, creado_en);

INSERT INTO order_status_log (id, order_id, estado, actor_id, actor_nombre, creado_en)
  SELECT id, order_id, estado, actor_id, actor_nombre, creado_en FROM _respaldo_log_0018;

DROP TABLE _respaldo_log_0018;
