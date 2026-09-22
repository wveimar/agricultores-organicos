import { Routes } from '@angular/router';
import { moduleGuard } from './core/guards/admin.guards';

export const routes: Routes = [
  // Panel de administración: bundle aparte, no entra en la carga de la tienda.
  {
    path: 'admin',
    loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
  },
  {
    path: '',
    loadComponent: () =>
      import('./layout/public-shell/public-shell').then((m) => m.PublicShell),
    children: [
      {
        path: '',
        title: 'Agricultores Orgánicos · Del surco a tu cocina',
        // Única página con hero a sangre: el header puede ir transparente.
        data: { transparentHeader: true },
        // `moduleGuard` no es exclusivo del panel: no depende de sesión, solo
        // de qué está encendido en esta instalación — le sirve igual a una
        // ruta pública.
        canActivate: [moduleGuard('ecommerce', '/tienda-no-disponible')],
        loadComponent: () => import('./features/shop/shop-page/shop-page').then((m) => m.ShopPage),
      },
      {
        path: 'checkout',
        title: 'Finalizar pedido · Agricultores Orgánicos',
        canActivate: [moduleGuard('ecommerce', '/tienda-no-disponible')],
        loadComponent: () =>
          import('./features/checkout/checkout-page/checkout-page').then((m) => m.CheckoutPage),
      },
      {
        // Sin guard: es a donde caen `/` y `/checkout` cuando E-commerce está
        // apagado, así que tiene que quedar siempre alcanzable.
        path: 'tienda-no-disponible',
        title: 'Tienda no disponible · Agricultores Orgánicos',
        loadComponent: () =>
          import('./features/shop/tienda-no-disponible/tienda-no-disponible').then(
            (m) => m.TiendaNoDisponible,
          ),
      },
    ],
  },
  // Cualquier otra ruta vuelve a la tienda. En Cloudflare, `not_found_handling`
  // se encarga de que el deep-linking llegue hasta aquí en vez de dar un 404.
  { path: '**', redirectTo: '' },
];
