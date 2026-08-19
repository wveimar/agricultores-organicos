-- ===========================================================================
--  0013 · Las categorías dejan de vivir en el código
--
--  Hasta ahora la lista estaba en tres sitios de TypeScript —la unión
--  `CategoryId`, la constante `CATEGORIES` y el mapa `ADMIN_GROUP_OF`— y
--  añadir una sección obligaba a tocar los tres y volver a desplegar. Peor:
--  el campo del panel era texto libre, así que se podía guardar un producto
--  con una categoría que no estaba en la unión. Eso ya pasó dos veces —lo
--  reparó la migración 0010 con 'Miel' y 'Listos', y volvió a pasar con
--  'fermentos', cuatro kambuchas que no salían bajo ningún chip.
--
--  Con la tabla, la lista tiene un solo dueño y el panel la edita.
--
--  `grupo_admin` viaja aquí y no en un mapa aparte por el mismo motivo: una
--  categoría creada en caliente no puede aparecer en un `Record` compilado.
--
--  Idempotente: se puede correr dos veces sin romper nada.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS categories (
  -- El id es el que ya llevan los productos en `categoria_id` ('verduras'),
  -- así que la tabla se puede sembrar sin tocar una sola fila de products.
  id             TEXT    PRIMARY KEY,
  nombre         TEXT    NOT NULL,
  -- Subtítulo de la rejilla cuando la categoría está activa.
  descripcion    TEXT    NOT NULL DEFAULT '',
  -- Agrupación macro del panel de compras.
  grupo_admin    TEXT    NOT NULL DEFAULT 'agroindustriales'
                 CHECK (grupo_admin IN ('frutas', 'verduras', 'agroindustriales')),
  -- Posición del chip en la vitrina. Se deja hueco entre valores para poder
  -- intercalar una categoría nueva sin renumerar las demás.
  orden          INTEGER NOT NULL DEFAULT 100,
  -- 0 = no se ofrece esta temporada. No se borra: los productos que la usan
  -- seguirían apuntando a un id inexistente.
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  actualizado_en TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Los chips se piden ordenados en cada carga de la tienda.
CREATE INDEX IF NOT EXISTS idx_categories_orden ON categories(activo, orden);

-- ───────────────────────── Sembrado inicial ─────────────────────────
--  Las diez que hoy están en `CATEGORIES`, con el grupo que les daba
--  `ADMIN_GROUP_OF`. `INSERT OR IGNORE` para no pisar ediciones ya hechas
--  desde el panel si esto se corre dos veces.

INSERT OR IGNORE INTO categories (id, nombre, descripcion, grupo_admin, orden) VALUES
  ('verduras',  'Verduras y raíces',   'Recolectadas al amanecer del domingo, en tu casa esa misma tarde.', 'verduras',         10),
  ('frutas',    'Frutas frescas',      'Maduradas en el árbol, nunca en cámara.',                            'frutas',           20),
  ('lacteos',   'Leche de cabra',      'De un hato pequeño en el altiplano, ordeñado a mano.',               'agroindustriales', 30),
  ('mieles',    'Mieles y apicultura', 'Miel, polen y propóleo de colmenares propios, sin pasteurizar.',     'agroindustriales', 40),
  ('listos',    'Listos para comer',   'Preparados cada mañana con la cosecha del día.',                     'agroindustriales', 50),
  ('fermentos', 'Fermentos',           'Kambuchas y fermentados vivos, embotellados sin pasteurizar.',       'agroindustriales', 60),
  ('panaderia', 'Panadería',           'Horneado el mismo día con harinas molidas en el altiplano.',         'agroindustriales', 70),
  ('granos',    'Granos y semillas',   'Molidos en piedra y empacados en lotes pequeños.',                   'agroindustriales', 80),
  ('despensa',  'Despensa',            'Lo que sostiene la cocina durante todo el mes.',                     'agroindustriales', 90),
  ('canastas',  'Canastas',            'La compra semanal resuelta en una sola caja.',                       'agroindustriales', 100);

-- Rescata cualquier categoría que los productos ya usen y que no esté arriba:
-- sin esto quedaría fuera de la lista y sus productos volverían a ser
-- invisibles bajo todos los chips, que es justo el fallo que esto viene a
-- cerrar. Entra desactivada y sin nombre bonito, para que salte a la vista en
-- el panel y alguien la revise.
INSERT OR IGNORE INTO categories (id, nombre, descripcion, grupo_admin, orden, activo)
SELECT DISTINCT p.categoria_id,
       p.categoria_id,
       '',
       p.grupo_admin,
       900,
       0
  FROM products p
 WHERE p.categoria_id IS NOT NULL
   AND p.categoria_id <> ''
   AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.id = p.categoria_id);
