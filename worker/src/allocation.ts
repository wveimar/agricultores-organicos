/**
 * Reparto de un cobro entre facturas.
 *
 * Vive aparte de la ruta y sin tocar la base a propósito: es la aritmética que
 * decide cuánta plata queda contra cada deuda, y es donde un error se convierte
 * en dinero mal contado. Aislada es comprobable con una tabla de casos, sin
 * levantar un Worker ni sembrar una base — ver `allocation.spec.ts`.
 */

/** Una deuda viva, tal como se necesita para repartir sobre ella. */
export interface DeudaAbierta {
  readonly id: string;
  /** Lo que falta por cobrar de esta factura. Siempre > 0 para poder recibir. */
  readonly saldo: number;
  /** Para ordenar por antigüedad: la más vieja se cobra primero. */
  readonly emitidaEn: string;
}

export interface Reparto {
  readonly invoiceId: string;
  readonly monto: number;
}

export interface ResultadoReparto {
  readonly repartos: readonly Reparto[];
  /**
   * Lo que sobró sin asignar. Es el anticipo: plata del cliente que todavía no
   * corresponde a ninguna factura, y que se aplicará a la próxima.
   */
  readonly anticipo: number;
}

/**
 * Reparte un monto entre deudas, de la más vieja a la más nueva.
 *
 * Es el comportamiento por defecto de todos los sistemas contables, y no es
 * arbitrario: cobrar primero lo viejo es lo que impide que una deuda envejezca
 * indefinidamente mientras el cliente sigue comprando y pagando lo último.
 *
 * Nunca asigna más que el saldo de cada factura —pagar de más una factura no
 * significa nada— así que si el monto supera todas las deudas, lo que sobra
 * vuelve como `anticipo` en vez de inflar la última.
 */
export function repartirPorAntiguedad(
  monto: number,
  deudas: readonly DeudaAbierta[],
): ResultadoReparto {
  if (monto <= 0) {
    return { repartos: [], anticipo: 0 };
  }

  // Copia antes de ordenar: reordenar el array de quien llama es un efecto
  // secundario que nadie espera de una función que dice "repartir".
  const porAntiguedad = [...deudas]
    .filter((deuda) => deuda.saldo > 0)
    .sort((a, b) => a.emitidaEn.localeCompare(b.emitidaEn) || a.id.localeCompare(b.id));

  const repartos: Reparto[] = [];
  let restante = monto;

  for (const deuda of porAntiguedad) {
    if (restante <= 0) {
      break;
    }
    const asignado = Math.min(restante, deuda.saldo);
    repartos.push({ invoiceId: deuda.id, monto: asignado });
    restante -= asignado;
  }

  return { repartos, anticipo: restante };
}

/**
 * Comprueba que un reparto hecho a mano sea válido contra las deudas reales.
 *
 * Devuelve el primer problema encontrado, o `null` si está bien. Se separa de
 * `repartirPorAntiguedad` porque son dos cosas distintas: una propone y la otra
 * verifica lo que propuso una persona desde el formulario, que puede haber
 * escrito cualquier cosa.
 */
export function validarReparto(
  monto: number,
  repartos: readonly Reparto[],
  deudas: readonly DeudaAbierta[],
): string | null {
  const porId = new Map(deudas.map((deuda) => [deuda.id, deuda]));
  let sumado = 0;

  for (const reparto of repartos) {
    const deuda = porId.get(reparto.invoiceId);
    if (!deuda) {
      return `La factura ${reparto.invoiceId} no está entre las deudas abiertas de este cliente.`;
    }
    if (reparto.monto <= 0) {
      return 'Cada línea del reparto tiene que ser mayor que cero.';
    }
    if (reparto.monto > deuda.saldo) {
      return `No se puede abonar ${reparto.monto} a una factura que solo debe ${deuda.saldo}.`;
    }
    sumado += reparto.monto;
  }

  if (sumado > monto) {
    return `El reparto suma ${sumado}, más que el pago de ${monto}.`;
  }

  return null;
}
