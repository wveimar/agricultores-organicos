import { ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { routes } from './app.routes';
import { authInterceptor } from './core/api/auth.interceptor';
import { ApiClient } from './core/api/api-client';
import { ModulosStore } from './core/api/modulos-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    /**
     * `withFetch()` cambia XHR por la API fetch, que es el transporte nativo
     * del runtime de Cloudflare Workers. Además de ser el camino recomendado
     * hoy en Angular, es lo que permite que estas peticiones funcionen igual
     * si algún día se renderizan en el servidor dentro del Worker.
     */
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    /**
     * Los módulos activos se leen ANTES de que arranque el enrutador — así el
     * primer guard que corre (el de la ruta con la que alguien abrió el
     * enlace) ya ve el estado real, en vez de asumir todo encendido durante
     * un instante y redirigir después.
     *
     * Si la petición falla (sin red, Worker caído), no se deja el arranque
     * colgado ni se rompe la app entera: `ModulosStore` ya nace con todo
     * encendido por defecto, así que un error aquí simplemente deja ese
     * valor de partida — el mismo comportamiento que tenía el sistema antes
     * de que este interruptor existiera.
     */
    provideAppInitializer(() => {
      const api = inject(ApiClient);
      const modulos = inject(ModulosStore);
      return firstValueFrom(api.config())
        .then((cfg) => modulos.set(cfg.modulos))
        .catch(() => undefined);
    }),
  ],
};
