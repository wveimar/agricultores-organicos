import { Routes } from '@angular/router';

export const routes: Routes = [
  // Panel de administración: bundle aparte, no entra en la carga de la tienda.
  {
    path: 'admin',
    loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
  },
  {
    // Mercado (0040): QualityMarketShop. Ruta y marca propias — `data.workspace`
    // es lo que `PublicShell` lee para fijar el catálogo a este grupo y vestir
    // el tema; `Header`/`Footer` lo reciben de `PublicShell` para mostrar su
    // propia marca y navegación. Ver la nota larga en `PublicShell` sobre por
    // qué esto son dos rutas hermanas y no una sola con una solapa.
    path: 'mercado',
    data: { workspace: 'mercado' },
    loadComponent: () =>
      import('./layout/public-shell/public-shell').then((m) => m.PublicShell),
    children: [
      {
        path: '',
        // Sin `pageTitle`: la portada usa "{nombre} · {tagline}" a secas —
        // ver `App`, que arma el título real con la marca servida por
        // `SiteConfigService` en vez de un string quemado aquí.
        // Única página con hero a sangre: el header puede ir transparente.
        data: { transparentHeader: true },
        loadComponent: () => import('./features/shop/shop-page/shop-page').then((m) => m.ShopPage),
      },
      {
        path: 'checkout',
        data: { pageTitle: 'Finalizar pedido' },
        loadComponent: () =>
          import('./features/checkout/checkout-page/checkout-page').then((m) => m.CheckoutPage),
      },
    ],
  },
  {
    // Turismo (0040): QualityTourShop. Misma estructura que Mercado, más la
    // ficha de detalle de un tour — que solo existe aquí.
    path: 'turismo',
    data: { workspace: 'turismo' },
    loadComponent: () =>
      import('./layout/public-shell/public-shell').then((m) => m.PublicShell),
    children: [
      {
        path: '',
        data: { transparentHeader: true },
        loadComponent: () => import('./features/shop/shop-page/shop-page').then((m) => m.ShopPage),
      },
      {
        path: 'checkout',
        data: { pageTitle: 'Finalizar pedido' },
        loadComponent: () =>
          import('./features/checkout/checkout-page/checkout-page').then((m) => m.CheckoutPage),
      },
      {
        // Ficha de detalle de un producto-servicio (0039): carrusel, descripción
        // completa y el calendario de disponibilidad. Un producto físico con
        // variantes sigue abriendo el modal (`ProductSheetModal`); esto es solo
        // para lo que de verdad tiene tanto que enseñar como para merecer su
        // propia URL — un tour, no un tarro de miel. Solo vive bajo /turismo:
        // Mercado no tiene productos de tipo 'servicio'.
        path: 'producto/:slug',
        data: { pageTitle: 'Detalle' },
        loadComponent: () =>
          import('./features/shop/tour-detail/tour-detail-page').then((m) => m.TourDetailPage),
      },
    ],
  },
  {
    // Portada neutra (0040): antes de elegir Mercado o Turismo, no hay
    // catálogo que mostrar ni tema que vestir, así que no vive bajo
    // `PublicShell` — es su propia página, sin header/footer de ninguna
    // vitrina, para no insinuar que pertenece a una de las dos.
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./features/landing/workspace-landing').then((m) => m.WorkspaceLanding),
  },
  // Cualquier otra ruta vuelve a la portada. En Cloudflare, `not_found_handling`
  // se encarga de que el deep-linking llegue hasta aquí en vez de dar un 404.
  { path: '**', redirectTo: '' },
];
