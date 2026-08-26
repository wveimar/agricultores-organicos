-- ============================================================================
--  0017 · Crédito a mayoristas (cartera / cuentas por cobrar)
-- ============================================================================
--
--  Un mayorista se lleva la mercancía y paga a los 15 o 30 días. Hasta ahora no
--  había forma de registrarlo: todo pedido entraba por transferencia
--  (verificada antes de aprobar) o por contra entrega (cobrada en la puerta).
--  El fiado no cabía en ninguno de los dos.
--
--  ── Crédito es un método de pago, no un estado ──
--
--  La tentación es añadir un estado 'por_cobrar' a `orders.estado`. Se
--  descartó: `estado` describe **dónde está el pedido** (aprobado, enviado,
--  cancelado) y `metodo_pago` describe **cómo entra el dinero**. Un pedido a
--  crédito recorre exactamente el mismo camino que cualquier otro —aprobado,
--  enviado, y 'pago' cuando el cliente paga—; lo único distinto es cuándo
--  llega la plata. Mezclarlo en `estado` habría duplicado cada filtro, cada
--  pestaña y cada guardia del panel.
--
--  ── Por qué el dinero NO entra al cierre hasta que se cobra ──
--
--  `RECAUDADO_WHERE` (reports.ts) exige `closing_id IS NULL`. Un pedido a
--  crédito impago no encaja en ninguna rama de ese predicado, así que ningún
--  cierre lo barre y su `closing_id` sigue nulo. El día que se marca 'pago'
--  pasa a encajar, y **el siguiente cierre lo recoge**: el efectivo aparece en
--  la jornada en que de verdad entró a la caja.
--
--  Es la diferencia con estampar `closing_id` al enviarlo «para congelar el
--  período»: eso lo dejaría archivado para siempre y, al cobrarse, el dinero
--  no aparecería en ningún cierre — la caja quedaría corta por ese monto sin
--  que nada lo delatara.
--
--  ── Por qué se recrea `orders` ──
--
--  Cambia el CHECK de `metodo_pago` y SQLite no deja alterarlo. Mismo patrón y
--  mismas precauciones que la 0015: hay que respaldar las **tres** tablas
--  hijas con `ON DELETE CASCADE` (`order_items`, `order_status_log`,
--  `order_item_components`), porque el DROP se las lleva por delante.
--
--  `PRAGMA foreign_keys = OFF` NO sirve aquí: en D1 cada sentencia va en su
--  propia transacción implícita y el pragma no sobrevive de una a la
--  siguiente. Está documentado en la 0005 tras chocar con ello.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0017_credito_mayoristas.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0017_credito_mayoristas.sql
-- ============================================================================

-- ──────────────── 1. Cupo y plazo del cliente, en `users` ────────────────
--
--  Aquí `ALTER TABLE` sí basta: se añaden columnas, no se toca ningún CHECK
--  existente. Cupo 0 —el valor de todos los que ya existen— significa «esta
--  cuenta no compra a crédito», que es lo correcto para el resto de clientes.

ALTER TABLE users ADD COLUMN cupo_credito INTEGER NOT NULL DEFAULT 0 CHECK (cupo_credito >= 0);
ALTER TABLE users ADD COLUMN dias_credito INTEGER NOT NULL DEFAULT 0 CHECK (dias_credito >= 0);

-- ───────── 2. Respaldo de las tres hijas antes de tocar `orders` ─────────

DROP TABLE IF EXISTS _respaldo_items_0017;
CREATE TABLE _respaldo_items_0017 AS SELECT * FROM order_items;

DROP TABLE IF EXISTS _respaldo_log_0017;
CREATE TABLE _respaldo_log_0017 AS SELECT * FROM order_status_log;

DROP TABLE IF EXISTS _respaldo_componentes_0017;
CREATE TABLE _respaldo_componentes_0017 AS SELECT * FROM order_item_components;

-- ───── 3. `orders` con 'credito' en el CHECK y la fecha de vencimiento ─────

DROP TABLE IF EXISTS orders_nuevo;
CREATE TABLE orders_nuevo (
  id                 TEXT    PRIMARY KEY,
  referencia         TEXT    NOT NULL UNIQUE,
  user_id            TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cliente_nombre     TEXT    NOT NULL,
  cliente_telefono   TEXT    NOT NULL,
  cliente_direccion  TEXT    NOT NULL,

  estado             TEXT    NOT NULL DEFAULT 'pendiente'
                             CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'pago')),

  stock_reservado    INTEGER NOT NULL DEFAULT 0 CHECK (stock_reservado IN (0, 1)),

  subtotal           INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  envio              INTEGER NOT NULL DEFAULT 0 CHECK (envio >= 0),
  total              INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),

  comprobante_nombre TEXT,
  comprobante_url    TEXT,

  aprobado_por       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  aprobado_en        TEXT,
  aprobacion_token   TEXT,

  cancelacion_token  TEXT,
  cancelado_por      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cancelado_en       TEXT,
  motivo_cancelacion TEXT,

  closing_id         TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,
  creado_en          TEXT    NOT NULL DEFAULT (datetime('now')),

  -- 'credito' entra aquí y no en `estado`: ver la nota de arriba.
  metodo_pago        TEXT    NOT NULL DEFAULT 'transferencia'
                             CHECK (metodo_pago IN ('transferencia', 'contraentrega', 'credito')),

  efectivo_liquidado INTEGER NOT NULL DEFAULT 0 CHECK (efectivo_liquidado IN (0, 1)),

  -- Cuándo vence la deuda. NULL en todo lo que no sea 'credito' — no hay nada
  -- que vencer cuando el dinero ya entró o se cobra en la puerta. Fecha ISO,
  -- como el resto (`date('now', '+N days')`), y es lo que ordena la cartera
  -- por antigüedad.
  vence_en           TEXT
);

INSERT INTO orders_nuevo (
  id, referencia, user_id, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total,
  comprobante_nombre, comprobante_url,
  aprobado_por, aprobado_en, aprobacion_token,
  cancelacion_token, cancelado_por, cancelado_en, motivo_cancelacion,
  closing_id, creado_en, metodo_pago, efectivo_liquidado
)
SELECT
  id, referencia, user_id, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total,
  comprobante_nombre, comprobante_url,
  aprobado_por, aprobado_en, aprobacion_token,
  cancelacion_token, cancelado_por, cancelado_en, motivo_cancelacion,
  closing_id, creado_en, metodo_pago, efectivo_liquidado
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_nuevo RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_orders_closing ON orders (closing_id);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders (user_id);

-- La cartera pide siempre lo mismo: pedidos a crédito sin cobrar, del más
-- vencido al menos. Sin este índice sería un recorrido completo de `orders`
-- cada vez que alguien abre la pantalla de deudores.
CREATE INDEX IF NOT EXISTS idx_orders_credito ON orders (metodo_pago, estado, vence_en);

-- ───── 4. Se restauran las tres hijas que el CASCADE borró ─────
--
--  `order_status_log` y `order_item_components` se recrean con la misma forma
--  que dejó la 0015: su FK apunta a la tabla recién renombrada.

DROP TABLE IF EXISTS order_status_log;
CREATE TABLE order_status_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  estado        TEXT    NOT NULL CHECK (estado IN (
    'verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'editado',
    'pago', 'liquidado', 'rechazado'
  )),
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_status_log_order ON order_status_log (order_id, creado_en);

DROP TABLE IF EXISTS order_item_components;
CREATE TABLE order_item_components (
  order_id           TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  parent_product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  child_product_id   TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  cantidad_requerida INTEGER NOT NULL CHECK (cantidad_requerida > 0),
  PRIMARY KEY (order_id, parent_product_id, child_product_id)
);

-- Por nombre de columna, no con SELECT *, para no depender del orden en que
-- estén declaradas.
INSERT INTO order_items (id, order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
  SELECT id, order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad
    FROM _respaldo_items_0017;

INSERT INTO order_status_log (id, order_id, estado, actor_id, actor_nombre, creado_en)
  SELECT id, order_id, estado, actor_id, actor_nombre, creado_en FROM _respaldo_log_0017;

INSERT INTO order_item_components (order_id, parent_product_id, child_product_id, cantidad_requerida)
  SELECT order_id, parent_product_id, child_product_id, cantidad_requerida
    FROM _respaldo_componentes_0017;

DROP TABLE _respaldo_items_0017;
DROP TABLE _respaldo_log_0017;
DROP TABLE _respaldo_componentes_0017;
