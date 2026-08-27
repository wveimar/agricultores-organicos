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
    // Las dos mitades de la recuperación comparten componente: sin `token` en
    // la URL pide el enlace, con él deja elegir contraseña. Ambas son públicas
    // por necesidad —quien las usa no puede iniciar sesión—, pero llevan
    // `guestGuard` para que a quien ya tiene sesión abierta no se le ofrezca
    // un camino que no necesita.
    path: 'recuperar',
    canActivate: [guestGuard],
    title: 'Recuperar contraseña · Panel',
    loadComponent: () => import('./recover/recover-password').then((m) => m.RecoverPassword),
  },
  {
    path: 'restablecer',
    canActivate: [guestGuard],
    title: 'Nueva contraseña · Panel',
    loadComponent: () => import('./recover/recover-password').then((m) => m.RecoverPassword),
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
        path: 'categorias',
        canActivate: [roleGuard('ADMIN_INVENTARIO')],
        title: 'Categorías · Panel',
        loadComponent: () =>
          import('./categories/categories-manager').then((m) => m.CategoriesManager),
      },
      {
        path: 'inventario/crear',
        canActivate: [roleGuard('ADMIN_INVENTARIO')],
        title: 'Crear producto · Panel',
        loadComponent: () =>
          import('./inventory/create-product').then((m) => m.CreateProduct),
      },
      {
        path: 'inventario/editar/:id',
        canActivate: [roleGuard('ADMIN_INVENTARIO')],
        title: 'Editar producto · Panel',
        loadComponent: () =>
          import('./inventory/edit-product').then((m) => m.EditProduct),
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
        path: 'consolidado',
        // Lo usan los dos lados: quien coordina la cosecha y quien reparte.
        canActivate: [roleGuard('GESTOR_PEDIDOS', 'ADMIN_INVENTARIO')],
        title: 'Consolidado · Panel',
        loadComponent: () =>
          import('./reports/consolidation-report').then((m) => m.ConsolidationReport),
      },
      {
        path: 'cartera',
        // Quien cobra es quien gestiona pedidos: registrar un pago cambia lo
        // que entra al cierre de caja, no el inventario.
        canActivate: [roleGuard('GESTOR_PEDIDOS')],
        title: 'Cartera · Panel',
        loadComponent: () => import('./portfolio/portfolio').then((m) => m.Portfolio),
      },
      {
        path: 'gastos',
        // Un gasto se resta de la ganancia del cierre: lo maneja quien
        // responde por la caja, no quien maneja catálogo. El servidor aplica
        // la misma regla.
        canActivate: [roleGuard('GESTOR_PEDIDOS')],
        title: 'Gastos · Panel',
        loadComponent: () =>
          import('./expenses/expenses-manager').then((m) => m.ExpensesManager),
      },
      {
        path: 'contactos',
        // La agenda la usan los dos lados: quien compra necesita al proveedor
        // y quien gestiona pedidos necesita al cliente.
        canActivate: [roleGuard('GESTOR_PEDIDOS', 'ADMIN_INVENTARIO')],
        title: 'Contactos · Panel',
        loadComponent: () =>
          import('./contacts/contacts-manager').then((m) => m.ContactsManager),
      },
      {
        path: 'compras',
        // Los dos roles: una compra mueve inventario (ADMIN_INVENTARIO) y
        // genera una deuda con el agricultor (GESTOR_PEDIDOS). El servidor
        // aplica la misma regla; marcar el pago sí es solo de pedidos.
        canActivate: [roleGuard('GESTOR_PEDIDOS', 'ADMIN_INVENTARIO')],
        title: 'Compras a fincas · Panel',
        loadComponent: () =>
          import('./purchases/provider-purchases-manager').then(
            (m) => m.ProviderPurchasesManager,
          ),
      },
      {
        path: 'entregas',
        canActivate: [roleGuard('DOMICILIARIO')],
        title: 'Entregas · Panel',
        loadComponent: () =>
          import('./deliveries/delivery-orders').then((m) => m.DeliveryOrders),
      },
      {
        path: 'mayoristas',
        // Solo SUPER_ADMIN: a quién se le cobra menos y cuánto es una decisión
        // comercial, no de inventario. El servidor aplica la misma regla.
        canActivate: [roleGuard('SUPER_ADMIN')],
        title: 'Tarifas de mayorista · Panel',
        loadComponent: () =>
          import('./wholesale/wholesale-tariffs').then((m) => m.WholesaleTariffs),
      },
      {
        path: 'usuarios',
        // Gestionar cuentas es dar y quitar acceso al panel entero: solo
        // SUPER_ADMIN. El servidor aplica la misma regla, que es la que cuenta.
        canActivate: [roleGuard('SUPER_ADMIN')],
        title: 'Usuarios · Panel',
        loadComponent: () => import('./users/users-manager').then((m) => m.UsersManager),
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
