-- ============================================================================
--  Añade el estado 'cancelado' a `orders` y a `order_status_log`, y la columna
--  `cancelacion_token` que hace idempotente la devolución de stock.
--
--  ── Por qué esto no es un ALTER TABLE ──
--
--  SQLite no permite modificar un CHECK: hay que recrear la tabla. Y recrear
--  `orders` es peligroso de una forma que no se ve leyendo el fichero:
--
--    order_items      .order_id → orders(id) ON DELETE CASCADE
--    order_status_log .order_id → orders(id) ON DELETE CASCADE
--
--  El `DROP TABLE orders` dispara esos CASCADE y **se lleva por delante todas
--  las líneas y toda la trazabilidad de todos los pedidos**. `PRAGMA
--  foreign_keys = OFF` no ayuda: D1 no lo respeta entre sentencias de un mismo
--  fichero. Se comprobó al migrar `cash_closings`, donde los pedidos
--  archivados perdieron su cierre en la primera versión de aquella migración.
--
--  Por eso las dos tablas hijas se copian antes y se restauran después. El
--  orden de las sentencias es la migración: no se puede reordenar.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0005_estado_cancelado.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0005_estado_cancelado.sql
-- ============================================================================

-- 1. Copia de las tablas que el CASCADE se llevaría.
DROP TABLE IF EXISTS _respaldo_items;
CREATE TABLE _respaldo_items AS SELECT * FROM order_items;

DROP TABLE IF EXISTS _respaldo_log;
CREATE TABLE _respaldo_log AS SELECT * FROM order_status_log;

-- 2. `orders` con el estado nuevo y el token de cancelación.
DROP TABLE IF EXISTS orders_nuevo;
CREATE TABLE orders_nuevo (
  id                 TEXT    PRIMARY KEY,
  referencia         TEXT    NOT NULL UNIQUE,
  user_id            TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cliente_nombre     TEXT    NOT NULL,
  cliente_telefono   TEXT    NOT NULL,
  cliente_direccion  TEXT    NOT NULL,

  estado             TEXT    NOT NULL DEFAULT 'pendiente'
                             CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado')),

  stock_reservado    INTEGER NOT NULL DEFAULT 0 CHECK (stock_reservado IN (0, 1)),

  subtotal           INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  envio              INTEGER NOT NULL DEFAULT 0 CHECK (envio >= 0),
  total              INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),

  comprobante_nombre TEXT,
  comprobante_url    TEXT,

  aprobado_por       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  aprobado_en        TEXT,
  aprobacion_token   TEXT,

  -- Mismo papel que `aprobacion_token`, para la cancelación: sin él, dos
  -- cancelaciones simultáneas del mismo pedido devolverían el stock dos veces
  -- y el inventario acabaría inflado.
  cancelacion_token  TEXT,
  cancelado_por      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cancelado_en       TEXT,
  motivo_cancelacion TEXT,

  closing_id         TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,
  creado_en          TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO orders_nuevo (
  id, referencia, user_id, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total,
  comprobante_nombre, comprobante_url,
  aprobado_por, aprobado_en, aprobacion_token, closing_id, creado_en
)
SELECT
  id, referencia, user_id, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total,
  comprobante_nombre, comprobante_url,
  aprobado_por, aprobado_en, aprobacion_token, closing_id, creado_en
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_nuevo RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_orders_closing ON orders (closing_id);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders (user_id);

-- 3. `order_status_log` con el estado nuevo. Se recrea entera porque su CHECK
--    también rechazaría 'cancelado'. Nadie la referencia, así que aquí no hay
--    CASCADE que temer.
DROP TABLE IF EXISTS order_status_log;
CREATE TABLE order_status_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  estado        TEXT    NOT NULL CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado')),
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log (order_id, creado_en);

-- 4. Se devuelven las filas que el CASCADE borró. Por nombre de columna, no
--    con SELECT *, para no depender del orden en que estén declaradas.
INSERT INTO order_items (id, order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
  SELECT id, order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad
    FROM _respaldo_items;
INSERT INTO order_status_log (id, order_id, estado, actor_id, actor_nombre, creado_en)
  SELECT id, order_id, estado, actor_id, actor_nombre, creado_en FROM _respaldo_log;

DROP TABLE _respaldo_items;
DROP TABLE _respaldo_log;
