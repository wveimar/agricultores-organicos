-- 0039 · Tema por grupo, descripción larga y galería de fotos
--
-- ── El problema que resuelve ──
--
-- Tres pedidos que llegan juntos:
--
-- 1. Un grupo (0025) puede querer verse distinto al resto de la tienda —el
--    caso concreto es Turismo, que no debe sentirse como la vitrina de
--    verdura verde de al lado—. Antes no había dónde guardar esa decisión;
--    ahora es una columna en `admin_groups`, con el mismo criterio de
--    siempre: un dato que el panel edita, no una condición `if grupo ===
--    'turismo'` escrita en el frontend. Vacío = el tema de por defecto.
--
-- 2. La ficha de un producto solo tenía `tagline` (una frase) para describirse.
--    Para un tour hace falta un párrafo completo — itinerario, qué incluye,
--    qué llevar—, así que se añade una columna de texto largo.
--
-- 3. Un producto solo tenía dos imágenes (`imagen`, `imagen_hover`), pensadas
--    para la tarjeta de la vitrina. Un carrusel de detalle necesita varias, y
--    esa es una lista —una fila por foto—, no dos columnas más en `products`.
--    Mismo patrón que `product_sessions` (0038): quien tiene muchas de algo
--    vive en su propia tabla.

ALTER TABLE admin_groups ADD COLUMN tema TEXT NOT NULL DEFAULT '';

ALTER TABLE products ADD COLUMN descripcion TEXT NOT NULL DEFAULT '';

CREATE TABLE product_photos (
  id         TEXT    PRIMARY KEY,
  product_id TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  alt        TEXT    NOT NULL DEFAULT '',
  -- Posición en el carrusel. Menor va antes.
  orden      INTEGER NOT NULL DEFAULT 100,
  creado_en  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_product_photos_product ON product_photos (product_id, orden);
