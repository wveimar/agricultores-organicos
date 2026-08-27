-- ============================================================================
--  Compras a fincas: reemplaza el reparto automático por un registro manual.
--
--  ── Qué se va y por qué ──
--
--  `provider_payouts` (migración 0020) calculaba al cerrar caja cuánto se le
--  debía a cada finca, repartiendo el costo de lo vendido por `origen`. Era
--  una cifra *derivada*: decía "según lo que vendí, le debo esto". Nunca supo
--  qué se compró de verdad, ni movió inventario.
--
--  Lo que hacía falta es lo contrario: registrar la compra real —tanto de este
--  producto, a este costo, a esta finca—, que suba el inventario y que quede
--  constancia de si ya se le pagó al agricultor. Eso no se puede derivar de
--  las ventas, hay que capturarlo.
--
--  ── Cómo encaja con la ganancia ──
--
--  La compra NO se resta de `ganancia`. Sería contarla dos veces: la compra
--  fija `products.precio_costo`, ese costo se congela en
--  `order_items.costo_unitario` al vender (ver create() en routes/orders.ts) y
--  es lo que el cierre suma como `costo_producto`. La fórmula sigue igual:
--
--      ganancia = venta_producto - costo_producto - total_gastos
--
--  Comprar 50 kg y vender 30 deja 20 kg en bodega, no una pérdida de 20 kg.
--  Restar el pago completo convertiría el inventario sin vender en pérdida.
--
--  ── Nombres ──
--
--  `provider_purchases` y no `provider_manual_payouts`: con el automático
--  fuera, "manual" no distingue nada, y lo que la tabla guarda es una compra
--  —con su mercancía entrando a la bodega—, no solo una orden de giro.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0021_compras_a_fincas.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0021_compras_a_fincas.sql
-- ============================================================================

-- Nadie la referencia: `closing_id` apunta hacia fuera, no hacia dentro.
DROP TABLE IF EXISTS provider_payouts;

-- ─────────────────────── Cabecera: la compra ───────────────────────

CREATE TABLE IF NOT EXISTS provider_purchases (
  id          TEXT    PRIMARY KEY,
  -- Copia del `products.origen` en el momento de comprar, no una referencia:
  -- si mañana renombran la finca en el catálogo, esta compra debe seguir
  -- diciendo a quién se le compró. Misma razón que en `order_items`.
  origen      TEXT    NOT NULL,
  -- Suma de los `subtotal` del detalle. Se guarda calculado, y el servidor
  -- verifica que cuadre antes de escribirlo: una cabecera que no suma sus
  -- propias líneas es un descuadre que nadie detectaría hasta ir a pagar.
  total_pago  INTEGER NOT NULL CHECK (total_pago >= 0),
  -- 'pendiente' al registrar: la mercancía ya entró (el stock sube en ese
  -- momento) pero al agricultor todavía no se le ha girado. 'pagado' cuando
  -- se confirma la transferencia.
  estado      TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado')),
  notas       TEXT,
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  pagado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  pagado_en   TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchases_origen ON provider_purchases (origen, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_estado ON provider_purchases (estado, creado_en DESC);

-- ─────────────────────── Detalle: qué se compró ───────────────────────

CREATE TABLE IF NOT EXISTS provider_purchase_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE: borrar la compra se lleva su detalle. El stock que sumó se
  -- devuelve antes, en la misma transacción (ver remove() en routes/purchases.ts).
  purchase_id    TEXT    NOT NULL REFERENCES provider_purchases(id) ON DELETE CASCADE,
  -- RESTRICT como en `order_items`: un producto que alguna vez se compró no
  -- se borra del catálogo mientras esta línea lo nombre.
  product_id     TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  cantidad       INTEGER NOT NULL CHECK (cantidad > 0),
  -- El costo NEGOCIADO ese día, congelado. Puede diferir de
  -- `products.precio_costo` de hoy: comprar actualiza el catálogo, pero una
  -- compra posterior a otro precio no debe reescribir esta línea.
  costo_unitario INTEGER NOT NULL CHECK (costo_unitario >= 0),
  -- cantidad × costo_unitario, verificado en el servidor.
  subtotal       INTEGER NOT NULL CHECK (subtotal >= 0)
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON provider_purchase_items (purchase_id);
-- "¿Cuándo compré este producto y a cómo?", para el histórico por referencia.
CREATE INDEX IF NOT EXISTS idx_purchase_items_product  ON provider_purchase_items (product_id);
