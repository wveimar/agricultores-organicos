import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { UserRole } from '../models/user.model';

/**
 * Los guards deciden **qué se muestra**, no qué está permitido. Un usuario
 * puede saltárselos con devtools; la autorización real tiene que repetirse en
 * el servidor por cada endpoint. Ver la nota extensa en `auth.service.ts`.
 */

/** Exige sesión activa. Guarda el destino para volver tras el login. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }

  return router.createUrlTree(['/admin/login'], {
    queryParams: { returnUrl: state.url },
  });
};

/**
 * Exige uno de los roles indicados. `SUPER_ADMIN` siempre pasa (lo resuelve
 * `hasRole`). Se usa como fábrica en la ruta:
 *
 * ```ts
 * { path: 'inventario', canActivate: [authGuard, roleGuard('ADMIN_INVENTARIO')], ... }
 * ```
 */
export function roleGuard(...allowed: readonly UserRole[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (!auth.isAuthenticated()) {
      return router.createUrlTree(['/admin/login']);
    }

    if (auth.can(...allowed)) {
      return true;
    }

    // Autenticado pero sin permiso: no es un problema de login, así que se
    // manda a una pantalla que lo explique en vez de repetir el formulario.
    return router.createUrlTree(['/admin/sin-acceso']);
  };
}

/** Impide volver al login con sesión abierta. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? router.createUrlTree(['/admin']) : true;
};
