import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, firstValueFrom, race, timer } from 'rxjs';
import { TokenStore } from '../api/token-store';
import { AdminApiService } from '../services/admin-api.service';
import { UserRole, Workspace } from '../models/user.model';

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
 * Exige que un módulo activable esté encendido (ver los `modulo*` de
 * `AdminApiService`, cargados desde `AdminLayout`). Sin esto, alguien con el
 * rol correcto podía entrar a "Mermas" tecleando la URL a mano aunque el
 * menú ya la hubiera escondido por tratarse de un negocio de servicios — el
 * guard del rol no basta porque no sabe nada de la vertical del negocio.
 *
 * ```ts
 * { path: 'mermas', canActivate: [roleGuard('ADMIN_INVENTARIO'), moduleGuard(a => a.moduloMermas)], ... }
 * ```
 */
export function moduleGuard(selector: (api: AdminApiService) => () => boolean): CanActivateFn {
  return async () => {
    const adminApi = inject(AdminApiService);
    const router = inject(Router);

    // No basta con confiar en que `AdminLayout` ya los pidió: los guards de
    // una ruta hija se resuelven ANTES de que el layout llegue a
    // construirse —si no, no podría decidir si construirlo—, así que
    // esperar sin más a `ajustesLoaded` se quedaría colgado para siempre en
    // una navegación directa por URL. `loadAjustes()` es idempotente: si
    // `AdminLayout` ya la disparó, esto no hace una segunda petición.
    adminApi.loadAjustes();

    // Con la petición ya en camino, ahora sí toca esperarla: decidir con lo
    // que haya en `ajustes()` en este instante —vacío mientras no responda—
    // dejaría los `modulo*` en su valor por defecto ("activado") y un
    // enlace directo a un módulo recién apagado colaría igual. El `timer`
    // es solo una red de seguridad si esa petición nunca resuelve.
    await firstValueFrom(
      race(toObservable(adminApi.ajustesLoaded).pipe(filter(Boolean)), timer(3000)),
    );

    return selector(adminApi)() ? true : router.createUrlTree(['/admin/sin-acceso']);
  };
}

/**
 * Exige que la cuenta pueda ver el workspace indicado ('ambos' siempre pasa).
 *
 * Igual que `moduleGuard`, existe para que alguien con el rol correcto no
 * pueda entrar a "Caja" tecleando la URL a mano aunque el menú ya la haya
 * escondido por tener la cuenta fija en Turismo — a diferencia de un módulo
 * activable (una bandera del negocio entero, en `app_settings`), el
 * workspace es un dato de LA CUENTA (`TokenStore.user()`), así que no hace
 * falta esperar ninguna petición: ya está en el token desde el login.
 *
 * ```ts
 * { path: 'caja', canActivate: [roleGuard('GESTOR_PEDIDOS'), moduleGuard(a => a.moduloPos), workspaceGuard('mercado')], ... }
 * ```
 */
export function workspaceGuard(target: Workspace): CanActivateFn {
  return () => {
    const tokens = inject(TokenStore);
    const router = inject(Router);

    if (!tokens.isAuthenticated()) {
      return router.createUrlTree(['/admin/login']);
    }

    return tokens.canWorkspace(target) ? true : router.createUrlTree(['/admin/sin-acceso']);
  };
}

/** Impide volver al login con sesión abierta. */
export const guestGuard: CanActivateFn = () => {
  const tokens = inject(TokenStore);
  const router = inject(Router);
  return tokens.isAuthenticated() ? router.createUrlTree(['/admin']) : true;
};
