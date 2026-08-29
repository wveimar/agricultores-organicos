-- ──────────────────── Módulo de cartera: abonos y cobros ────────────────────
--
-- Hasta la 0027 cobrar era un sí o un no: el pedido pasaba a 'pago' y la
-- factura entera se daba por saldada. No había dónde anotar que de $45.000
-- entraron $20.000.
--
-- Este es el modelo de tres tablas que usan Odoo (`account.payment` +
-- reconciliación parcial), QuickBooks y Xero:
--
--     invoices  ←──  payment_allocations  ──→  payments
--     (la deuda)     (cuánto de este pago      (el dinero que
--                     salda esta factura)       entró, y cuándo)
--
-- La tabla del medio es la que casi todo el mundo se salta, y es la que hace
-- que el sistema crezca. Sin ella no se puede modelar el caso que ya existe en
-- esta finca: el restaurante que paga $100.000 el viernes cubriendo tres
-- domicilios de la semana. Con ella salen los tres casos gratis:
--
--   · un pago → varias facturas   (el restaurante)
--   · una factura → varios pagos  (los abonos)
--   · un pago sin repartir del todo → anticipo, saldo a favor del cliente
--
-- ── Devengado contra caja ──
--
-- La factura se fecha cuando se emite; el pago, cuando entra. Son dos libros
-- distintos y los dos son ciertos. Por eso `cash_closings` gana una columna
-- nueva (`total_cobrado`) en lugar de reescribir `total_recaudado`: la vieja
-- sigue diciendo cuánto se VENDIÓ en la jornada, la nueva cuánto se COBRÓ.
-- Sin separarlas, el primer abono de una factura de la semana pasada dejaba la
-- caja y la cartera contando cosas distintas para siempre.

CREATE TABLE payments (
  id                  TEXT    PRIMARY KEY,
  -- Consecutivo propio, independiente del de facturas: son dos series
  -- distintas y numerarlas juntas haría ilegibles las dos.
  referencia          TEXT    NOT NULL UNIQUE,

  -- De quién es la plata. RESTRICT: un cobro registrado no puede quedar
  -- huérfano porque alguien depuró la agenda.
  contact_id          TEXT    REFERENCES contacts(id) ON DELETE RESTRICT,
  -- Copia congelada, igual que en `invoices`: si el contacto se renombra, el
  -- recibo tiene que seguir diciendo a quién se le cobró ese día.
  cliente_nombre      TEXT    NOT NULL,

  monto               INTEGER NOT NULL CHECK (monto > 0),

  metodo              TEXT    NOT NULL DEFAULT 'efectivo'
                              CHECK (metodo IN ('efectivo', 'transferencia', 'nequi', 'daviplata')),

  -- Cuándo entró. Es la fecha que manda para la caja, y NO tiene por qué
  -- coincidir con la de la factura: ese desfase es justamente lo que este
  -- módulo viene a poder representar.
  recibido_en         TEXT    NOT NULL DEFAULT (datetime('now')),
  recibido_por        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  recibido_por_nombre TEXT    NOT NULL DEFAULT '',

  /*
   * Si la plata ya está en la finca.
   *
   * 1 para casi todo: una transferencia entra a la cuenta en el acto. 0 solo
   * para el efectivo que cobra un domiciliario en la puerta, que sigue en su
   * bolsillo hasta que alguien lo liquida — es la misma distinción que
   * `orders.efectivo_liquidado` de la migración 0015, y existe por lo mismo:
   * un cierre de caja que cuente ese dinero estaría contando plata que nadie
   * ha visto todavía.
   */
  liquidado           INTEGER NOT NULL DEFAULT 1 CHECK (liquidado IN (0, 1)),

  -- La jornada que se llevó este cobro. NULL = todavía sin cerrar.
  closing_id          TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,

  comprobante_url     TEXT,
  nota                TEXT
);

-- «¿Qué cobré hoy?», la pregunta del cierre.
CREATE INDEX idx_payments_closing ON payments (closing_id, liquidado);
-- El estado de cuenta de un cliente.
CREATE INDEX idx_payments_contact ON payments (contact_id, recibido_en DESC);

/*
 * Cuánto de este pago salda esta factura.
 *
 * Es la tabla que convierte «entraron $100.000» en «$45.000 de la factura 3,
 * $30.000 de la 7 y $25.000 de la 9». La suma de las asignaciones de un pago
 * NUNCA puede pasarse de su monto; lo que sobra es anticipo y se queda sin
 * repartir, que es exactamente como se representa un saldo a favor.
 *
 * Esa invariante no cabe en un CHECK —SQLite no permite subconsultas ahí— así
 * que la impone el endpoint, dentro del mismo `batch()` que inserta.
 */
CREATE TABLE payment_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE: una asignación no significa nada sin su pago.
  payment_id TEXT    NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  -- RESTRICT: una factura con plata asignada no se borra. Es lo que impide
  -- que un cobro quede apuntando al vacío.
  invoice_id TEXT    NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  monto      INTEGER NOT NULL CHECK (monto > 0),
  -- Un pago reparte como mucho una vez sobre la misma factura: dos filas para
  -- el mismo par serían dos formas de decir lo mismo y se desincronizarían.
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX idx_allocations_invoice ON payment_allocations (invoice_id);

-- Cuánto se COBRÓ en la jornada, frente a `total_recaudado`, que es cuánto se
-- VENDIÓ. Las dos cifras conviven porque responden preguntas distintas: una
-- cuadra con el dinero del cajón, la otra con el informe de ventas.
ALTER TABLE cash_closings ADD COLUMN total_cobrado INTEGER NOT NULL DEFAULT 0;
