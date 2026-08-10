/**
 * Clasificación ABC de control de inventario: se ordenan los productos por
 * ingresos y se acumula el porcentaje.
 *
 * - **A**: hasta el 80 % acumulado. Poca referencias, casi toda la plata.
 * - **B**: del 80 % al 95 %.
 * - **C**: el resto — mucha referencia y poco ingreso.
 *
 * Sirve para decidir qué nunca puede faltar en bodega. Se calcula en SQL, en
 * `worker/src/routes/reports.ts` — este tipo solo etiqueta el resultado que
 * ya llega calculado del servidor.
 */
export type AbcClass = 'A' | 'B' | 'C';

/**
 * Método de recaudo. Hoy solo existe consignación bancaria porque el checkout
 * es manual, pero se modela como lista para que añadir efectivo o datáfono no
 * obligue a cambiar la forma del cierre.
 */
export type PaymentMethod = 'consignacion';

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  consignacion: 'Consignación bancaria',
};
