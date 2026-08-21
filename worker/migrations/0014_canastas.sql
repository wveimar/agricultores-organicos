-- ============================================================================
--  Canastas, combos y mixes: un producto que al venderse descuenta el stock de
--  otros.
--
--  ── El problema que resuelve ──
--
--  Una «Canasta Pequeña» se vende como un producto más —tiene precio, foto y
--  slug— pero no existe en la bodega: lo que existe es la papa, el tomate y el
--  aguacate que la llenan. Vender una tiene que sacar esas tres cosas del
--  inventario, no una «canasta» que nadie cosechó nunca.
--
--  ── Por qué la receta va en su propia tabla ──
--
--  Podría ser una columna JSON en `products`, pero entonces «¿en qué canastas
--  entra la papa?» —la pregunta que hay que responder antes de borrar un
--  producto o de bajarle el stock— obligaría a leer y parsear el catálogo
--  entero. Con tabla puente es un índice.
--
--  ── Por qué la canasta no tiene stock propio ──
--
--  Su `stock_actual` se queda en 0 y **nunca se escribe**. Cuántas canastas se
--  pueden armar no es un dato que se guarde: se calcula con el componente que
--  primero se agote, `MIN(stock_hijo / cantidad_requerida)`. Guardarlo sería
--  tener dos verdades sobre el mismo inventario, y la que se escribe a mano
--  siempre acaba mintiendo.
--
--  Es la misma convención que ya usan las madres de variantes (ver 0012): una
--  fila que existe para tener nombre y foto, con el inventario en otra parte.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0014_canastas.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0014_canastas.sql
-- ============================================================================

-- ──────────────────────── 1. La receta de cada canasta ────────────────────────

CREATE TABLE IF NOT EXISTS product_components (
  -- La canasta. Al borrarla se lleva su receta: sin canasta, la lista de lo
  -- que llevaba dentro no significa nada.
  parent_product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  -- El producto que la llena. RESTRICT y no CASCADE: borrar la papa mientras
  -- tres canastas la incluyen las dejaría prometiendo algo que ya no existe.
  -- Primero se saca de las recetas, después se borra.
  child_product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Cuánto entra de ese producto en UNA canasta, en sus propias presentaciones:
  -- 2 si la canasta lleva dos bolsas de 500 gr de las que ya se venden sueltas.
  -- No son gramos ni kilos — es "cuántas de esas" — para que el descuento sea
  -- la misma resta que hace una venta normal y no haya que convertir unidades.
  cantidad_requerida INTEGER NOT NULL CHECK (cantidad_requerida > 0),

  PRIMARY KEY (parent_product_id, child_product_id),

  -- Una canasta que se contiene a sí misma es un bucle infinito al expandirla.
  CHECK (parent_product_id <> child_product_id)
);

-- La PK sirve para «¿qué lleva esta canasta?». Esto sirve para la pregunta
-- contraria, «¿en qué canastas entra este producto?», que es la que hay que
-- responder antes de borrarlo o para avisar de que bajarle el stock deja
-- canastas sin armar.
CREATE INDEX IF NOT EXISTS idx_components_child
  ON product_components (child_product_id);

-- ─────────────────── 2. Una canasta no contiene otra canasta ───────────────────
--
-- Sin este límite, expandir una canasta sería una consulta recursiva con
-- detección de ciclos y profundidad sin tope. Con él, expandir es un solo
-- SELECT plano, y el negocio no pierde nada: una canasta lleva verduras, no
-- otras canastas.
--
-- Va en un trigger y no en un CHECK porque la condición mira otras filas, que
-- es justo lo que un CHECK no puede hacer. La API valida lo mismo antes para
-- dar un mensaje legible; esto es la garantía de que no entre por otra vía.

DROP TRIGGER IF EXISTS trg_components_un_solo_nivel;
CREATE TRIGGER trg_components_un_solo_nivel
BEFORE INSERT ON product_components
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM product_components WHERE parent_product_id = NEW.child_product_id)
      THEN RAISE(ABORT, 'componente-es-canasta')
    WHEN EXISTS (SELECT 1 FROM product_components WHERE child_product_id = NEW.parent_product_id)
      THEN RAISE(ABORT, 'canasta-es-componente')
    -- Una madre de variantes tampoco sirve de componente: su stock es 0 por
    -- definición, así que la canasta nunca se podría armar. Hay que elegir la
    -- presentación concreta que va dentro.
    WHEN EXISTS (SELECT 1 FROM products WHERE parent_id = NEW.child_product_id)
      THEN RAISE(ABORT, 'componente-agrupa-variantes')
  END;
END;

-- ──────────────── 3. Qué llevaba la canasta el día que se vendió ────────────────
--
-- La receta de arriba es la de HOY. Un pedido abierto necesita la de ayer.
--
-- Si se le quita el aguacate a la Canasta Pequeña y después se cancela un
-- pedido que se hizo cuando sí lo llevaba, devolver según la receta nueva
-- dejaría un aguacate descontado que nadie devuelve nunca. El descuento y su
-- devolución tienen que leer exactamente la misma lista.
--
-- Es la misma razón por la que `order_items` ya copia `producto_nombre` y
-- `precio_unitario` en vez de mirarlos en el catálogo: el pedido es el
-- documento de lo que pasó, no una vista de lo que hay ahora.

CREATE TABLE IF NOT EXISTS order_item_components (
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- La canasta tal como aparece en `order_items`.
  parent_product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- El componente. RESTRICT igual que en `order_items.product_id`: lo que
  -- alguna vez salió en un pedido no se borra del catálogo.
  child_product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Por canasta, no el total: multiplicado por las canastas de la línea da lo
  -- que se descontó. Guardar el total obligaría a rehacer la cuenta al editar
  -- la cantidad del pedido.
  cantidad_requerida INTEGER NOT NULL CHECK (cantidad_requerida > 0),

  PRIMARY KEY (order_id, parent_product_id, child_product_id)
);

-- ────────────────────── 4. Las canastas que ya existían ──────────────────────
--
-- El catálogo ya tiene una categoría «canastas» con productos dentro, vendidos
-- hasta ahora como si fueran un producto suelto. No se les inventa una receta
-- aquí —solo quien sabe qué lleva cada una puede escribirla, desde el panel—
-- pero sí se deja constancia de cuáles son, para que no se queden olvidadas.
--
-- Mientras no tengan receta se siguen comportando exactamente como hoy: un
-- producto normal con su propio `stock_actual`. La expansión solo actúa sobre
-- lo que tiene filas en `product_components`.
