-- ============================================================================
--  PUESTA A CERO PARA PRODUCCIÓN
--
--  Deja la base lista para empezar a operar de verdad: borra TODO el
--  historial de movimiento (pedidos, facturas, cobros, compras, mermas,
--  cierres) y conserva lo que es catálogo y configuración.
--
--  SE CONSERVA                        SE BORRA
--  ─────────────────────────────      ─────────────────────────────────────
--  products                           orders / order_items / status_log
--  product_components (recetas)       invoices / invoice_items / refunds
--  product_wholesale_discounts        payments / payment_allocations
--  categories                         provider_purchases / items / payments
--  admin_groups                       expenses
--  treasury_accounts (las cuentas)    treasury_movements
--  app_settings (módulos, ajustes)    cash_closings / cashier_shifts
--  contacts SOLO proveedores          mermas / merma_items
--    + la ficha 'consumidor-final'    contacts de clientes
--                                     users / user_roles  (TODOS)
--
--  El superusuario NO se crea aquí: la contraseña hay que derivarla con
--  PBKDF2 y eso no se puede hacer en SQL. Después de este archivo, corre:
--
--      node worker/tools/crear-superusuario.mjs <correo> <clave> "<nombre>"
--
--  Uso:
--      npm run db:limpiar              (local)
--      npm run db:limpiar:remote       (producción — no tiene vuelta atrás)
--
--  ⚠ No borra los productos ni toca `stock_actual`. Si quieres que el
--    inventario arranque en cero, descomenta el UPDATE del final.
-- ============================================================================

-- ─────────────── 1. Cartera y facturación ───────────────
-- Primero los hijos: invoices tiene RESTRICT desde varias direcciones.
DELETE FROM payment_allocations;
DELETE FROM invoice_refunds;
DELETE FROM invoice_items;
DELETE FROM invoices;
DELETE FROM payments;

-- ─────────────── 2. Pedidos y ventas ───────────────
DELETE FROM order_item_components;
DELETE FROM order_items;
DELETE FROM order_status_log;
DELETE FROM orders;

-- ─────────────── 3. Compras a fincas ───────────────
DELETE FROM provider_payments;
DELETE FROM provider_purchase_items;
DELETE FROM provider_purchases;

-- ─────────────── 4. Mermas ───────────────
DELETE FROM merma_items;
DELETE FROM mermas;

-- ─────────────── 5. Tesorería ───────────────
DELETE FROM expenses;
DELETE FROM treasury_movements;
DELETE FROM cash_closings;
DELETE FROM cashier_shifts;
-- Las cuentas se quedan, pero arrancan sin saldo de apertura: el que tenía
-- venía de la demo. El saldo real se pone al abrir el primer turno.
UPDATE treasury_accounts SET saldo_inicial = 0;

-- ─────────────── 6. Rastros de sesión ───────────────
DELETE FROM login_attempts;
DELETE FROM password_resets;

-- ─────────────── 7. Contactos ───────────────
-- Se conservan las fincas proveedoras (son el origen del catálogo) y la ficha
-- 'consumidor-final', que la caja necesita para la venta de mostrador sin
-- identificar. Los clientes se cargan desde el panel con los datos reales.
DELETE FROM contacts
 WHERE id <> 'consumidor-final'
   AND es_proveedor = 0;

-- ─────────────── 8. Usuarios ───────────────
-- Todos fuera, incluidas las cuentas de demo cuya contraseña está publicada
-- en el repositorio. user_roles cae solo por ON DELETE CASCADE.
DELETE FROM users;

-- ─────────────── 9. Inventario (opcional) ───────────────
-- Descomenta si quieres que cada producto arranque en cero y el stock se
-- llene únicamente registrando entradas de mercancía reales.
-- UPDATE products SET stock_actual = 0;
