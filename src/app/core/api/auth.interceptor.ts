import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TokenStore } from './token-store';

/**
 * Adjunta el JWT a las llamadas a la propia API.
 *
 * Comprueba que la URL sea relativa a `/api/`: enviar el token a un tercero
 * (una imagen de Unsplash, por ejemplo) sería filtrar la sesión del usuario a
 * un dominio que no tiene nada que ver.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const isOwnApi = request.url.startsWith('/api/');
  const token = inject(TokenStore).token();

  if (!isOwnApi || !token) {
    return next(request);
  }

  return next(
    request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }),
  );
};
