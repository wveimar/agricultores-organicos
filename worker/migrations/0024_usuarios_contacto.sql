-- ============================================================================
--  Enlaza la cuenta de usuario con su ficha de contacto.
--
--  ── El problema ──
--
--  Desde la 0023 el cupo de crédito vive en `contacts`, no en `users`, porque
--  se le fía a una persona y no a un login. Pero nada ataba una cuenta con su
--  ficha: cuando un mayorista compraba logueado, `encontrarOCrearCliente()`
--  seguía buscando o creando la ficha por el TELÉFONO que escribía en el
--  formulario del checkout — sin mirar para nada su cuenta.
--
--  El efecto en la práctica: si un día escribía el teléfono con espacios, o
--  desde el celular de alguien más, o simplemente distinto al de la vez
--  anterior, el pedido caía en una ficha nueva sin el cupo que ya se le había
--  abierto. El administrador terminaba manteniendo dos registros a mano —uno
--  en Usuarios, otro en Contactos— y adivinando cuál era cuál.
--
--  ── La solución ──
--
--  `users.contact_id`: un enlace explícito, puesto por un SUPER_ADMIN desde el
--  panel de Usuarios (selector manual, no automático). Desde que existe, el
--  checkout de un mayorista logueado usa ESA ficha sin importar qué teléfono
--  teclee — ver `contactoDeUsuario()` en routes/contacts.ts y su uso en
--  create() de routes/orders.ts.
--
--  UNIQUE parcial: dos cuentas no pueden compartir la misma ficha. Si dos
--  logins debieran compartir una sola deuda, el problema es de negocio —una
--  sola cuenta con varios usuarios— y no algo que este enlace deba resolver.
--
--  ── El sembrado ──
--
--  Se enlaza automáticamente solo el caso INEQUÍVOCO: una cuenta cuyos pedidos
--  *todos* apuntan a una misma ficha, y esa ficha que *solo* recibió pedidos de
--  esa cuenta. Es una coincidencia 1-a-1 confirmada por el historial, no una
--  suposición por nombre — el nombre de la cuenta y el que alguien teclea en
--  el checkout no tienen por qué coincidir.
--
--  Lo que no cae en ese caso —cuenta sin pedidos todavía, o pedidos repartidos
--  en más de una ficha por los teléfonos que se hayan usado— se deja sin
--  enlazar. Ahí es donde entra el selector manual del panel.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0024_usuarios_contacto.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0024_usuarios_contacto.sql
-- ============================================================================

ALTER TABLE users ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;

-- Una ficha, como mucho, una cuenta. Parcial: sin enlazar es el estado normal
-- de casi todo el mundo, y esas filas no deben competir por el índice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_contact
  ON users (contact_id) WHERE contact_id IS NOT NULL;

-- ─────────────────────── Enlace automático, solo lo inequívoco ───────────────────────

WITH vinculo_de_cuenta AS (
  -- Cuentas cuyos pedidos, con ficha, TODOS apuntan a la misma ficha.
  SELECT o.user_id AS user_id, o.contact_id AS contact_id
    FROM orders o
   WHERE o.user_id IS NOT NULL AND o.contact_id IS NOT NULL
   GROUP BY o.user_id
  HAVING COUNT(DISTINCT o.contact_id) = 1
),
ficha_de_una_sola_cuenta AS (
  -- De esas, las fichas que a su vez solo recibieron pedidos de esa cuenta.
  SELECT contact_id
    FROM vinculo_de_cuenta
   GROUP BY contact_id
  HAVING COUNT(DISTINCT user_id) = 1
)
UPDATE users
   SET contact_id = (
     SELECT vc.contact_id FROM vinculo_de_cuenta vc WHERE vc.user_id = users.id
   )
 WHERE contact_id IS NULL
   AND id IN (
     SELECT vc.user_id
       FROM vinculo_de_cuenta vc
       JOIN ficha_de_una_sola_cuenta f ON f.contact_id = vc.contact_id
   );
