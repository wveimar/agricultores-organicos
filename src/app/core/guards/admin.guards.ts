import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { TokenStore } from '../api/token-store';
import { UserRole } from '../models/user.model';

/**
 * Los guards deciden **qué se muestra**, no qué está permitido. Un usuario
 * puede saltárselos con devtools; la autorización real vive en el Worker
 * (`requireRole` en `worker/src/auth/middleware.ts`), que es el único lugar
 * donde negarla de verdad importa.
 */

/** Exige sesión activa. Guarda el destino para volver tras el login. */
export const authGuard: CanActivateFn = (_route, state) => {
  const tokens = inject(TokenStore);
  const router = inject(Router);

  if (tokens.isAuthenticated()) {
    return true;
  }

  return router.createUrlTree(['/admin/login'], {
    queryParams: { returnUrl: state.url },
  });
};

/**
 * Exige uno de los roles indicados. `SUPER_ADMIN` siempre pasa (lo resuelve
 * `TokenStore.can`). Se usa como fábrica en la ruta:
 *
 * ```ts
 * { path: 'inventario', canActivate: [authGuard, roleGuard('ADMIN_INVENTARIO')], ... }
 * ```
 */
export function roleGuard(...allowed: readonly UserRole[]): CanActivateFn {
  return () => {
    const tokens = inject(TokenStore);
    const router = inject(Router);

    if (!tokens.isAuthenticated()) {
      return router.createUrlTree(['/admin/login']);
    }

    if (tokens.can(...allowed)) {
      return true;
    }

    // Autenticado pero sin permiso: no es un problema de login, así que se
    // manda a una pantalla que lo explique en vez de repetir el formulario.
    return router.createUrlTree(['/admin/sin-acceso']);
  };
}

/** Impide volver al login con sesión abierta. */
export const guestGuard: CanActivateFn = () => {
  const tokens = inject(TokenStore);
  const router = inject(Router);
  return tokens.isAuthenticated() ? router.createUrlTree(['/admin']) : true;
};
