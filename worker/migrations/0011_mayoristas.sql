-- ============================================================================
--  Precios de mayorista: tres niveles de cliente con descuento por producto.
--
--  ── Por qué `user_roles` se recrea ──
--
--  Su columna `role` lleva un CHECK con los tres roles del panel, y SQLite no
--  permite modificar un CHECK: hay que recrear la tabla. Aquí es seguro
--  hacerlo con el patrón simple —copiar, recrear, restaurar— porque **nada
--  referencia a `user_roles`**: la FK va en la otra dirección (`user_id` →
--  `users`), así que ningún ON DELETE CASCADE se dispara al soltarla. No es el
--  caso de `orders`, donde recrearla se lleva por delante líneas e historial
--  (ver la nota larga en 0005).
--
--  ── Por qué los descuentos van en su propia tabla ──
--
--  Podrían ser tres columnas en `products` (`descuento_n1`, `n2`, `n3`), pero
--  entonces añadir un cuarto nivel sería una migración de esquema y no un
--  INSERT. Con tabla aparte, la ausencia de fila **es** la ausencia de
--  descuento: no hay que distinguir 0 de NULL, y un producto sin trato
--  especial no ocupa nada.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0011_mayoristas.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0011_mayoristas.sql
-- ============================================================================

-- ─────────────────── 1. Los tres roles nuevos en el CHECK ───────────────────

DROP TABLE IF EXISTS _respaldo_roles_0011;
CREATE TABLE _respaldo_roles_0011 AS SELECT * FROM user_roles;

DROP TABLE user_roles;
CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN (
    'ADMIN_INVENTARIO', 'GESTOR_PEDIDOS', 'SUPER_ADMIN',
    -- Niveles de mayorista, de menor a mayor descuento habitual. No dan
    -- acceso a ninguna sección del panel: solo cambian el precio que se le
    -- cobra a esa cuenta en la tienda.
    'MAYORISTA_N1', 'MAYORISTA_N2', 'MAYORISTA_N3'
  )),
  PRIMARY KEY (user_id, role)
);

INSERT INTO user_roles (user_id, role)
  SELECT user_id, role FROM _respaldo_roles_0011;

DROP TABLE _respaldo_roles_0011;

-- ──────────────────── 2. Descuento por producto y nivel ────────────────────

CREATE TABLE IF NOT EXISTS product_wholesale_discounts (
  product_id            TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  role                  TEXT    NOT NULL CHECK (role IN ('MAYORISTA_N1', 'MAYORISTA_N2', 'MAYORISTA_N3')),

  -- Entero: los precios son INTEGER en pesos y el descuento se aplica como
  -- `precio * (100 - pct) / 100` redondeado. Un porcentaje con decimales
  -- añadiría coma flotante a un cálculo de dinero sin ganar nada — nadie
  -- negocia un 12,5 % con la finca.
  --
  -- El 0 no se guarda: "sin descuento" es que no exista la fila, no una fila
  -- que diga cero. El tope es 100 porque regalar el producto es una decisión
  -- comercial posible, aunque la interfaz avise antes de dejarlo así.
  porcentaje_descuento  INTEGER NOT NULL CHECK (porcentaje_descuento > 0 AND porcentaje_descuento <= 100),

  actualizado_en        TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Un solo descuento por producto y nivel. Sin esto, dos filas del mismo par
  -- dejarían el precio a merced de cuál leyera primero la consulta.
  PRIMARY KEY (product_id, role)
);

-- La pantalla de mayoristas pide "todos los descuentos del nivel N2"; la PK
-- empieza por `product_id`, así que no sirve para esa dirección.
CREATE INDEX IF NOT EXISTS idx_wholesale_role
  ON product_wholesale_discounts (role);
