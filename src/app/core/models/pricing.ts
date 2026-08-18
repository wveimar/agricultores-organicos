/**
 * Precio con descuento de mayorista.
 *
 * ── Copia deliberada ──
 *
 * La misma fórmula vive en `worker/src/pricing.ts`. No se comparte por import
 * porque son dos proyectos de TypeScript distintos —el bundle del navegador y
 * el del Worker— y enlazarlos arrastraría al cliente código de servidor.
 *
 * Que estén duplicadas obliga a una regla: tienen que devolver **exactamente**
 * el mismo entero. Si divergen, el cliente ve un precio en la tarjeta y se le
 * cobra otro al confirmar, que es la clase de error que se descubre por una
 * reclamación y no por una excepción. `worker/tests/qa-mayoristas.mjs` ejecuta
 * las dos sobre los mismos números para que una desincronización salga en la
 * QA.
 *
 * El redondeo va al peso más cercano: el COP no tiene decimales y todo el
 * dinero del proyecto es INTEGER.
 */
export function discountedPrice(listPrice: number, percent: number): number {
  if (percent <= 0) {
    return listPrice;
  }
  const capped = Math.min(percent, 100);
  return Math.round((listPrice * (100 - capped)) / 100);
}
