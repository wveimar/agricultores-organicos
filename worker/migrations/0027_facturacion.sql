-- ─────────────────────────── Módulo de facturación ───────────────────────────
--
-- Hasta ahora el pedido hacía de factura: `orders.total` era a la vez lo que se
-- despachó y lo que se debía. Funcionaba mientras cobrar fuera un sí o un no,
-- pero se rompe en cuanto un cliente abona por partes — no hay dónde anotar que
-- de $45.000 entraron $20.000.
--
-- Esta migración separa las dos cosas, que es lo que hacen Odoo, QuickBooks y
-- Stripe por el mismo motivo:
--
--   · El PEDIDO es logística. Qué salió de la bodega, a qué dirección, con qué
--     domiciliario. Se puede editar (migración 0009) porque la realidad física
--     cambia: faltó un aguacate, se cambió por otro.
--   · La FACTURA es contabilidad. Congela lo que se pactó y NO se edita nunca.
--     Si hay que corregirla se anula y se emite otra. Si los abonos colgaran de
--     un pedido editable, la deuda del cliente se movería bajo sus pies cada
--     vez que alguien tocara una línea.
--
-- La tabla de abonos (`payments` + `payment_allocations`) llega en la 0028.
-- Aquí solo nace el documento; su `saldo` todavía lo mueven los caminos de
-- cobro que ya existen (`markPaid`, `collectCredit`, `cancel`).

CREATE TABLE invoices (
  id                TEXT    PRIMARY KEY,

  -- Consecutivo de la numeración. Es INTEGER y no se deriva de COUNT(*):
  -- contar filas reutilizaría un número si alguna vez se borra una factura, y
  -- un consecutivo con huecos es un problema, pero uno repetido es un fraude.
  consecutivo       INTEGER NOT NULL UNIQUE,
  -- Lo que se lee e imprime: «FAC-000123». Se guarda ya formateado en vez de
  -- componerlo al mostrarlo porque el día que haya resolución DIAN el prefijo
  -- cambia, y las facturas ya emitidas tienen que conservar el número con el
  -- que salieron.
  numero            TEXT    NOT NULL UNIQUE,

  -- El pedido que la originó.
  --
  -- RESTRICT y no CASCADE: una factura emitida es un hecho contable, y borrar
  -- el pedido no puede llevársela por delante. Es el mismo criterio que usan
  -- `order_items` y `provider_purchase_items` con `products`.
  --
  -- NULL permitido a propósito: deja la puerta abierta a una venta de mostrador
  -- que nunca pasó por el carrito.
  order_id          TEXT    REFERENCES orders(id)   ON DELETE RESTRICT,

  -- A quién se le cobra. Apunta a `contacts` y no a `users` por lo mismo que el
  -- crédito en la 0023: se compra sin cuenta, y la deuda es de una persona, no
  -- de un login.
  contact_id        TEXT    REFERENCES contacts(id) ON DELETE RESTRICT,

  -- Copia congelada de a quién se le facturó, igual que `orders.cliente_nombre`.
  -- Si mañana el contacto se renombra o se muda, la factura tiene que seguir
  -- diciendo a quién se le vendió ese día.
  cliente_nombre    TEXT    NOT NULL,
  cliente_telefono  TEXT    NOT NULL DEFAULT '',

  subtotal          INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  envio             INTEGER NOT NULL DEFAULT 0 CHECK (envio    >= 0),
  total             INTEGER NOT NULL DEFAULT 0 CHECK (total    >= 0),

  -- Lo que falta por cobrar.
  --
  -- Materializado y no calculado con SUM() sobre los abonos: la cartera
  -- pregunta «¿quién me debe?» en cada carga del panel, y resolverlo con una
  -- agregación por factura crece mal. Odoo hace lo mismo (`amount_residual`).
  -- El riesgo de que se desincronice se cubre recalculándolo SIEMPRE dentro del
  -- mismo `batch()` que inserta el abono, que en D1 es una transacción.
  saldo             INTEGER NOT NULL DEFAULT 0 CHECK (saldo >= 0),

  -- 'emitida'        → nace aquí, con saldo = total
  -- 'pagada_parcial' → hay abonos pero todavía debe
  -- 'pagada'         → saldo 0
  -- 'anulada'        → se deshizo; una factura no se borra ni se edita
  estado            TEXT    NOT NULL DEFAULT 'emitida'
                            CHECK (estado IN ('emitida', 'pagada_parcial', 'pagada', 'anulada')),

  emitida_en        TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Cuándo vence lo fiado. Se copia de `orders.vence_en`, que sale a su vez del
  -- `dias_credito` del contacto. NULL en lo que no es a crédito.
  vence_en          TEXT,

  anulada_en        TEXT,
  anulada_por       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  motivo_anulacion  TEXT

  -- Aquí vivía `CHECK (saldo <= total)`. Se quitó al llegar las notas débito
  -- (migración 0030): una nota débito es un cargo extra sobre una factura ya
  -- emitida —un interés de mora, un reenvío— y hace que el saldo pase por
  -- encima del total original a propósito. El CHECK que protegía de un abono
  -- mal restado habría bloqueado el caso legítimo.
);

-- Un pedido tiene como mucho una factura viva. Parcial sobre las no anuladas:
-- anular y reemitir es justamente el camino previsto para corregir, así que un
-- pedido puede acumular varias anuladas y una buena.
CREATE UNIQUE INDEX idx_invoices_order_viva
  ON invoices (order_id) WHERE order_id IS NOT NULL AND estado <> 'anulada';

-- La pregunta de la cartera: «¿quién me debe y desde cuándo?». Los tres campos
-- en el índice la resuelven sin tocar la tabla.
CREATE INDEX idx_invoices_cartera ON invoices (estado, vence_en);
-- El estado de cuenta de un cliente.
CREATE INDEX idx_invoices_contact ON invoices (contact_id, emitida_en DESC);

-- ────────────────────────── Líneas de la factura ──────────────────────────
--
-- Congeladas, igual que `order_items`: qué se cobró, cuánto y a qué precio EL
-- DÍA de la venta. Si mañana sube el tomate, la factura vieja tiene que seguir
-- diciendo lo que se pactó.
--
-- Existen para que una factura pueda vivir sin pedido detrás — una venta de
-- mostrador, un servicio, un empaque especial. Sin ellas, facturar a mano
-- obligaría a inventar un pedido falso solo para tener qué cobrar.
CREATE TABLE invoice_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE, al revés que casi todo lo demás: una línea no significa nada sin
  -- su factura, así que borrar la factura se las lleva. Lo que NO se borra es
  -- una factura con dinero encima, y eso lo defiende el endpoint.
  invoice_id      TEXT    NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  -- NULL permitido: se puede cobrar algo que no está en el catálogo. Y SET
  -- NULL, no RESTRICT, porque retirar un producto del catálogo no puede
  -- bloquear el borrado de nada ni reescribir una factura ya emitida — para
  -- eso está `descripcion`, que guarda el nombre tal cual se cobró.
  product_id      TEXT    REFERENCES products(id) ON DELETE SET NULL,
  descripcion     TEXT    NOT NULL,
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario >= 0),
  -- Redundante con cantidad × precio, y a propósito: es la cifra que se
  -- imprimió. Recalcularla al leer haría que un cambio futuro en cómo se
  -- redondea reescribiera facturas viejas.
  importe         INTEGER NOT NULL CHECK (importe >= 0)
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items (invoice_id);

-- ─────────────────────────── Facturas de lo ya vendido ───────────────────────
--
-- Todo pedido que llegó a aprobarse alguna vez tuvo su documento contable, solo
-- que implícito. Se emiten ahora para que la cartera arranque cuadrada y no con
-- el histórico en blanco.
--
-- El consecutivo sale de `ROW_NUMBER()` sobre la fecha de aprobación: así la
-- numeración queda en el orden en que de verdad ocurrieron las ventas, no en el
-- orden en que SQLite decida leer la tabla.
INSERT INTO invoices (
  id, consecutivo, numero, order_id, contact_id,
  cliente_nombre, cliente_telefono,
  subtotal, envio, total, saldo, estado, emitida_en, vence_en
)
SELECT
  'inv-' || o.id,
  ROW_NUMBER() OVER (ORDER BY o.aprobado_en, o.id),
  'FAC-' || printf('%06d', ROW_NUMBER() OVER (ORDER BY o.aprobado_en, o.id)),
  o.id,
  o.contact_id,
  o.cliente_nombre,
  o.cliente_telefono,
  o.subtotal,
  o.envio,
  o.total,
  -- Lo cobrado y lo cancelado no deben nada; el resto debe todo. Es lo más
  -- fiel que se puede reconstruir: hasta hoy no existía el abono parcial, así
  -- que no hay pagos a medias que recuperar.
  CASE WHEN o.estado IN ('pago', 'cancelado') THEN 0 ELSE o.total END,
  CASE o.estado
    WHEN 'pago'      THEN 'pagada'
    WHEN 'cancelado' THEN 'anulada'
    ELSE 'emitida'
  END,
  o.aprobado_en,
  o.vence_en
FROM orders o
WHERE o.aprobado_en IS NOT NULL;

-- Y sus líneas, copiadas de las del pedido. `importe` se calcula aquí una vez
-- y queda congelado.
INSERT INTO invoice_items (invoice_id, product_id, descripcion, cantidad, precio_unitario, importe)
SELECT 'inv-' || oi.order_id,
       oi.product_id,
       oi.producto_nombre,
       oi.cantidad,
       oi.precio_unitario,
       oi.cantidad * oi.precio_unitario
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
 WHERE o.aprobado_en IS NOT NULL;
