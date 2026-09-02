-- ─────────────────── Baja de inventario por merma (0034) ───────────────────
--
-- El cierre de jornada de la bodega: lo que se deshidrató, se pudrió, se venció
-- o se rompió y ya no se puede vender. Hasta ahora el stock solo bajaba
-- vendiendo; corregirlo a mano en el campo `stock` de Inventario no dejaba
-- rastro de POR QUÉ bajó, y esa es justamente la pregunta que hace una
-- auditoría.
--
-- ── Por qué una tabla propia y no un `expenses` más ──
--
-- Un gasto es una sola cifra con una descripción. Una merma necesita detalle
-- por producto —qué se botó, cuánto, en qué unidad, por qué motivo— porque de
-- ese detalle salen las dos cosas que justifican el módulo: el descuento de
-- inventario producto a producto, y el informe de "qué se está dañando más".
-- La forma es la misma de `provider_purchases` + `provider_purchase_items`,
-- que es el otro documento que mueve stock, solo que en sentido contrario.
--
-- ── Por qué SÍ resta de la ganancia ──
--
-- La compra a la finca no se resta (ver el comentario de `provider_purchases`):
-- su costo se recupera al vender, congelado en `order_items.costo_unitario`, y
-- de ahí lo resta el cierre como `costo_producto`. Lo que se bota nunca se
-- vende, así que ese costo NO pasa por ninguna venta y se quedaría sin
-- contabilizar: la jornada mostraría una ganancia que no existe. Por eso el
-- cierre adopta las mermas huérfanas —igual que hace con los gastos— y las
-- resta en `total_merma`.

CREATE TABLE mermas (
  id            TEXT    PRIMARY KEY,
  -- Las dos valoraciones del mismo descarte, congeladas al registrarlo:
  --   · `total_costo` es la pérdida REAL —lo que se le pagó a la finca— y es
  --     la que resta de la ganancia.
  --   · `total_venta` es lo que se habría facturado de haberse vendido. No
  --     entra en ninguna cuenta; sirve para dimensionar el problema en el
  --     informe ("dejamos de facturar X").
  total_costo   INTEGER NOT NULL CHECK (total_costo >= 0),
  total_venta   INTEGER NOT NULL DEFAULT 0 CHECK (total_venta >= 0),
  -- La justificación general del acta ("estantería expuesta al sol", etc.).
  observaciones TEXT,
  creado_por    TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL mientras la jornada sigue abierta; el cierre la adopta, igual que a
  -- los gastos y a los pedidos. Con cierre puesto ya no se puede deshacer: es
  -- cuenta congelada.
  closing_id    TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL
);

CREATE INDEX idx_mermas_closing ON mermas (closing_id, creado_en DESC);

CREATE TABLE merma_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE: una línea no significa nada sin su acta. El stock que descontó se
  -- devuelve antes, en la misma transacción (ver remove() en mermas.ts).
  merma_id        TEXT    NOT NULL REFERENCES mermas(id) ON DELETE CASCADE,
  -- RESTRICT como en `order_items`: un producto que alguna vez se dio de baja
  -- no se borra del catálogo mientras esta línea lo nombre.
  product_id      TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Nombre y unidad COPIADOS, por lo mismo que en `order_items`: el acta es un
  -- documento de lo que pasó ese día y debe seguir leyéndose igual aunque el
  -- catálogo cambie después.
  producto_nombre TEXT    NOT NULL,
  unidad          TEXT    NOT NULL,
  -- NUMERIC y no INTEGER: desde la 0033 hay productos que se venden por peso,
  -- y se bota "0.4 kg de tomate" tan a menudo como "3 unidades". La afinidad
  -- NUMERIC guarda el 3 como entero y el 0.4 como real, sin que haya que
  -- elegir. (La 0033 explica por qué las columnas viejas declaradas INTEGER
  -- también aceptan decimales; aquí, siendo tabla nueva, se declara lo que de
  -- verdad es.)
  cantidad        NUMERIC NOT NULL CHECK (cantidad > 0),
  -- El costo y el precio vigentes el día del descarte, congelados.
  costo_unitario  INTEGER NOT NULL CHECK (costo_unitario >= 0),
  subtotal_costo  INTEGER NOT NULL CHECK (subtotal_costo >= 0),
  precio_unitario INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario >= 0),
  subtotal_venta  INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_venta >= 0),
  -- La causa raíz. Lista cerrada a propósito: es la columna por la que se
  -- agrupa el informe, y con texto libre ("podrido", "pudrición", "se dañó")
  -- ese informe no podría sumar nada.
  motivo          TEXT    NOT NULL CHECK (
                    motivo IN ('deshidratacion', 'pudricion', 'vencimiento', 'rotura', 'otro')
                  ),
  -- Detalle de ESTA línea, cuando el motivo no basta.
  observacion     TEXT,
  -- Una sola línea por producto y acta: dos líneas del mismo producto harían
  -- dos descuentos de stock sobre la misma fila y el acta lo mostraría
  -- repetido. Mismo criterio que `UNIQUE (order_id, product_id)`.
  UNIQUE (merma_id, product_id)
);

CREATE INDEX idx_merma_items_merma   ON merma_items (merma_id);
CREATE INDEX idx_merma_items_product ON merma_items (product_id);
-- "¿Qué se está dañando más?", que es el informe por causa raíz.
CREATE INDEX idx_merma_items_motivo  ON merma_items (motivo);

-- Lo que la jornada perdió por merma, valorado al costo. Se resta de
-- `ganancia` junto con `costo_producto` y `total_gastos`.
ALTER TABLE cash_closings ADD COLUMN total_merma INTEGER NOT NULL DEFAULT 0;
