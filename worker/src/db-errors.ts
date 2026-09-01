import { ApiError } from './http';

/**
 * Traduce el error crudo de D1 a algo que se le pueda enseñar a una persona.
 *
 * Vive aquí y no en `routes/orders.ts` —donde nació— porque el punto de venta
 * arma exactamente los mismos batches: descuenta stock contra el mismo CHECK y
 * puede chocar con los mismos UNIQUE. Duplicar la traducción llevaría, tarde o
 * temprano, a que la tienda y la caja explicaran el mismo fallo con palabras
 * distintas.
 *
 * El CHECK de `stock_actual >= 0` es el que de verdad importa: es la última
 * línea de defensa contra la sobreventa cuando dos peticiones concurrentes
 * pasan la validación de la aplicación a la vez. Que llegue hasta aquí no es un
 * error del programa, es el sistema funcionando — y por eso se responde 400 con
 * una explicación concreta, no un 500.
 */
export function translateConstraint(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('CHECK constraint failed') && message.includes('stock_actual')) {
    return ApiError.badRequest(
      'stock-insuficiente',
      'Otra venta se llevó esas unidades mientras procesábamos el pedido. No se aplicó ningún cambio.',
    );
  }

  if (message.includes('UNIQUE constraint failed')) {
    return ApiError.conflict('duplicado', 'Ese registro ya existe.');
  }

  return new ApiError(500, 'error-base-datos', 'No se pudo completar la operación.');
}
