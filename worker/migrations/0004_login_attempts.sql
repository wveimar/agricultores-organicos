-- ============================================================================
--  Tabla de intentos de entrada fallidos, para frenar la fuerza bruta.
--
--  Sin esto, `/api/auth/login` acepta intentos sin límite. La única defensa
--  eran las 100.000 iteraciones de PBKDF2 por intento — cara para el atacante,
--  pero también para el Worker, que es quien la paga: medido, el login rinde
--  8,8 peticiones/s frente a las 144/s del catálogo. Un atacante con un
--  diccionario no necesitaba acertar para hacer daño.
--
--  Con el contador, un intento bloqueado se corta **antes** del PBKDF2, así
--  que deja de costar CPU.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0004_login_attempts.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0004_login_attempts.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS login_attempts (
  clave     TEXT    PRIMARY KEY,
  intentos  INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_en TEXT    NOT NULL DEFAULT (datetime('now'))
);
