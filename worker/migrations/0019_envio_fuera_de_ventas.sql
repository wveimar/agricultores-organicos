-- ============================================================================
--  Saca el cobro del domicilio de las cifras de venta.
--
--  Hasta ahora `total_recaudado` era `venta_producto + envios_cobrados`, y de
--  ahí salía el KPI "Ventas brutas". Eso contaba como ingreso una plata que
--  pasa por la finca pero no se queda: el domicilio va para quien reparte.
--  El efecto era inflar las ventas y, con ellas, el ticket promedio.
--
--  A partir de aquí `total_recaudado = venta_producto` en los cierres nuevos
--  (ver closeCash() en routes/reports.ts). Esta migración pone al día los que
--  ya estaban guardados para que la lista de cierres no mezcle dos criterios
--  — comparar una semana con otra tiene que significar lo mismo en las dos.
--
--  `envios_cobrados` NO se borra ni se pone a cero: sigue siendo el registro
--  de cuánto se cobró de domicilio, que es con lo que se cuadra después con
--  el domiciliario. Lo único que cambia es que deja de sumar al total.
--
--  ── Ojo con los comprobantes ya descargados ──
--
--  Un .txt guardado antes de esta migración muestra el total viejo. No hay
--  forma de alcanzarlos, y es esperado: el comprobante dice lo que el panel
--  reportaba ese día. La diferencia entre uno viejo y el panel es exactamente
--  `envios_cobrados` de ese cierre.
--
--  Es un UPDATE puro sobre una tabla que nadie referencia con FK: no hace
--  falta recrear nada ni respaldar tablas hijas.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0019_envio_fuera_de_ventas.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0019_envio_fuera_de_ventas.sql
-- ============================================================================

UPDATE cash_closings
   SET total_recaudado = venta_producto
 WHERE total_recaudado <> venta_producto;
