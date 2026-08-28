-- ============================================================================
--  El crédito pasa de la cuenta a la ficha del contacto.
--
--  ── El problema ──
--
--  Fiar exigía `orders.user_id`, así que solo se le podía fiar a alguien con
--  cuenta y contraseña. Pero la tienda se compra sin cuenta —cuatro de cada
--  cinco pedidos son de invitado— y el restaurante del pueblo al que se le fía
--  todas las semanas no tiene ni va a tener login. El mensaje «Este pedido se
--  hizo sin cuenta» era un muro delante del caso normal.
--
--  ── Por qué la ficha y no la cuenta ──
--
--  Porque la deuda la tiene una persona, no un usuario del panel. `users` es
--  quién puede entrar al sistema; `contacts` es a quién se le vende y a quién
--  se le cobra. Desde la migración 0022 TODO pedido tiene `contact_id`,
--  invitados incluidos, así que la ficha es lo único que siempre está.
--
--  Un mayorista con login sigue funcionando igual: su pedido también trae
--  `contact_id` (el checkout lo ficha por teléfono como a cualquiera), así que
--  el cupo se le lee de la misma columna que a todos.
--
--  ── Qué pasa con `users.cupo_credito` ──
--
--  Se queda en la tabla, sin uso. Quitarla obligaría a recrear `users` entera,
--  y media docena de tablas la referencian por FK (`orders.aprobado_por`,
--  `expenses.creado_por`, `cash_closings.cerrado_por`…): el riesgo de ese
--  baile no compensa borrar dos columnas. Deja de leerse en el código y el
--  panel deja de ofrecerla — ver routes/orders.ts y la pantalla de Usuarios.
--
--  Lo que sí se hace es no perder lo que ya estaba: el cupo de cada cuenta que
--  lo tuviera se copia a su ficha, y si no tiene ficha se le crea una.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0023_credito_por_contacto.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0023_credito_por_contacto.sql
-- ============================================================================

-- Cuánto se le puede fiar. 0 = no se le fía, que es lo que le toca a todo el
-- mundo salvo a quien se le abra cupo expresamente.
ALTER TABLE contacts ADD COLUMN cupo_credito INTEGER NOT NULL DEFAULT 0;
-- A cuántos días vence lo que se le fía. De aquí sale `orders.vence_en`.
ALTER TABLE contacts ADD COLUMN dias_credito INTEGER NOT NULL DEFAULT 0;

-- ─────────────── Rescatar el cupo de las cuentas que ya lo tenían ───────────────
--
-- No hay columna que enlace `users` con `contacts`, así que hay que deducirlo.
-- Se hace en dos pasadas, de la más fiable a la más aproximada:
--
--   1. POR SUS PEDIDOS. Si el mayorista ya compró con su cuenta, sus pedidos
--      tienen `user_id` (quién entró) y `contact_id` (a quién se le vendió).
--      Esa pareja es un hecho registrado, no una coincidencia de texto, y
--      además es exactamente la ficha que `grantCredit()` va a mirar. Es la
--      que importa acertar.
--
--   2. POR NOMBRE, solo para cuentas que nunca han comprado y por tanto no
--      tienen pedido que las delate.
--
-- Emparejar solo por nombre habría sido un error silencioso: el nombre de la
-- cuenta y el que el mayorista teclea en el checkout no tienen por qué
-- coincidir, y el cupo habría acabado en una ficha que ningún pedido usa.

-- 1. Por los pedidos que ya hizo con su cuenta.
UPDATE contacts
   SET cupo_credito = COALESCE((
         SELECT MAX(u.cupo_credito)
           FROM users u JOIN orders o ON o.user_id = u.id
          WHERE o.contact_id = contacts.id AND u.cupo_credito > 0
       ), cupo_credito),
       dias_credito = COALESCE((
         SELECT MAX(u.dias_credito)
           FROM users u JOIN orders o ON o.user_id = u.id
          WHERE o.contact_id = contacts.id AND u.cupo_credito > 0
       ), dias_credito)
 WHERE EXISTS (
         SELECT 1 FROM users u JOIN orders o ON o.user_id = u.id
          WHERE o.contact_id = contacts.id AND u.cupo_credito > 0
       );

-- 2. Por nombre, para las cuentas con cupo que aún no han comprado nada.
UPDATE contacts
   SET cupo_credito = COALESCE((
         SELECT MAX(u.cupo_credito) FROM users u
          WHERE u.nombre = contacts.nombre AND u.cupo_credito > 0
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
       ), cupo_credito),
       dias_credito = COALESCE((
         SELECT MAX(u.dias_credito) FROM users u
          WHERE u.nombre = contacts.nombre AND u.cupo_credito > 0
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
       ), dias_credito)
 WHERE cupo_credito = 0
   AND EXISTS (
         SELECT 1 FROM users u
          WHERE u.nombre = contacts.nombre AND u.cupo_credito > 0
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
       );

-- 3. Las cuentas con cupo que no acabaron en ninguna ficha se la ganan aquí:
--    sin esto, su crédito desaparecería al dejar de leerse `users`.
INSERT INTO contacts (id, nombre, es_cliente, cupo_credito, dias_credito, notas)
SELECT lower(hex(randomblob(16))),
       u.nombre,
       1,
       u.cupo_credito,
       u.dias_credito,
       'Ficha creada al mover el crédito desde su cuenta de usuario. Completa teléfono y dirección.'
  FROM users u
 WHERE u.cupo_credito > 0
   AND NOT EXISTS (
         SELECT 1 FROM contacts c
          WHERE c.cupo_credito = u.cupo_credito
            AND (c.nombre = u.nombre
                 OR EXISTS (SELECT 1 FROM orders o
                             WHERE o.user_id = u.id AND o.contact_id = c.id))
       );

-- "¿A quién le tengo cupo abierto?", que es la pregunta de la cartera.
CREATE INDEX IF NOT EXISTS idx_contacts_credito
  ON contacts (cupo_credito) WHERE cupo_credito > 0;
