import { Routes } from '@angular/router';
import { authGuard, guestGuard, roleGuard } from '../../core/guards/admin.guards';

/**
 * Rutas del panel. Se cargan en diferido desde `app.routes.ts`, así que nada
 * de este código entra en el bundle de la tienda pública.
 *
 * Recordatorio: estos guards deciden **qué se pinta**, no qué está permitido.
 * La autorización de verdad va en el servidor. Ver `auth.service.ts`.
 */
export const ADMIN_ROUTES: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Entrar · Panel',
    loadComponent: () => import('./login/admin-login').then((m) => m.AdminLogin),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./admin-layout/admin-layout').then((m) => m.AdminLayout),
    children: [
      {
        path: 'inventario',
        canActivate: [roleGuard('ADMIN_INVENTARIO')],
        title: 'Inventario · Panel',
        loadComponent: () =>
          import('./inventory/inventory-dashboard').then((m) => m.InventoryDashboard),
      },
      {
        path: 'inventario/crear',
        canActivate: [roleGuard('ADMIN_INVENTARIO')],
        title: 'Crear producto · Panel',
        loadComponent: () =>
          import('./inventory/create-product').then((m) => m.CreateProduct),
      },
      {
        path: 'pedidos',
        canActivate: [roleGuard('GESTOR_PEDIDOS')],
        title: 'Pedidos · Panel',
        loadComponent: () => import('./orders/orders-manager').then((m) => m.OrdersManager),
      },
      {
        path: 'reportes',
        // Ventas interesan tanto a compras como a quien gestiona pedidos.
        canActivate: [roleGuard('GESTOR_PEDIDOS', 'ADMIN_INVENTARIO')],
        title: 'Reportes · Panel',
        loadComponent: () => import('./reports/sales-reports').then((m) => m.SalesReports),
      },
      {
        path: 'sin-acceso',
        title: 'Sin acceso · Panel',
        loadComponent: () => import('./forbidden/forbidden').then((m) => m.Forbidden),
      },
      {
        path: '',
        pathMatch: 'full',
        // La portada del panel depende del rol: cada quien aterriza en lo suyo.
        loadComponent: () => import('./admin-home/admin-home').then((m) => m.AdminHome),
      },
    ],
  },
];
