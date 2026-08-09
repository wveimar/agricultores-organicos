import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Agricultores Orgánicos · Del surco a tu cocina',
    loadComponent: () => import('./features/shop/shop-page/shop-page').then((m) => m.ShopPage),
  },
  // Cualquier otra ruta vuelve a la tienda. En Cloudflare Pages, `_redirects`
  // se encarga de que el deep-linking llegue hasta aquí en vez de dar un 404.
  { path: '**', redirectTo: '' },
];
