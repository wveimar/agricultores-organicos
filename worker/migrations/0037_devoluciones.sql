-- 0037 · Devoluciones de dinero, trazadas a la nota crédito que las origina
--
-- ── El problema que resuelve ──
--
-- Una nota crédito ya podía emitirse contra una factura pagada por completo
-- —el propio `notaStatements()` lo permite a propósito, con un comentario que
-- dice «eso es justamente una devolución»— pero el sistema no tenía ningún
-- lugar donde esa devolución quedara. `invoices.saldo` está capado en 0
-- (`MAX(0, deuda - cobrado)`), así que la plata que el negocio le quedó
-- debiendo al cliente desaparecía: no en Cartera, no en Tesorería, en
-- ningún lado. Si alguien la devolvía de verdad, el único registro posible
-- era un «Egreso» genérico sin ningún vínculo con la nota que lo justificaba.
--
-- ── Por qué una tabla nueva y no reusar `treasury_movements` ──
--
-- `treasury_movements` es para plata suelta: un ingreso del dueño, un
-- traslado, un egreso sin más explicación que su concepto en texto libre.
-- Una devolución SÍ tiene un origen estructurado —una nota crédito concreta—
-- y la trazabilidad que se pidió es justo esa: poder ver, desde el egreso,
-- a cuál nota (y por la nota, a cuál factura) corresponde. Meterla en
-- `treasury_movements` habría dejado esa relación como texto suelto en
-- `concepto`, exactamente el problema que se quiere resolver.
--
-- Es la misma forma que `provider_payments` (migración 0036) para los abonos
-- a una finca: una fila por movimiento, cada una con su cuenta y su fecha,
-- referenciando el documento que la autoriza.
--
-- ── Por qué se referencia la NOTA y no la FACTURA ──
--
-- Una factura puede tener varias notas a lo largo del tiempo (como en este
-- caso: NC-000001 y NC-000002 sobre la misma factura). Atar la devolución a
-- la nota, y no directamente a la factura, es lo que permite decir con
-- precisión «este egreso de $400 es por ESTA nota» en vez de «esta factura
-- tuvo, en algún momento, alguna devolución». La factura sigue alcanzable:
-- toda nota ya guarda `invoice_origen_id`.

-- Caché del total ya devuelto de una nota crédito. Igual que `monto_pagado`
-- en `provider_purchases` (0036): se recalcula desde `invoice_refunds` en el
-- mismo batch que inserta cada devolución, nunca se incrementa a ciegas. Vive
-- en `invoices` porque esa es la tabla donde ya vive `saldo`, y `saldo` de una
-- nota es siempre 0 por diseño — este es el campo que sí varía para una nota.
ALTER TABLE invoices ADD COLUMN monto_devuelto INTEGER NOT NULL DEFAULT 0;

CREATE TABLE invoice_refunds (
  id                TEXT    PRIMARY KEY,
  -- CASCADE: una devolución no significa nada sin la nota que la autoriza. La
  -- nota misma no se puede anular teniendo devoluciones ya hechas (lo exige el
  -- Worker) por la misma razón que una compra con abonos no se puede borrar.
  nota_credito_id   TEXT    NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  monto             INTEGER NOT NULL CHECK (monto > 0),
  -- Sin CHECK, igual que en `payments.metodo` y `provider_payments.metodo`: la
  -- lista vive en el Worker, donde ampliarla no obliga a recrear la tabla.
  metodo            TEXT    NOT NULL DEFAULT 'efectivo',
  -- De qué cuenta salió. Deducida del método, igual que en los abonos a
  -- fincas: efectivo sale del cajón, transferencia del banco.
  cuenta_id         TEXT    REFERENCES treasury_accounts(id),
  observaciones     TEXT,
  devuelto_por      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  devuelto_en       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invoice_refunds_nota   ON invoice_refunds (nota_credito_id, devuelto_en DESC);
CREATE INDEX idx_invoice_refunds_cuenta ON invoice_refunds (cuenta_id, devuelto_en DESC);
