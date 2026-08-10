-- ============================================================================
--  Migración aditiva — no toca ninguna tabla existente.
--
--  A diferencia de schema.sql (que empieza con DROP TABLE y solo es seguro en
--  una base nueva o de la que aceptas perder todo), este archivo se puede
--  correr contra una base **con datos reales** sin destruir nada: solo crea
--  la tabla si no existe.
--
--  Uso:
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0001_order_status_log.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0001_order_status_log.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_status_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  estado        TEXT    NOT NULL CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado')),
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log (order_id, creado_en);
