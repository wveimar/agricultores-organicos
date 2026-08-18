-- ============================================================================
--  Normaliza `categoria_id` a la unión cerrada de `CategoryId`.
--
--  `categoria_id` no lleva CHECK en D1 (a propósito: el Worker solo exige que
--  no esté vacío). Eso es justo lo que dejó colar 'Miel' y 'Listos' —creados
--  a mano desde el panel, seguramente tecleados— en vez de 'mieles' y
--  'listos'. Sin CHECK que los rechace, esos productos se guardaron bien,
--  pero son invisibles bajo cualquier chip de la vitrina: el filtro compara
--  contra la unión `CategoryId` en minúscula y singular/plural exactos, y
--  "Miel" ≠ "mieles" para ese comparador. Solo aparecían en "Todo el huerto".
--
--  Esta migración no cambia esquema, solo datos: no hace falta recrear
--  ninguna tabla.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0010_normalizar_categorias.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0010_normalizar_categorias.sql
-- ============================================================================

UPDATE products SET categoria_id = 'mieles', actualizado_en = datetime('now')
 WHERE categoria_id = 'Miel';

UPDATE products SET categoria_id = 'listos', actualizado_en = datetime('now')
 WHERE categoria_id = 'Listos';
