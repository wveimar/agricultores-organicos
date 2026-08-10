import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { authInterceptor } from './core/api/auth.interceptor';

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
  ],
};
