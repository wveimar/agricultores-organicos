-- ────────────────────────────── Entrega en tienda ────────────────────────────────
--
-- Nueva forma de compra: retira directamente en la tienda sin costo de envío.
-- Antes: solo 'transferencia', 'contraentrega', y 'credito' (solo panel).
-- Ahora: además 'entrega_en_tienda' en web.

-- SQLite no permite ALTER TABLE para agregar CHECK: hay que recrear.
-- Para evitar problemas de foreign keys, borramos primero los índices que referencian la tabla.

DROP INDEX IF EXISTS idx_orders_domiciliario;
DROP INDEX IF EXISTS idx_orders_estado;
DROP INDEX IF EXISTS idx_orders_closing;
DROP INDEX IF EXISTS idx_orders_user;
DROP INDEX IF EXISTS idx_orders_credito;
DROP INDEX IF EXISTS idx_orders_contact;

-- Crear tabla temporal con la nueva definición
CREATE TABLE orders_new (
  id                  TEXT    PRIMARY KEY,
  referencia          TEXT    NOT NULL UNIQUE,
  user_id             TEXT    REFERENCES users(id) ON DELETE SET NULL,
  contact_id          TEXT    REFERENCES contacts(id) ON DELETE SET NULL,
  cliente_nombre      TEXT    NOT NULL,
  cliente_telefono    TEXT    NOT NULL,
  cliente_direccion   TEXT    NOT NULL,
  estado              TEXT    NOT NULL DEFAULT 'pendiente'
                              CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'pago')),
  stock_reservado     INTEGER NOT NULL DEFAULT 0 CHECK (stock_reservado IN (0, 1)),
  subtotal            INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  envio               INTEGER NOT NULL DEFAULT 0 CHECK (envio >= 0),
  total               INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  comprobante_nombre  TEXT,
  comprobante_url     TEXT,
  aprobado_por        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  aprobado_en         TEXT,
  aprobacion_token    TEXT,
  cancelacion_token   TEXT,
  cancelado_por       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cancelado_en        TEXT,
  motivo_cancelacion  TEXT,
  closing_id          TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,
  creado_en           TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Nuevo: ahora incluye 'entrega_en_tienda'
  metodo_pago         TEXT    NOT NULL DEFAULT 'transferencia'
                              CHECK (metodo_pago IN ('transferencia', 'contraentrega', 'credito', 'entrega_en_tienda')),
  vence_en            TEXT,
  efectivo_liquidado  INTEGER NOT NULL DEFAULT 0 CHECK (efectivo_liquidado IN (0, 1)),
  entregado_en        TEXT,
  domiciliario_id     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  domiciliario_nombre TEXT
);

-- Copiar datos
INSERT INTO orders_new SELECT * FROM orders;

-- Borrar tabla vieja y renombrar la nueva
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Recrear índices
CREATE INDEX idx_orders_domiciliario
  ON orders (domiciliario_id, estado) WHERE domiciliario_id IS NOT NULL;
CREATE INDEX idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX idx_orders_closing ON orders (closing_id);
CREATE INDEX idx_orders_user    ON orders (user_id);
CREATE INDEX idx_orders_credito ON orders (metodo_pago, estado, vence_en);
CREATE INDEX idx_orders_contact ON orders (contact_id);
