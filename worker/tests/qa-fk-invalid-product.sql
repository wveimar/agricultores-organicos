-- ============================================================================
--  QA · Caso 2 — la FK debe RECHAZAR un product_id que no existe
--
--  Este comando debe FALLAR. Si en algún entorno tiene éxito, es la señal de
--  que `PRAGMA foreign_keys = ON` no está activo ahí y las relaciones
--  declaradas en el esquema no se están aplicando de verdad — hay que
--  investigarlo antes de confiar en cualquier otro resultado de este plan.
--
--  Uso (se ejecuta aparte para no abortar el resto de la suite):
--    npx wrangler d1 execute DB --local  --file=worker/tests/qa-fk-invalid-product.sql
--    npx wrangler d1 execute DB --remote --file=worker/tests/qa-fk-invalid-product.sql
-- ============================================================================

INSERT INTO order_items (order_id, product_id, producto_nombre, precio_unitario, costo_unitario, cantidad)
VALUES ('qa-fk-test-order', 'producto-que-no-existe', 'Fantasma', 1000, 500, 1);
