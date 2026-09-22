import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { TokenStore } from '../api/token-store';
import { ModulosStore } from '../api/modulos-store';
import { ModuloKey } from '../api/api-client';
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

/**
 * Exige que los módulos indicados estén encendidos en esta instalación. Se
 * combina con `roleGuard` en el mismo array `canActivate` — Angular evalúa
 * todos los guards de un array con AND, así que no hace falta fusionarlos en
 * una sola función; cada uno pregunta lo suyo.
 *
 * `redirectTo` es configurable porque este guard sirve a la vez al panel y a
 * la tienda pública (no depende de sesión): a un cajero se le manda a
 * `/admin/modulo-apagado`, a un visitante de la tienda a una pantalla propia
 * que no menciona el panel de administración.
 *
 * ```ts
 * { path: 'caja', canActivate: [roleGuard('GESTOR_PEDIDOS'), moduleGuard('pos')], ... }
 * { path: '', canActivate: [moduleGuard('ecommerce', '/tienda-no-disponible')], ... }
 * ```
 */
export function moduleGuard(
  requeridos: ModuloKey | readonly ModuloKey[],
  redirectTo = '/admin/modulo-apagado',
): CanActivateFn {
  const claves = Array.isArray(requeridos) ? requeridos : [requeridos];

  return () => {
    const modulos = inject(ModulosStore);
    const router = inject(Router);

    if (modulos.isActive(...claves)) {
      return true;
    }

    // Distinto de «sin permiso»: aquí el rol sí alcanza, es la instalación la
    // que tiene esta pieza apagada. Confundir los dos mensajes le haría creer
    // a alguien que necesita pedir acceso cuando lo que hace falta es prender
    // un interruptor.
    return router.createUrlTree([redirectTo]);
  };
}

/** Impide volver al login con sesión abierta. */
export const guestGuard: CanActivateFn = () => {
  const tokens = inject(TokenStore);
  const router = inject(Router);
  return tokens.isAuthenticated() ? router.createUrlTree(['/admin']) : true;
};
