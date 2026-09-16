-- Workspace fijo por cuenta (split QualityMarketShop / QualityTourShop).
--
-- 'ambos' es el valor con el que nace toda cuenta existente: nadie pierde
-- acceso a ninguna sección el día que se despliega esta migración. Restringir
-- a un solo workspace es una decisión explícita que toma después un
-- SUPER_ADMIN desde Usuarios.
ALTER TABLE users ADD COLUMN workspace TEXT NOT NULL DEFAULT 'ambos'
  CHECK (workspace IN ('mercado', 'turismo', 'ambos'));
