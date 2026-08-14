-- ============================================================================
--  Añade 'editado' al CHECK de `order_status_log`.
--
--  Es un marcador de auditoría, no un estado del pedido: `orders.estado` NO
--  se toca en esta migración ni se le añade 'editado' — un pedido editado
--  sigue en 'verificacion'/'pendiente'/'aprobado', tal cual estaba. Solo la
--  traza necesita poder decir "alguien tocó las líneas de este pedido" sin
--  que eso se confunda con una transición real de estado.
--
--  Nada referencia a `order_status_log` (no hay CASCADE que temer al
--  recrearla), así que basta con el patrón simple: copiar, recrear, restaurar.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0009_order_log_editado.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0009_order_log_editado.sql
-- ============================================================================

DROP TABLE IF EXISTS _respaldo_log_0009;
CREATE TABLE _respaldo_log_0009 AS SELECT * FROM order_status_log;

DROP TABLE order_status_log;
CREATE TABLE order_status_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  estado        TEXT    NOT NULL CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'editado')),
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log (order_id, creado_en);

INSERT INTO order_status_log (id, order_id, estado, actor_id, actor_nombre, creado_en)
  SELECT id, order_id, estado, actor_id, actor_nombre, creado_en FROM _respaldo_log_0009;

DROP TABLE _respaldo_log_0009;
