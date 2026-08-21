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
 * Método de recaudo. El cierre de caja agrupa por este valor de verdad (no es
 * una etiqueta fija): `porMetodo` en `cashSummary()` viene de un `GROUP BY
 * metodo_pago` real desde que existe pago contra entrega.
 */
export type PaymentMethod = 'transferencia' | 'contraentrega';

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  transferencia: 'Transferencia bancaria',
  contraentrega: 'Pago contra entrega',
};
