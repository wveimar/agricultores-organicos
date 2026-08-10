-- ============================================================================
--  QA · Caso 1 — pedido multi-producto con FKs válidas
--
--  Inserta un pedido de prueba con tres líneas, cada una referenciando un
--  product_id real de tres categorías distintas (verduras, listos, despensa).
--  Prueba en un solo golpe: orders -> users (aprobado_por, aquí NULL),
--  order_items -> orders, y order_items -> products.
--
--  Uso:
--    npx wrangler d1 execute DB --local  --file=worker/tests/qa-fk-valid-order.sql
--    npx wrangler d1 execute DB --remote --file=worker/tests/qa-fk-valid-order.sql
--
--  Limpieza (ver qa-cleanup.sql): el pedido queda marcado con el prefijo
--  'QA-' en la referencia y 'QA · ' en el nombre del cliente, para poder
--  encontrarlo y borrarlo sin tocar pedidos reales.
-- ============================================================================

INSERT INTO orders (
  id, referencia, cliente_nombre, cliente_telefono, cliente_direccion,
  estado, stock_reservado, subtotal, envio, total
) VALUES (
  'qa-fk-test-order',
  'QA-FK-001',
  'QA · Cliente de prueba',
  '3000000000',
  'Direccion de prueba QA',
  'pendiente', 0, 0, 0, 0
);

INSERT INTO order_items (order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
VALUES
  ('qa-fk-test-order', 'p-01', 'Tomate Chonto en Rama',       9800,  7600, 2),
  ('qa-fk-test-order', 'p-15', 'Ensalada Arcoíris',          16900,  9300, 1),
  ('qa-fk-test-order', 'p-22', 'Café de Origen · Tueste Medio', 32000, 19800, 3);

-- Verificación: las tres líneas deben aparecer con su producto real via JOIN.
SELECT oi.product_id, p.nombre, oi.cantidad, oi.precio_unitario
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
 WHERE oi.order_id = 'qa-fk-test-order';
