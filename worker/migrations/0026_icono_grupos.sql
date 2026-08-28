-- ============================================================================
--  Ícono por grupo del panel de compras.
--
--  Mismo tratamiento que la migración 0016 le dio a las categorías: guarda
--  una CLAVE ('hoja', 'panal', 'canasta'...), no un dibujo. El repertorio de
--  siluetas es código (`CategoryIcon`, en shared/category-icon) — son SVG
--  monocromos que heredan el color de donde se pinten, y ya sirve tanto a
--  categorías como a grupos sin cambiar nada en el componente.
--
--  Sin CHECK a propósito: la lista de claves válidas la decide `CategoryIcon`,
--  y una clave que no exista cae en la silueta por defecto en vez de reventar
--  el INSERT — igual que en categorías. Vacío es un valor legítimo: «la que
--  sea», se pinta la hoja.
--
--  `admin_groups` no tiene las complicaciones de `products` (sin FK con
--  ON DELETE RESTRICT apuntándole), así que un `ALTER TABLE` simple basta —
--  no hace falta el rodeo de columna nueva que sí hizo falta en la 0025 para
--  `grupo_admin_id`.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0026_icono_grupos.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0026_icono_grupos.sql
-- ============================================================================

ALTER TABLE admin_groups ADD COLUMN icono TEXT NOT NULL DEFAULT '';

-- Sembrado de los tres que ya existían. `WHERE icono = ''` para no pisar una
-- elección ya hecha desde el panel si esto se corre dos veces.
UPDATE admin_groups SET icono = 'fruta'   WHERE id = 'frutas'           AND icono = '';
UPDATE admin_groups SET icono = 'hoja'    WHERE id = 'verduras'         AND icono = '';
UPDATE admin_groups SET icono = 'canasta' WHERE id = 'agroindustriales' AND icono = '';
