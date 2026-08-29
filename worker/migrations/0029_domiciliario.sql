-- ─────────────────── Asignación de domiciliario (módulo 3) ───────────────────
--
-- El rol DOMICILIARIO existe desde antes y puede confirmar entregas y cobrar en
-- la puerta, pero ningún pedido guardaba QUIÉN lo llevaba. En la práctica eso
-- significa que:
--
--   · la pantalla de Entregas le enseña a cada domiciliario todos los pedidos
--     en la calle, no los suyos;
--   · al cuadrar el efectivo no hay forma de saber a quién reclamarle qué;
--   · no se puede medir cuántas entregas hace cada uno.
--
-- Una columna en `orders` y no una tabla de asignaciones: un pedido lo lleva
-- una persona a la vez, y el histórico de reasignaciones ya lo cubre
-- `order_status_log`, que es donde vive el resto de la biografía del pedido.
--
-- SET NULL y no RESTRICT: si un domiciliario deja de trabajar y se borra su
-- cuenta, el pedido tiene que seguir existiendo. Se pierde el nombre, no la
-- venta — por eso `domiciliario_nombre` guarda una copia congelada, igual que
-- `cliente_nombre` guarda la del cliente.
ALTER TABLE orders ADD COLUMN domiciliario_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN domiciliario_nombre TEXT;

-- "¿Qué llevo yo hoy?", la pregunta de la pantalla del domiciliario. Parcial:
-- la enorme mayoría de los pedidos nunca tiene domiciliario asignado (se
-- recogen en la finca), y esos no ocupan sitio en el índice.
CREATE INDEX idx_orders_domiciliario
  ON orders (domiciliario_id, estado) WHERE domiciliario_id IS NOT NULL;
