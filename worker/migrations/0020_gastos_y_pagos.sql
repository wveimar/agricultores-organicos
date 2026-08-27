-- ============================================================================
--  Gastos operativos y liquidación a fincas.
--
--  Hasta ahora `ganancia` era venta menos costo de mercancía, y eso no es lo
--  que queda en el bolsillo: falta restar lo que cuesta operar (transporte,
--  empaque, servicios) y falta saber a qué finca hay que girarle cuánto.
--
--  Tres piezas:
--
--    1. `expenses`         — un gasto suelto. Nace huérfano (closing_id NULL)
--                            y el cierre de la jornada lo adopta, igual que
--                            hace `orders.closing_id` con los pedidos.
--    2. `cash_closings.total_gastos` — congela cuánto se gastó en esa jornada.
--    3. `provider_payouts` — cuánto se le debe a cada finca por esa jornada,
--                            calculado con el costo YA CONGELADO de las líneas
--                            del pedido (ver closeCash() en routes/reports.ts).
--
--  ── Por qué `origen` y no un id de proveedor ──
--
--  Porque es lo único que hay: `products.origen` es el texto que ya identifica
--  de dónde viene cada producto. No es una tabla de proveedores —no la hay— y
--  esta migración no la inventa: eso sería un cambio de modelo mucho mayor y
--  con datos que hoy nadie tiene. Se guarda el texto tal cual estaba al
--  cerrar, que además es lo correcto para un documento contable: si mañana
--  alguien renombra la finca en el catálogo, el giro de la semana pasada debe
--  seguir diciendo a quién se le pagó.
--
--  ── El UNIQUE no es decorativo ──
--
--  (closing_id, origen) evita que un reintento o un cierre corrido dos veces
--  duplique la deuda con una finca. El resto de las tablas de dinero de este
--  proyecto se protegen igual (ver `aprobacion_token` en orders).
--
--  Nada de esto recrea tablas: `expenses` y `provider_payouts` son nuevas y
--  `total_gastos` entra con ALTER TABLE porque trae DEFAULT (SQLite lo admite
--  con NOT NULL solo si hay default). Los 12 cierres que ya existen quedan con
--  total_gastos = 0, que es exactamente lo que pasó: no había gastos que
--  registrar cuando se hicieron. Su `ganancia` sigue siendo correcta.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0020_gastos_y_pagos.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0020_gastos_y_pagos.sql
-- ============================================================================

-- ───────────────────────────── 1. Gastos ─────────────────────────────

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT    PRIMARY KEY,
  descripcion TEXT    NOT NULL,
  -- Estrictamente positivo: un gasto de cero no es un gasto, es ruido en el
  -- informe. Para corregirse se borra, que es lo que hace DELETE /:id.
  monto       INTEGER NOT NULL CHECK (monto > 0),
  categoria   TEXT    NOT NULL CHECK (categoria IN ('transporte', 'empaque', 'servicios', 'otros')),
  -- Quién lo registró. SET NULL como en el resto: borrar una cuenta no puede
  -- llevarse la contabilidad por delante.
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL mientras la jornada sigue abierta. Al cerrar, el gasto queda atado a
  -- ese cierre y ya no se puede borrar — es parte de una cuenta congelada.
  closing_id  TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL
);

-- El panel pide siempre "los de este cierre" o "los huérfanos": este índice
-- cubre las dos, incluida la de closing_id IS NULL.
CREATE INDEX IF NOT EXISTS idx_expenses_closing ON expenses (closing_id, creado_en DESC);

-- ──────────────────── 2. El total de gastos en el cierre ────────────────────

ALTER TABLE cash_closings ADD COLUMN total_gastos INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────── 3. Liquidación a las fincas ───────────────────────

CREATE TABLE IF NOT EXISTS provider_payouts (
  id          TEXT    PRIMARY KEY,
  -- Copia del `products.origen` que tenían los productos al cerrar. Ver la
  -- nota de arriba sobre por qué se copia el texto y no se referencia.
  origen      TEXT    NOT NULL,
  -- Puede ser 0: una finca cuyo producto se vendió a precio de costo cero
  -- (donación, muestra) sigue teniendo que aparecer en la lista para que se
  -- vea que se tuvo en cuenta y no que se olvidó.
  monto_pago  INTEGER NOT NULL CHECK (monto_pago >= 0),
  estado      TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado')),
  closing_id  TEXT    NOT NULL REFERENCES cash_closings(id) ON DELETE CASCADE,
  pagado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  pagado_en   TEXT,
  -- Una sola fila por finca y jornada. Sin esto, un reintento del cierre
  -- duplicaría lo que se le debe a esa finca y nadie lo notaría hasta girar.
  UNIQUE (closing_id, origen)
);

CREATE INDEX IF NOT EXISTS idx_payouts_closing ON provider_payouts (closing_id);
-- Para la vista "qué está pendiente de pagar", que cruza todas las jornadas.
CREATE INDEX IF NOT EXISTS idx_payouts_estado  ON provider_payouts (estado, closing_id);
