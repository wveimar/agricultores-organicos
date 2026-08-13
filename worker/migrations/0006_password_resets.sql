-- ============================================================================
--  Enlaces de recuperación de contraseña.
--
--  Se guarda el **hash** del token, nunca el token. Es la misma razón por la
--  que no se guardan contraseñas en claro: quien consiga leer esta tabla —una
--  copia de seguridad, una consulta filtrada— tendría si no una llave válida
--  para entrar como cualquiera. Con el hash, lo que hay guardado no sirve para
--  nada: el token real solo existe en el correo del destinatario.
--
--  `usado_en` hace el enlace de un solo uso. Un enlace de recuperación viaja
--  por correo, y el correo se reenvía, se queda en la papelera y se sincroniza
--  en varios dispositivos; que siga funcionando después de usarlo lo convierte
--  en una puerta abierta indefinidamente.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0006_password_resets.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0006_password_resets.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now')),
  expira_en  TEXT NOT NULL,
  usado_en   TEXT
);

-- Al usar un enlace se invalidan los demás de esa misma cuenta: sin índice,
-- ese borrado tendría que recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets (user_id);
