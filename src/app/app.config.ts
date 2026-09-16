import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withRouterConfig } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { authInterceptor } from './core/api/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    /**
     * `paramsInheritanceStrategy: 'always'` (0040): por defecto Angular solo
     * hereda `data` del padre en un hijo de ruta VACÍA (`''`). `/mercado` y
     * `/turismo` ponen `data.workspace` en la ruta padre (donde vive
     * `PublicShell`), pero sus hijas `checkout` y `producto/:slug` no son
     * rutas vacías — sin esto, `App.syncPageTitle()` (que lee el snapshot
     * más profundo) perdería el workspace justo en esas dos páginas y el
     * título de la pestaña volvería a la marca del panel a mitad de compra.
     */
    provideRouter(routes, withRouterConfig({ paramsInheritanceStrategy: 'always' })),
    /**
     * `withFetch()` cambia XHR por la API fetch, que es el transporte nativo
     * del runtime de Cloudflare Workers. Además de ser el camino recomendado
     * hoy en Angular, es lo que permite que estas peticiones funcionen igual
     * si algún día se renderizan en el servidor dentro del Worker.
     */
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
