-- 0038 · El efectivo que todavía va en la moto no está en la caja
--
-- ── El problema ──
--
-- `payments.liquidado = 0` significa, y el esquema lo dice con todas sus
-- letras, «efectivo que un domiciliario aún no ha entregado en la tienda:
-- un cierre que cuente ese dinero cuenta plata que nadie ha visto».
--
-- El cierre de jornada (reports.ts) sí respetaba esa regla — separa
-- `enPoderDelDomiciliario` de lo que ya está en el cajón. Tesorería, en
-- cambio, no: `MOVIMIENTOS_SQL` solo filtraba por `cuenta_id IS NOT NULL`, así
-- que sumaba al saldo de «Caja (efectivo)» los billetes que en ese momento
-- iban en una moto por la ciudad.
--
-- Dos consecuencias, las dos malas:
--   · El saldo de la caja mostraba más plata de la que había en el cajón.
--   · El ARQUEO del turno pedía cuadrar contra esa cifra inflada, así que el
--     cajero contaba bien y el sistema le marcaba un faltante que no existía.
--
-- ── Por qué hace falta una columna nueva ──
--
-- Con solo filtrar `liquidado = 0` el saldo ya queda bien, pero la fecha del
-- movimiento seguiría siendo `recibido_en` — la hora en que el cliente pagó
-- en su casa. Si el domiciliario cobra a las 10 a. m. y entrega el efectivo a
-- las 5 p. m., ese billete entró al cajón en el turno de la tarde, no en el
-- de la mañana: sin `liquidado_en`, el arqueo de la tarde no lo vería y el de
-- la mañana lo reclamaría.
--
-- ALTER simple, sin recrear la tabla: `payment_allocations` le apunta a
-- `payments` con FK, y recrearla arrastraría la asignación de cobros a
-- facturas — la cartera entera. Misma lección que ya dejó escrita la 0031.

ALTER TABLE payments ADD COLUMN liquidado_en TEXT;

-- Lo ya liquidado antes de esta migración: se asume entregado el mismo día
-- que se cobró, que es lo que pasa en la práctica y lo único que se puede
-- afirmar mirando hacia atrás.
UPDATE payments SET liquidado_en = recibido_en WHERE liquidado = 1;
