-- ============================================================================
--  Los grupos del panel de compras dejan de ser tres literales fijos.
--
--  ── El problema ──
--
--  "Frutas" / "Verduras" / "Agroindustriales" vivían repetidos en tres sitios:
--  un CHECK en `products.grupo_admin`, otro en `categories.grupo_admin`, y un
--  tipo de TypeScript en el frontend (`AdminGroup`). Añadir un cuarto grupo, o
--  corregir el nombre de uno, exigía tocar los tres y desplegar — exactamente
--  el problema que la migración 0013 ya resolvió para las categorías.
--
--  ── Por qué NO se toca el CHECK de `products`/`categories` directamente ──
--
--  SQLite no permite quitar o cambiar un CHECK sin recrear la tabla entera.
--  Para `categories` sería barato — nada la referencia por FK — pero para
--  `products` NO: `order_items`, `order_item_components` y
--  `provider_purchase_items` le apuntan con `ON DELETE RESTRICT`, así que
--  recrearla arrastraría el histórico de ventas y de compras. Es el mismo
--  motivo por el que la migración 0012 (variantes) usó `ALTER TABLE` en vez de
--  recrear `products`.
--
--  La solución: una columna NUEVA, `grupo_admin_id`, sin CHECK, que reemplaza
--  a `grupo_admin` en el código. La columna vieja queda en la tabla, sin uso
--  —igual que `users.cupo_credito` tras la 0023—, porque quitarla también
--  exigiría recrear `products`.
--
--  `grupo_admin_id` no puede llevar `NOT NULL` a nivel de columna —SQLite no
--  permite añadir una columna con REFERENCES y un DEFAULT no nulo a la vez, y
--  sin backfill previo no hay otro valor que ponerle— así que la obligatoriedad
--  la exige la aplicación: `validarGrupo()` en admin-groups.ts, llamada desde
--  products.ts y categories.ts antes de cualquier INSERT o UPDATE. Mismo
--  compromiso que ya acepta `categoria_id` en esta misma tabla.
--
--  `ON DELETE SET NULL` + que la aplicación bloquee el borrado de un grupo en
--  uso (ver admin-groups.ts `remove()`) hacen que el SET NULL nunca debería
--  dispararse en la práctica — pero si alguna fila colara sin la validación de
--  la app, quedaría sin grupo en vez de con un id que ya no existe.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0025_grupos_admin.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0025_grupos_admin.sql
-- ============================================================================

-- ─────────────────────────────── 1. La tabla ───────────────────────────────

CREATE TABLE IF NOT EXISTS admin_groups (
  id                  TEXT    PRIMARY KEY,
  nombre              TEXT    NOT NULL,
  -- Casilla "Este grupo mezcla categorías muy distintas, mostrar filtro
  -- adicional" en Inventario. Reemplaza la comparación literal contra el
  -- nombre 'agroindustriales' que había en el frontend: el filtro fino ahora
  -- se activa por esta bandera, no por cómo se llame el grupo, así que
  -- renombrarlo o crear uno nuevo con el mismo comportamiento no rompe nada.
  mostrar_filtro_fino INTEGER NOT NULL DEFAULT 0 CHECK (mostrar_filtro_fino IN (0, 1)),
  orden               INTEGER NOT NULL DEFAULT 100,
  activo              INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  creado_en           TEXT    NOT NULL DEFAULT (datetime('now')),
  actualizado_en      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_groups_orden ON admin_groups (activo, orden);

-- Los tres que ya existían, con los mismos ids que products/categories ya
-- usan: la migración no reclasifica nada, solo les da una fila propia.
-- INSERT OR IGNORE para poder correr esto dos veces sin duplicar ni pisar un
-- nombre que ya se hubiera corregido desde el panel.
INSERT OR IGNORE INTO admin_groups (id, nombre, mostrar_filtro_fino, orden) VALUES
  ('frutas', 'Frutas', 0, 10),
  ('verduras', 'Verduras', 0, 20),
  ('agroindustriales', 'Agroindustriales', 1, 30);

-- ────────────────────── 2. `categories.grupo_admin_id` ──────────────────────

ALTER TABLE categories ADD COLUMN grupo_admin_id TEXT REFERENCES admin_groups(id) ON DELETE SET NULL;
UPDATE categories SET grupo_admin_id = grupo_admin WHERE grupo_admin_id IS NULL;

-- ─────────────────────── 3. `products.grupo_admin_id` ───────────────────────

ALTER TABLE products ADD COLUMN grupo_admin_id TEXT REFERENCES admin_groups(id) ON DELETE SET NULL;
UPDATE products SET grupo_admin_id = grupo_admin WHERE grupo_admin_id IS NULL;

-- El índice del filtro por grupo de Inventario, movido a la columna nueva.
-- Mismo nombre: no hay ambigüedad posible con uno que ya no se usa.
DROP INDEX IF EXISTS idx_products_grupo;
CREATE INDEX idx_products_grupo ON products (grupo_admin_id) WHERE activo = 1;
