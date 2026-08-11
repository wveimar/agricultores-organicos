-- ============================================================================
--  Purga las imágenes de comprobante de los pedidos ya cerrados.
--
--  A partir de ahora el cierre de caja las borra solo (ver `closeCash` en
--  worker/src/routes/reports.ts). Esto limpia lo que quedó de antes: pedidos
--  archivados en cierres anteriores al despliegue de esa lógica.
--
--  Qué NO toca, y por qué:
--  · Los pedidos con `closing_id IS NULL` conservan su imagen. Son la jornada
--    abierta: la consignación puede estar todavía sin verificar, y ahí el
--    comprobante sigue siendo la única prueba de que el cliente pagó.
--  · `comprobante_nombre` se conserva siempre. No ocupa nada y es lo que
--    permite distinguir después "nunca mandó comprobante" de "lo mandó y se
--    purgó al cerrar".
--
--  Es idempotente: volver a ejecutarla no hace nada.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0002_purgar_comprobantes_cerrados.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0002_purgar_comprobantes_cerrados.sql
-- ============================================================================

UPDATE orders
   SET comprobante_url = NULL
 WHERE closing_id IS NOT NULL
   AND comprobante_url IS NOT NULL;
