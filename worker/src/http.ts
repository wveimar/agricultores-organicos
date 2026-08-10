/**
 * Errores de API con forma estable. El cliente siempre recibe
 * `{ error: { code, message, details? } }`, de modo que el frontend puede
 * discriminar por `code` sin parsear textos.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = 'Necesitas iniciar sesión.'): ApiError {
    return new ApiError(401, 'no-autenticado', message);
  }

  static forbidden(message = 'Tu rol no permite esta acción.'): ApiError {
    return new ApiError(403, 'sin-permiso', message);
  }

  static notFound(message = 'Recurso no encontrado.'): ApiError {
    return new ApiError(404, 'no-encontrado', message);
  }

  static conflict(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
  }
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // La API nunca se cachea: son datos de inventario que cambian por segundo.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(extraHeaders as Record<string, string>) },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    );
  }

  // Nunca se filtra el mensaje interno al cliente: puede contener SQL o rutas.
  console.error('Error no controlado:', error);
  return json(
    { error: { code: 'error-interno', message: 'Ocurrió un error inesperado.' } },
    500,
  );
}

/** Lee y valida que el cuerpo sea un objeto JSON. */
export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw ApiError.badRequest('content-type', 'El cuerpo debe ser application/json.');
  }

  try {
    const body = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw ApiError.badRequest('cuerpo-invalido', 'El cuerpo debe ser un objeto JSON.');
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw ApiError.badRequest('json-invalido', 'El cuerpo no es JSON válido.');
  }
}

/** Entero no negativo o error 400. Rechaza NaN, decimales y negativos. */
export function requireInt(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw ApiError.badRequest(
      'campo-invalido',
      `El campo "${field}" debe ser un entero mayor o igual a ${min}.`,
    );
  }
  return value;
}

/** Cadena no vacía o error 400. */
export function requireString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.badRequest('campo-invalido', `El campo "${field}" es obligatorio.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw ApiError.badRequest(
      'campo-invalido',
      `El campo "${field}" supera los ${maxLength} caracteres.`,
    );
  }
  return trimmed;
}
