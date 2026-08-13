/**
 * Ventana semanal de pedidos.
 *
 * El ciclo no es "compra y te llega": es un acopio. Se recogen pedidos toda la
 * semana, el jueves al mediodía se cierra la lista, se le pasa al agricultor
 * lo que hay que cosechar, y el domingo por la tarde salen los despachos. Un
 * pedido que entra el jueves a las 12:01 no llega a ese domingo — entra en el
 * siguiente.
 *
 * Las fechas se calculan en hora de Colombia (UTC-5, sin horario de verano)
 * y no en la del navegador: un cliente con el reloj en otro huso vería un
 * corte distinto al real, y el corte es una promesa de negocio, no una
 * preferencia local.
 */

/** Jueves. `Date#getDay()`: domingo = 0. */
const CUTOFF_DAY = 4;
/** Mediodía. */
const CUTOFF_HOUR = 12;
/** Domingo. */
const DISPATCH_DAY = 0;

/** Colombia no aplica horario de verano, así que el desfase es constante. */
const COLOMBIA_UTC_OFFSET_HOURS = -5;

export const ORDERING_WINDOW = {
  cutoffLabel: 'jueves a las 12:00 m.',
  dispatchLabel: 'domingo después del mediodía',
  /** Una línea, para cabeceras y avisos cortos. */
  summary: 'Pedidos hasta el jueves 12:00 m. · Despachos el domingo en la tarde',
} as const;

/** El mismo instante, leído con el reloj de Colombia. */
function toColombia(date: Date): Date {
  const utc = date.getTime() + date.getTimezoneOffset() * 60_000;
  return new Date(utc + COLOMBIA_UTC_OFFSET_HOURS * 3_600_000);
}

function atHour(date: Date, day: number, hour: number): Date {
  const result = new Date(date);
  const distance = (day - result.getDay() + 7) % 7;
  result.setDate(result.getDate() + distance);
  result.setHours(hour, 0, 0, 0);
  return result;
}

/**
 * Próximo cierre de pedidos. Si ya pasó el de esta semana, devuelve el de la
 * siguiente: nunca una fecha en el pasado.
 */
export function nextCutoff(now: Date = new Date()): Date {
  const local = toColombia(now);
  const cutoff = atHour(local, CUTOFF_DAY, CUTOFF_HOUR);
  if (cutoff.getTime() <= local.getTime()) {
    cutoff.setDate(cutoff.getDate() + 7);
  }
  return cutoff;
}

/** Domingo en que sale el despacho del pedido que se haga ahora. */
export function nextDispatch(now: Date = new Date()): Date {
  const cutoff = nextCutoff(now);
  const dispatch = atHour(cutoff, DISPATCH_DAY, 13);
  // `atHour` con domingo desde un jueves salta al domingo siguiente, que es
  // justo el que toca: tres días después del cierre.
  return dispatch;
}

/** Horas que quedan para el cierre. Sirve para apretar el aviso al final. */
export function hoursToCutoff(now: Date = new Date()): number {
  const local = toColombia(now);
  return Math.max(0, (nextCutoff(now).getTime() - local.getTime()) / 3_600_000);
}

/** `true` cuando el cierre está tan cerca que conviene avisar con urgencia. */
export function isCutoffNear(now: Date = new Date()): boolean {
  return hoursToCutoff(now) <= 24;
}

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** "viernes 15 de agosto" — sin año, que en una promesa semanal sobra. */
export function formatDay(date: Date): string {
  return `${DAYS[date.getDay()]} ${date.getDate()} de ${MONTHS[date.getMonth()]}`;
}
