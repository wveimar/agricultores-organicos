import { Routes } from '@angular/router';

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
        loadComponent: () => import('./features/shop/shop-page/shop-page').then((m) => m.ShopPage),
      },
    ],
  },
  // Cualquier otra ruta vuelve a la tienda. En Cloudflare, `not_found_handling`
  // se encarga de que el deep-linking llegue hasta aquí en vez de dar un 404.
  { path: '**', redirectTo: '' },
];
