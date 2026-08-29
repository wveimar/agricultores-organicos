-- ─────────────────── Notas crédito y débito (módulo de cartera) ───────────────────
--
-- Una factura emitida no se edita. Hasta ahora eso dejaba un hueco: cuando algo
-- ya cobrado había que corregirlo —el cliente devolvió media caja, se le prometió
-- un descuento, se le cobró de más— no había instrumento. Solo quedaba anular la
-- factura entera, que borra también la parte que sí estuvo bien.
--
-- La nota es ese instrumento, y es lo que usan todos los sistemas contables:
--
--   · NOTA CRÉDITO → resta de la factura. Devolución, descuento, corrección a
--     favor del cliente. Es la forma correcta de deshacer algo ya cobrado.
--   · NOTA DÉBITO  → suma a la factura. Interés de mora, un reenvío, un cargo
--     que aparece después de haber facturado.
--
-- ── Por qué van en `invoices` y no en una tabla propia ──
--
-- Una nota ES un documento: tiene número, fecha, líneas, cliente y estado.
-- Duplicar `invoices` e `invoice_items` para ellas sería mantener dos veces la
-- misma forma, y cualquier consulta de "todo lo que le he emitido a este
-- cliente" tendría que hacer UNION de dos tablas para siempre. Odoo y
-- QuickBooks las guardan en la misma tabla que las facturas por este motivo;
-- lo único que cambia es el tipo y qué le hace al saldo de otra.
--
-- Series de numeración separadas (FAC-, NC-, ND-): mezclarlas en un mismo
-- consecutivo haría ilegible cualquiera de las tres.

ALTER TABLE invoices ADD COLUMN tipo TEXT NOT NULL DEFAULT 'factura';
ALTER TABLE invoices ADD COLUMN invoice_origen_id TEXT REFERENCES invoices(id) ON DELETE CASCADE;

CREATE INDEX idx_invoices_origen
  ON invoices (invoice_origen_id) WHERE invoice_origen_id IS NOT NULL;

-- OJO: los dos CHECK que `schema.sql` sí declara —el de `tipo` y el que exige
-- que una nota tenga origen y una factura no— NO se pueden añadir aquí.
-- SQLite no permite agregar una restricción de tabla con ALTER TABLE, y
-- recrear `invoices` arrastraría las FK con ON DELETE RESTRICT que ya le
-- apuntan desde `payment_allocations` e `invoice_items`.
--
-- Consecuencia práctica: en una base migrada, quien impone esas dos reglas es
-- el endpoint (`invoices.crearNota`), no el motor. En una base creada desde
-- cero con `schema.sql` las impone el motor además del endpoint. Es la misma
-- asimetría que dejó la 0025 con `products.grupo_admin`, y por la misma razón.
--
-- El `CHECK (saldo <= total)` de la 0027 tampoco existe ya en `schema.sql`:
-- una nota débito hace que el saldo pase del total original a propósito. En
-- una base migrada desde la 0027 ese CHECK sigue puesto y bloquearía la
-- primera nota débito, así que hay que recrear la tabla para quitarlo — pero
-- como la 0027 nunca llegó a producción, en la práctica basta con volver a
-- correr el esquema. Si alguna vez se aplicó la 0027 tal como estaba, hay que
-- recrear `invoices` a mano antes de usar notas débito.
