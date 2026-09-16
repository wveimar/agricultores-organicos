-- 0038 · Productos tipo "servicio": reservas con fecha y cupo
--
-- ── El problema que resuelve ──
--
-- Todo el catálogo asumía un producto físico: stock por unidad o por peso,
-- descontado al vender. Un tour o una cita no tiene eso — tiene una fecha,
-- un cupo máximo de personas y ningún envío. No existía ningún lugar donde
-- guardar "el sábado 14 hay 20 cupos, ya se reservaron 12".
--
-- ── Por qué una tabla nueva y no una columna de "fecha" en `products` ──
--
-- Un mismo producto-servicio (p. ej. "Tour al Nevado") tiene MUCHAS salidas
-- futuras, cada una con su propio cupo. Es la misma razón por la que
-- `product_components` es una tabla aparte y no una columna en `products`:
-- una fila por producto no puede guardar una lista.
--
-- ── Por qué `cupo_reservado` es un CHECK y no solo una validación de la app ──
--
-- Mismo patrón que `products.stock_actual >= 0` (ver el comentario de esa
-- columna en schema.sql): es la última línea de defensa cuando dos reservas
-- concurrentes pasan la validación de la aplicación a la vez. Sin el CHECK,
-- la segunda reserva simultánea dejaría el cupo en negativo.
--
-- ── Por qué son solo ALTER TABLE ADD COLUMN / CREATE TABLE ──
--
-- Nada se recrea. Recrear `products` u `order_items` en D1 con sus FK activas
-- es exactamente lo que otros comentarios de schema.sql advierten evitar (ver
-- `orders.metodo_pago`, `categories.grupo_admin`) — así que esta migración no
-- lo intenta ni falta le hace: ambas columnas nuevas son opcionales/con
-- default y no chocan con ninguna restricción existente.

ALTER TABLE products ADD COLUMN tipo TEXT NOT NULL DEFAULT 'fisico'
  CHECK (tipo IN ('fisico', 'servicio'));

-- Una salida/cita concreta de un producto-servicio.
CREATE TABLE product_sessions (
  id             TEXT    PRIMARY KEY,
  product_id     TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  inicio         TEXT    NOT NULL,
  fin            TEXT,
  ubicacion      TEXT,
  cupo_total     INTEGER NOT NULL CHECK (cupo_total > 0),
  cupo_reservado INTEGER NOT NULL DEFAULT 0
                 CHECK (cupo_reservado >= 0 AND cupo_reservado <= cupo_total),
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  creado_en      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- El catálogo público y el panel piden "las próximas sesiones de este
-- producto", ordenadas por fecha. Parcial: una sesión desactivada no debe
-- ofrecerse ni ocupar sitio en el índice.
CREATE INDEX idx_sessions_product ON product_sessions (product_id, inicio)
  WHERE activo = 1;

-- Qué sesión reservó esta línea del pedido. NULL en todo lo que no sea un
-- servicio — un producto físico no tiene fecha que elegir.
ALTER TABLE order_items ADD COLUMN session_id TEXT
  REFERENCES product_sessions(id) ON DELETE RESTRICT;
