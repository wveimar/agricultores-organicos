-- ───────────────────────── Punto de venta (caja física) ─────────────────────────
--
-- Añade lo que necesita el mostrador. Todo lo de aquí es ADITIVO y se puede
-- aplicar en caliente sobre una base con datos.
--
-- Lo que NO está aquí, y por qué: quitarles el CHECK a `orders.metodo_pago`,
-- `payments.metodo` y las columnas de canal. Eso exige recrear las tablas, y
-- recrear `orders` o `payments` es imposible en D1 en cuanto tienen filas (ver
-- la nota larga junto a `orders.metodo_pago` en schema.sql y la migración 0031,
-- que murió intentándolo).
--
-- Como el proyecto todavía no está en producción, el modelo limpio vive en
-- schema.sql y la base se reconstruye entera:
--
--     npm run db:reset
--
-- Si esta base YA tuviera datos que conservar, el camino sería exportar,
-- reconstruir con schema.sql y reimportar; no hay forma de hacerlo con una
-- migración incremental.
--
-- Estas sentencias existen igualmente para que una base que solo aplique
-- migraciones no se quede sin las columnas nuevas. Las que puedan estar ya
-- puestas por `db:reset` fallarían con "duplicate column", así que esta
-- migración se salta en una base reconstruida — que es el caso normal hoy.

-- De dónde salió la venta: 'ecommerce' o 'pos'. Es lo que permite tener dos
-- cierres de caja separados —tienda web y mostrador— que luego se suman en un
-- consolidado. Se llama `canal` y no `origen` porque `products.origen` ya
-- significa "de qué finca viene".
ALTER TABLE orders ADD COLUMN canal TEXT NOT NULL DEFAULT 'ecommerce';

-- Si el cliente pidió recibo impreso. Dato operativo del mostrador; NO
-- condiciona la reimpresión, que siempre está disponible desde la factura.
ALTER TABLE orders ADD COLUMN recibo_solicitado INTEGER NOT NULL DEFAULT 0;

-- En qué caja entró la plata. `payments` no tiene FK a `orders`, así que sin
-- esto el cierre del mostrador no podría distinguir sus cobros de los de
-- cartera al barrer `closing_id IS NULL`.
ALTER TABLE payments      ADD COLUMN canal TEXT NOT NULL DEFAULT 'ecommerce';
ALTER TABLE cash_closings ADD COLUMN canal TEXT NOT NULL DEFAULT 'ecommerce';

-- Por qué esta línea no salió al precio calculado. NULL = precio automático.
-- Con texto = el cajero lo cambió a mano, y esto es la razón que dio. El
-- negocio decidió no poner tope al descuento manual: el control es que quede
-- registrado. El "quién" ya lo captura `order_status_log.actor_id`.
ALTER TABLE order_items ADD COLUMN motivo_ajuste TEXT;

-- Lo que teclea el lector del mostrador. Nullable: casi nada de lo que vende
-- una finca trae código impreso, así que el buscador por nombre sigue siendo
-- el camino principal y el escaneo es el atajo cuando lo hay.
ALTER TABLE products ADD COLUMN codigo_barras TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_canal
  ON orders (canal, creado_en DESC) WHERE canal = 'pos';
CREATE INDEX IF NOT EXISTS idx_closings_canal ON cash_closings (canal, cerrado_en DESC);
CREATE INDEX IF NOT EXISTS idx_payments_canal ON payments (canal, closing_id);

-- Único pero parcial, mismo patrón que `idx_contacts_telefono`: dos productos
-- no pueden compartir código, pero los muchos que no tienen ninguno no chocan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_codigo_barras
  ON products (codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- Ajustes que un SUPER_ADMIN cambia en vivo desde el panel, sin desplegar.
CREATE TABLE IF NOT EXISTS app_settings (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO app_settings (clave, valor) VALUES ('pos_recibo_por_defecto', '1');
