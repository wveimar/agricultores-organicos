-- 0036 · Abonos parciales a las fincas
--
-- ── Qué estaba mal ──
--
-- `provider_purchases.estado` era binario: 'pendiente' o 'pagado'. O se le
-- giraba TODO al agricultor, o no se le giraba nada. En la vida real eso no
-- pasa: se le abona lo que hay hoy y el resto el viernes, y hasta ahora eso no
-- se podía anotar en ningún lado — quedaba en la libreta del dueño.
--
-- ── Por qué una tabla y no una columna ──
--
-- La tentación es añadir `monto_pagado` y sumar ahí. No alcanza: Tesorería
-- necesita UNA FILA POR MOVIMIENTO, cada una con su fecha, su cuenta y su
-- monto, porque un abono en efectivo del lunes y otro por transferencia del
-- viernes salen de bolsillos distintos. Con una sola columna la compra no
-- podría decir de dónde salió cada parte, y el libro de movimientos —que es lo
-- que cuadra contra el cajón— mentiría.
--
-- Es la misma forma que ya tiene el lado de los clientes: `payments` guarda
-- cada cobro y `payment_allocations` a qué factura fue. Aquí `provider_payments`
-- guarda cada giro y a qué compra fue.
--
-- `monto_pagado` sí se añade, pero como CACHÉ de la suma, no como verdad: se
-- recalcula desde la tabla en el mismo lote que inserta el abono, nunca se
-- incrementa a ciegas. Así no puede desviarse.

CREATE TABLE provider_payments (
  id          TEXT    PRIMARY KEY,
  -- CASCADE porque un abono no significa nada sin su compra. Borrar una compra
  -- con abonos no se permite en el Worker justamente por eso: sería borrar el
  -- rastro de plata que ya salió de una cuenta.
  purchase_id TEXT    NOT NULL REFERENCES provider_purchases(id) ON DELETE CASCADE,
  monto       INTEGER NOT NULL CHECK (monto > 0),
  -- Efectivo o transferencia. Sin CHECK, igual que `payments.metodo`: la lista
  -- vive en el Worker, donde ampliarla no obliga a recrear la tabla.
  metodo      TEXT    NOT NULL DEFAULT 'transferencia',
  -- De qué cuenta salió. Es lo que hace que el giro baje el saldo correcto.
  cuenta_id   TEXT    REFERENCES treasury_accounts(id),
  nota        TEXT,
  pagado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  pagado_en   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_provider_payments_compra ON provider_payments (purchase_id, pagado_en DESC);
CREATE INDEX idx_provider_payments_cuenta ON provider_payments (cuenta_id, pagado_en DESC);

-- Sin CHECK que mire `total_pago`: un CHECK añadido con ADD COLUMN no puede
-- referirse a otra columna. El tope de "no se abona más de lo que se debe" lo
-- pone el Worker, dentro del propio INSERT.
ALTER TABLE provider_purchases ADD COLUMN monto_pagado INTEGER NOT NULL DEFAULT 0;

-- Lo ya girado se convierte en un abono único por el total, para que el libro
-- de movimientos siga mostrando exactamente los mismos pagos que antes.
INSERT INTO provider_payments (id, purchase_id, monto, metodo, cuenta_id, nota, pagado_por, pagado_en)
SELECT 'ppay-' || c.id,
       c.id,
       c.total_pago,
       CASE WHEN c.cuenta_id = 'caja-efectivo' THEN 'efectivo' ELSE 'transferencia' END,
       COALESCE(c.cuenta_id, 'cuenta-bancaria'),
       'Giro completo registrado antes de que hubiera abonos',
       c.pagado_por,
       COALESCE(c.pagado_en, c.creado_en)
  FROM provider_purchases c
 WHERE c.estado = 'pagado' AND c.total_pago > 0;

UPDATE provider_purchases SET monto_pagado = total_pago WHERE estado = 'pagado';
