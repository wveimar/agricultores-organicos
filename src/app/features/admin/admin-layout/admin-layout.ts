import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiClient } from '../../../core/api/api-client';
import { TokenStore } from '../../../core/api/token-store';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { UserRole } from '../../../core/models/user.model';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly roles: readonly UserRole[];
  readonly badge?: () => number;
}

@Component({
  selector: 'app-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './admin-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLayout {
  protected readonly tokens = inject(TokenStore);
  protected readonly adminApi = inject(AdminApiService);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  protected readonly isSidebarOpen = signal(false);

  private readonly allItems: readonly NavItem[] = [
    {
      path: '/admin/inventario',
      label: 'Inventario',
      roles: ['ADMIN_INVENTARIO'],
      badge: this.adminApi.alertCount,
    },
    // Va pegada al inventario: es la lista con la que se archiva cada producto,
    // y quien la toca es la misma persona.
    { path: '/admin/categorias', label: 'Categorías', roles: ['ADMIN_INVENTARIO'] },
    {
      path: '/admin/pedidos',
      label: 'Pedidos',
      roles: ['GESTOR_PEDIDOS'],
      badge: this.adminApi.pendingCount,
    },
    {
      path: '/admin/consolidado',
      label: 'Consolidado',
      roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'],
    },
    { path: '/admin/reportes', label: 'Reportes', roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'] },
    // Junto a Reportes: las dos hablan de dinero, y de la cartera se sale a
    // mirar la caja para ver qué falta por entrar.
    { path: '/admin/cartera', label: 'Cartera', roles: ['GESTOR_PEDIDOS'] },
    // El bloque de plata que SALE, después del de la que entra: gastos se
    // registra durante la jornada y pagos a fincas se resuelve tras cerrarla.
    { path: '/admin/gastos', label: 'Gastos', roles: ['GESTOR_PEDIDOS'] },
    {
      path: '/admin/compras',
      label: 'Compras',
      roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'],
    },
    // Pegada a Compras: el proveedor al que se le compra sale de aquí.
    {
      path: '/admin/contactos',
      label: 'Contactos',
      roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'],
    },
    {
      path: '/admin/entregas',
      label: 'Entregas',
      roles: ['DOMICILIARIO'],
      badge: this.adminApi.deliveryCount,
    },
    { path: '/admin/mayoristas', label: 'Mayoristas', roles: ['SUPER_ADMIN'] },
    { path: '/admin/usuarios', label: 'Usuarios', roles: ['SUPER_ADMIN'] },
  ];

  /** El menú solo muestra lo que el rol puede abrir de verdad. */
  protected readonly navItems = computed(() =>
    this.allItems.filter((item) => this.tokens.can(...item.roles)),
  );

  constructor() {
    // Los badges del menú necesitan inventario y pedidos aunque el usuario
    // aterrice directo en Reportes, pero solo se piden los que su rol puede
    // ver: un GESTOR_PEDIDOS sin acceso a inventario no debe ni intentar
    // /api/admin/products — el servidor lo rechazaría con 403 igualmente,
    // pero pedir de entrada solo lo que se tiene permiso de ver es más limpio
    // que dejar que cada petición fallida ensucie la consola.
    if (this.tokens.can('ADMIN_INVENTARIO')) {
      this.adminApi.loadProducts();
    }
    if (this.tokens.can('GESTOR_PEDIDOS')) {
      this.adminApi.loadOrders();
    }
    if (this.tokens.can('DOMICILIARIO')) {
      this.adminApi.loadDeliveries();
    }
  }

  protected toggleSidebar(): void {
    this.isSidebarOpen.update((open) => !open);
  }

  protected closeSidebar(): void {
    this.isSidebarOpen.set(false);
  }

  protected logout(): void {
    this.api.logout();
    void this.router.navigate(['/admin/login']);
  }
}
