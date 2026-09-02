-- ───────────────────────── Venta por peso (mostrador) ─────────────────────────
--
-- Marca qué productos se venden a granel, pesados en el mostrador, en vez de
-- por unidades enteras de una presentación fija. Es ADITIVO: una sola
-- columna nueva, sin recrear ninguna tabla.
--
-- Lo que NO hace falta tocar, y por qué: `stock_actual`, `cantidad_unidad` y
-- `order_items.cantidad` siguen declaradas INTEGER, pero SQLite no tiene
-- tipado fuerte de columna — su afinidad INTEGER solo intenta convertir sin
-- pérdida; un valor como 0.5 que no cabe en un entero se guarda tal cual como
-- REAL, y los CHECK (`>= 0`, `> 0`) comparan decimales sin problema. No hay
-- ningún dato que hoy sea imposible de representar; lo único que faltaba era
-- saber CUÁLES productos pueden llegar en fracción.
--
-- Tampoco se agrega un CHECK que cruce columnas (p. ej. "si no es por peso,
-- la cantidad tiene que ser entera"): SQLite prohíbe que un CHECK añadido con
-- ALTER TABLE ADD COLUMN referencie otras columnas, así que forzarlo exigiría
-- recrear `products` — el mismo costo que esta migración evita a propósito.
-- Esa regla vive en el Worker (`rejectFractional()` en orders.ts), con el
-- mismo criterio que ya usa `motivo_ajuste`: es una validación de la ruta, no
-- una restricción de la base.
ALTER TABLE products
  ADD COLUMN vendido_por_peso INTEGER NOT NULL DEFAULT 0
    CHECK (vendido_por_peso IN (0, 1));
