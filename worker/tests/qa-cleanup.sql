-- ============================================================================
--  QA · Limpieza — borra únicamente los datos que dejan los scripts de esta
--  carpeta. Filtra por el prefijo 'QA-' en la referencia, así que nunca toca
--  un pedido real (los reales siguen el formato ORD-####).
--
--  Uso:
--    npx wrangler d1 execute DB --local  --file=worker/tests/qa-cleanup.sql
--    npx wrangler d1 execute DB --remote --file=worker/tests/qa-cleanup.sql
-- ============================================================================

DELETE FROM order_status_log WHERE order_id IN (SELECT id FROM orders WHERE referencia LIKE 'QA-%');
DELETE FROM order_items      WHERE order_id IN (SELECT id FROM orders WHERE referencia LIKE 'QA-%');
DELETE FROM orders           WHERE referencia LIKE 'QA-%';

-- Confirmación: debe devolver cero filas.
SELECT COUNT(*) AS pedidos_qa_restantes FROM orders WHERE referencia LIKE 'QA-%';
