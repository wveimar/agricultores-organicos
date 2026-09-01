-- ───────────────────────── Punto de venta (caja física) ─────────────────────────
--
-- Hasta ahora toda venta nacía en la web: `orders.create()` la deja en
-- 'verificacion' con el stock ya reservado y alguien la aprueba después. En el
-- mostrador ese desfase no existe —el cajero ve salir el producto y entrar el
-- dinero en el mismo instante— así que la venta de caja escribe el pedido ya
-- aprobado, emite la factura y registra el cobro en un solo batch.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  POR QUÉ ESTA MIGRACIÓN ES 100% ADITIVA Y NO TOCA NINGÚN CHECK           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Ampliar el CHECK de `orders.metodo_pago` exigiría recrear la tabla, y eso NO
-- SE PUEDE HACER en una base D1 que ya tiene pedidos. Se comprobó midiéndolo,
-- sobre una copia local con datos reales; las cuatro vías fallan:
--
--   1. `DROP TABLE orders` + RENAME (el patrón clásico, el de la 0031)
--      → FOREIGN KEY constraint failed (SQLITE_CONSTRAINT_TRIGGER). El DELETE
--        implícito del DROP choca con el RESTRICT de `invoices.order_id` y
--        además dispararía los CASCADE de `order_items`, `order_status_log` y
--        `order_item_components`.
--
--   2. `PRAGMA foreign_keys = OFF` → inerte. Wrangler envuelve el fichero en
--      una transacción, y ese pragma no hace nada dentro de una.
--
--   3. `PRAGMA defer_foreign_keys = true` → aplaza la comprobación, pero en el
--      COMMIT el contador de violaciones sigue en pie y D1 revierte entera la
--      migración («Durable Object was reset and rolled back»).
--
--   4. `PRAGMA legacy_alter_table = ON` + doble renombrado (apartar la vieja en
--      vez de borrarla) → las FK de las tablas hijas siguieron el renombrado
--      igualmente y el DROP final volvió a chocar.
--
-- En los cuatro casos los datos quedaron intactos, porque D1 revierte la
-- transacción completa. Pero el cambio no se aplica, ni se puede.
--
-- De ahí el modelo: `metodo_pago` se queda para siempre con los tres valores
-- que ya tiene —de dónde sale el dinero— y el detalle de CÓMO se pagó vive en
-- `medio_pago`, una columna nueva SIN CHECK que sí se puede añadir en caliente.
--
--   metodo_pago = 'contraentrega' + medio_pago = 'efectivo'   → venta en caja
--   metodo_pago = 'contraentrega' + medio_pago = 'tarjeta'    → venta en caja
--   metodo_pago = 'contraentrega' + medio_pago = 'entrega_en_tienda'
--                                                → compra web que se retira
--   metodo_pago = 'credito'                      → fiado, en web o en caja
--
-- 'contraentrega' no es un apaño: significa "se paga al recibir", que es
-- literalmente lo que pasa en un mostrador y lo que pasa cuando alguien va a
-- recoger su pedido. El efecto secundario es bueno: `RECAUDADO_WHERE` ya
-- cuenta 'contraentrega' con estado 'pago' y efectivo_liquidado = 1, así que
-- la venta de caja entra sola en el cierre sin tocar esa constante.

-- ══════════════════════════ orders: cuatro columnas ══════════════════════════

-- De dónde salió la venta. Es lo que permite el requisito de negocio de tener
-- DOS cierres de caja separados —tienda web y mostrador— que luego se suman en
-- un consolidado. Va como columna y no como tabla `pos_cash_closings` aparte a
-- propósito: una tabla paralela obligaría a duplicar RECAUDADO_WHERE y
-- closeCash(), y dos verdades sobre el mismo hecho es justo lo que advierte el
-- comentario largo de esa constante en routes/reports.ts.
--
-- Se llama `canal` y no `origen` porque `products.origen` ya significa "de qué
-- finca viene": reusar el nombre confundiría al leer el código.
--
-- Sin CHECK, como todo aquí. El único escritor es el Worker.
ALTER TABLE orders ADD COLUMN canal TEXT NOT NULL DEFAULT 'ecommerce';

-- Cómo se pagó de verdad, cuando `metodo_pago` se queda corto. NULL en todo lo
-- anterior a esta migración y en las compras web de siempre: significa "lo que
-- diga metodo_pago, sin matices".
ALTER TABLE orders ADD COLUMN medio_pago TEXT;

-- Si el cliente pidió recibo impreso en el mostrador. Dato operativo; NO
-- condiciona la reimpresión: cualquier factura se puede volver a imprimir
-- siempre desde GET /api/admin/invoices/:id.
ALTER TABLE orders ADD COLUMN recibo_solicitado INTEGER NOT NULL DEFAULT 0;

-- "Las ventas de caja de hoy", que es lo que pregunta el historial del POS en
-- cada carga. Parcial: la caja física es una fracción de todos los pedidos.
CREATE INDEX IF NOT EXISTS idx_orders_canal
  ON orders (canal, creado_en DESC) WHERE canal = 'pos';

-- ═══════════════════════ cash_closings y payments ═══════════════════════

-- Qué caja se cerró. El consolidado agrupa por esta columna para sumar las dos.
ALTER TABLE cash_closings ADD COLUMN canal TEXT NOT NULL DEFAULT 'ecommerce';

-- En qué caja entró la plata. `payments` no tiene FK a `orders`, así que sin
-- esta columna el cierre del mostrador no podría distinguir sus cobros de los
-- de cartera al barrer `closing_id IS NULL`. Es también lo que hace que un
-- abono que alguien viene a pagar a la tienda cuadre contra el cierre del POS:
-- ese billete está en ESE cajón, no en el de la finca.
ALTER TABLE payments ADD COLUMN canal TEXT NOT NULL DEFAULT 'ecommerce';

-- Mismo papel que `orders.medio_pago`: el CHECK de `payments.metodo` tampoco
-- admite 'tarjeta' y tampoco se puede ampliar (`payment_allocations` le cuelga
-- con CASCADE, así que recrear esta tabla se llevaría la asignación de cobros a
-- facturas, o sea la cartera entera). El cobro se registra como 'efectivo'
-- —para el cierre lo relevante es que la plata está en la caja desde el primer
-- segundo, sin el desfase de `liquidado` que sí tiene el domiciliario— y aquí
-- queda el instrumento real.
ALTER TABLE payments ADD COLUMN medio_pago TEXT;

CREATE INDEX IF NOT EXISTS idx_closings_canal ON cash_closings (canal, cerrado_en DESC);
CREATE INDEX IF NOT EXISTS idx_payments_canal ON payments (canal, closing_id);

-- ═══════════════════════════ order_items y products ═══════════════════════════

-- Por qué esta línea no salió al precio calculado. NULL = precio automático, de
-- lista o con el descuento de mayorista que le toque al cliente. Con texto = el
-- cajero lo cambió a mano, y esto es la razón que dio.
--
-- El negocio decidió no poner tope al descuento manual: el control es que quede
-- registrado, no un límite en el código. El "quién" no se duplica aquí — ya lo
-- captura `order_status_log.actor_id` en la fila 'editado' que se escribe en la
-- misma transacción.
ALTER TABLE order_items ADD COLUMN motivo_ajuste TEXT;

-- Lo que teclea el lector del mostrador. No existía ningún campo de código de
-- barras ni SKU en el catálogo. Nullable porque casi nada de lo que vende una
-- finca trae código impreso —la fruta a granel no lo tiene—, así que la
-- búsqueda por nombre sigue siendo el camino principal de la caja y el escaneo
-- es el atajo cuando lo hay.
ALTER TABLE products ADD COLUMN codigo_barras TEXT;

-- Único pero parcial, mismo patrón que `idx_contacts_telefono`: dos productos
-- no pueden compartir código, pero los muchos que no tienen ninguno no chocan
-- entre sí ni ocupan sitio en el índice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_codigo_barras
  ON products (codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- ═══════════════════════════════ app_settings ═══════════════════════════════
-- Banderas que un SUPER_ADMIN cambia en vivo desde el panel, sin desplegar.
-- Clave-valor y no una columna por ajuste: son opciones de operación, no
-- entidades, y añadir la siguiente no puede costar otra migración.
CREATE TABLE IF NOT EXISTS app_settings (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Si la caja imprime recibo por defecto. El cajero puede cambiarlo en cada
-- venta —preguntándole al cliente—; esto solo decide cómo llega la casilla.
INSERT OR IGNORE INTO app_settings (clave, valor) VALUES ('pos_recibo_por_defecto', '1');

-- ═══════════════════ Arrastre de lo que dejó la 0031 ═══════════════════
-- Si alguna base alcanzó a guardar pedidos con metodo_pago = 'entrega_en_tienda'
-- (solo pudo pasar en local, donde la 0031 sí llegó a aplicarse sobre una base
-- vacía), se reescriben al modelo nuevo. En producción no toca ninguna fila.
UPDATE orders
   SET medio_pago  = 'entrega_en_tienda',
       metodo_pago = 'contraentrega'
 WHERE metodo_pago = 'entrega_en_tienda';
