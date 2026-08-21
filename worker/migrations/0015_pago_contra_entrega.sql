-- ============================================================================
--  Pago contra entrega: el domiciliario cobra en efectivo al entregar, y ese
--  dinero solo entra a la caja del día cuando un admin confirma por separado
--  que lo recibió físicamente.
--
--  ── Por qué son DOS pasos y no uno ──
--
--  Con transferencia, el dinero ya está en el banco cuando el pedido llega a
--  'aprobado' — por eso `closeCash()` puede tratar 'aprobado'/'enviado' como
--  recaudado sin más. Con contra-entrega eso deja de ser cierto: un pedido
--  'enviado' todavía no tiene el dinero cobrado, está en la calle. Y aunque el
--  domiciliario ya lo haya cobrado, ese efectivo sigue en su bolsillo, no en
--  la caja de la finca, hasta que alguien lo entregue de verdad.
--
--  Por eso 'pago' (el domiciliario cobró) y la liquidación (el admin confirmó
--  que ese efectivo ya está en la finca) son dos cosas distintas. La primera
--  la marca el domiciliario desde la calle; la segunda solo un admin, porque
--  quien certifica que el dinero llegó no puede ser quien lo trae encima.
--
--  ── Por qué 'rechazado' es un marcador de log y no un estado nuevo ──
--
--  Un pedido contra-entrega rechazado en la puerta termina en 'cancelado' —
--  el mismo valor que ya usa toda la UI (pestaña "Cancelados", isCancelable,
--  etc.), así que no hay que tocar ese código. Pero "cancelado antes de
--  salir" y "rechazado en la puerta" son cosas distintas para quien mide qué
--  tan seguido se rechaza un pedido contra-entrega, y esa distinción vive en
--  la traza: 'rechazado' es al 'cancelado' de `orders.estado` lo que
--  'editado' es a los estados normales — un marcador que nunca aparece en
--  `orders.estado`, solo en `order_status_log`.
--
--  ── Por qué se recrean orders / order_status_log / user_roles ──
--
--  SQLite no permite modificar un CHECK: hay que recrear la tabla. Recrear
--  `orders` es peligroso de una forma que no se ve leyendo el fichero — ya no
--  son dos tablas hijas las que su DROP se lleva por delante, son TRES:
--
--    order_items            .order_id → orders(id) ON DELETE CASCADE
--    order_status_log       .order_id → orders(id) ON DELETE CASCADE
--    order_item_components  .order_id → orders(id) ON DELETE CASCADE  (0014)
--
--  La tercera es nueva desde la migración de canastas y es fácil de olvidar
--  si solo se mira el patrón de la 0005, que respalda dos. Las tres se copian
--  antes y se restauran después. El orden de las sentencias es la migración:
--  no se puede reordenar.
--
--  `user_roles` no la referencia nadie (la FK va al revés, user_id → users),
--  así que ahí basta el patrón simple: copiar, recrear, restaurar.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0015_pago_contra_entrega.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0015_pago_contra_entrega.sql
-- ============================================================================

-- 1. Copia de las tres tablas que el CASCADE de `orders` se llevaría.
DROP TABLE IF EXISTS _respaldo_items_0015;
CREATE TABLE _respaldo_items_0015 AS SELECT * FROM order_items;

DROP TABLE IF EXISTS _respaldo_log_0015;
CREATE TABLE _respaldo_log_0015 AS SELECT * FROM order_status_log;

DROP TABLE IF EXISTS _respaldo_componentes_0015;
CREATE TABLE _respaldo_componentes_0015 AS SELECT * FROM order_item_components;

-- 2. `orders` con el estado 'pago' y las dos columnas de contra-entrega.
--    Ninguna de las dos se lista en el INSERT de más abajo: se apoyan en su
--    propio DEFAULT, igual que hizo la 0005 con `cancelacion_token` y compañía
--    — todo pedido que ya existía nació antes de que contra-entrega existiera,
--    así que es 'transferencia' sin liquidar por definición.
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

  -- Cómo se paga. 'transferencia' es el default explícito porque todo pedido
  -- de hoy hacia atrás lo era — no existía otra opción.
  metodo_pago        TEXT    NOT NULL DEFAULT 'transferencia'
                             CHECK (metodo_pago IN ('transferencia', 'contraentrega')),

  -- Si el efectivo cobrado por el domiciliario ya está en la caja de la
  -- finca. Solo importa para 'contraentrega': una transferencia nunca pasa
  -- por este flag, su dinero ya estaba verificado antes de aprobar. Es la
  -- columna que `closeCash()`/`cashSummary()` usan para no contar como
  -- recaudado un efectivo que sigue en la calle.
  efectivo_liquidado INTEGER NOT NULL DEFAULT 0 CHECK (efectivo_liquidado IN (0, 1))
);

INSERT INTO orders_nuevo (
  id, referencia, user_id, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total,
  comprobante_nombre, comprobante_url,
  aprobado_por, aprobado_en, aprobacion_token,
  cancelacion_token, cancelado_por, cancelado_en, motivo_cancelacion,
  closing_id, creado_en
)
SELECT
  id, referencia, user_id, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total,
  comprobante_nombre, comprobante_url,
  aprobado_por, aprobado_en, aprobacion_token,
  cancelacion_token, cancelado_por, cancelado_en, motivo_cancelacion,
  closing_id, creado_en
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_nuevo RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_orders_closing ON orders (closing_id);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders (user_id);

-- 3. `order_status_log` con los tres marcadores nuevos: 'pago' (transición
--    real, corresponde 1:1 con `orders.estado`) y 'liquidado'/'rechazado'
--    (marcas de auditoría puras, como 'editado' — nunca aparecen en
--    `orders.estado`).
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

-- 4. `order_item_components` no cambia de forma, solo se restaura tal cual
--    (su FK a `orders` sigue siendo válida contra la tabla recién recreada).
DROP TABLE IF EXISTS order_item_components;
CREATE TABLE order_item_components (
  order_id           TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  parent_product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  child_product_id   TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  cantidad_requerida INTEGER NOT NULL CHECK (cantidad_requerida > 0),
  PRIMARY KEY (order_id, parent_product_id, child_product_id)
);

-- 5. Se devuelven las filas que el CASCADE borró. Por nombre de columna, no
--    con SELECT *, para no depender del orden en que estén declaradas.
INSERT INTO order_items (id, order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
  SELECT id, order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad
    FROM _respaldo_items_0015;

INSERT INTO order_status_log (id, order_id, estado, actor_id, actor_nombre, creado_en)
  SELECT id, order_id, estado, actor_id, actor_nombre, creado_en FROM _respaldo_log_0015;

INSERT INTO order_item_components (order_id, parent_product_id, child_product_id, cantidad_requerida)
  SELECT order_id, parent_product_id, child_product_id, cantidad_requerida FROM _respaldo_componentes_0015;

DROP TABLE _respaldo_items_0015;
DROP TABLE _respaldo_log_0015;
DROP TABLE _respaldo_componentes_0015;

-- 6. El rol del domiciliario. Nadie referencia `user_roles`, así que aquí
--    basta el patrón simple: copiar, recrear, restaurar.
DROP TABLE IF EXISTS _respaldo_roles_0015;
CREATE TABLE _respaldo_roles_0015 AS SELECT * FROM user_roles;

DROP TABLE user_roles;
CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN (
    'ADMIN_INVENTARIO', 'GESTOR_PEDIDOS', 'SUPER_ADMIN',
    'MAYORISTA_N1', 'MAYORISTA_N2', 'MAYORISTA_N3',
    -- No da acceso a ninguna sección del panel salvo la propia: un
    -- domiciliario ve y cobra pedidos 'enviado' contra-entrega, nada más.
    'DOMICILIARIO'
  )),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_roles (user_id, role)
  SELECT user_id, role FROM _respaldo_roles_0015;

DROP TABLE _respaldo_roles_0015;
