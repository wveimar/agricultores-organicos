-- ===========================================================================
-- 0016 · Ícono por categoría
-- ===========================================================================
--
-- Los chips de la vitrina llevan ahora un ícono. La pregunta era dónde vive.
--
-- En código no puede vivir: las categorías dejaron de ser una constante en la
-- migración 0013 justamente para que quien lleva el inventario pueda crearlas
-- desde el panel. Un `Record<CategoryId, icono>` compilado cubriría las diez
-- sembradas y ninguna de las que se creen después — el mismo problema que ya
-- tuvieron `ADMIN_GROUP_OF` (resuelto en la 0013 con `grupo_admin`) y la unión
-- cerrada `CategoryId`. Así que el ícono es una columna más de la fila.
--
-- Guarda una **clave**, no un dibujo: 'hoja', 'panal', 'espiga'… El repertorio
-- de siluetas sí es código (`CategoryIcon`, en `shared/category-icon`), porque
-- son SVG monocromos que heredan el color del chip y tienen que respetar la
-- paleta — un emoji no se puede teñir y se dibuja distinto en cada sistema.
-- Lo que decide el panel es cuál de esas siluetas le toca a cada categoría.
--
-- Aquí `ALTER TABLE` sí sirve, al contrario que en la 0005 o la 0015: aquellas
-- tenían que recrear la tabla porque cambiaban un CHECK, y SQLite no deja
-- alterarlo. Esta columna no lleva CHECK a propósito — la lista de claves
-- válidas la decide `CategoryIcon`, y una clave que no exista cae en la
-- silueta por defecto en vez de reventar el INSERT.
--
-- Vacío es un valor legítimo: significa «la que sea», y se pinta la hoja.
-- ===========================================================================

ALTER TABLE categories ADD COLUMN icono TEXT NOT NULL DEFAULT '';

-- ─────────────────── Sembrado de las diez de la 0013 ───────────────────
--  Mismo criterio que usó la 0013 al sembrar nombres y descripciones: son
--  datos iniciales, no un mapa que haya que mantener. Se emparejan por `id`,
--  y una categoría creada desde el panel simplemente no aparece aquí.
--
--  `WHERE icono = ''` para no pisar una elección ya hecha desde el panel si
--  esto llegara a correrse dos veces.

UPDATE categories SET icono = 'hoja'    WHERE id = 'verduras'  AND icono = '';
UPDATE categories SET icono = 'fruta'   WHERE id = 'frutas'    AND icono = '';
UPDATE categories SET icono = 'botella' WHERE id = 'lacteos'   AND icono = '';
UPDATE categories SET icono = 'panal'   WHERE id = 'mieles'    AND icono = '';
UPDATE categories SET icono = 'plato'   WHERE id = 'listos'    AND icono = '';
UPDATE categories SET icono = 'frasco'  WHERE id = 'fermentos' AND icono = '';
UPDATE categories SET icono = 'pan'     WHERE id = 'panaderia' AND icono = '';
UPDATE categories SET icono = 'espiga'  WHERE id = 'granos'    AND icono = '';
UPDATE categories SET icono = 'bolsa'   WHERE id = 'despensa'  AND icono = '';
UPDATE categories SET icono = 'canasta' WHERE id = 'canastas'  AND icono = '';
