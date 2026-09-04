import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiClient } from '../../../core/api/api-client';
import { TokenStore } from '../../../core/api/token-store';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { UserRole } from '../../../core/models/user.model';
import { AdminNavIcon } from './admin-nav-icon';

interface NavItem {
  readonly path: string;
  readonly label: string;
  /** Clave de la silueta. Ver `AdminNavIcon`: es lo único que queda visible
   *  cuando el menú está colapsado. */
  readonly icon: string;
  readonly roles: readonly UserRole[];
  readonly badge?: () => number;
}

@Component({
  selector: 'app-admin-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AdminNavIcon],
  templateUrl: './admin-layout.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLayout {
  protected readonly tokens = inject(TokenStore);
  protected readonly adminApi = inject(AdminApiService);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  protected readonly isSidebarOpen = signal(false);

  /**
   * Menú encogido a solo iconos.
   *
   * Se recuerda entre navegaciones y recargas porque es una preferencia de
   * cómo se trabaja, no un estado de la pantalla: quien atiende la caja en un
   * monitor pequeño lo colapsa una vez y espera encontrarlo así mañana.
   *
   * `localStorage` puede lanzar —ventana privada, cookies bloqueadas— así que
   * lectura y escritura van protegidas: sin poder recordarlo, el menú sigue
   * funcionando, simplemente arranca abierto.
   */
  private static readonly CLAVE_COLAPSO = 'ao.admin.sidebar.colapsado';

  protected readonly isSidebarCollapsed = signal(AdminLayout.leerColapso());

  private static leerColapso(): boolean {
    try {
      return localStorage.getItem(AdminLayout.CLAVE_COLAPSO) === '1';
    } catch {
      return false;
    }
  }

  protected toggleCollapsed(): void {
    const siguiente = !this.isSidebarCollapsed();
    this.isSidebarCollapsed.set(siguiente);
    try {
      localStorage.setItem(AdminLayout.CLAVE_COLAPSO, siguiente ? '1' : '0');
    } catch {
      // Sin dónde guardarlo, el menú se comporta igual durante esta sesión.
    }
  }

  private readonly allItems: readonly NavItem[] = [
    {
      path: '/admin/inventario',
      label: 'Inventario',
      icon: 'inventario',
      roles: ['ADMIN_INVENTARIO'],
      badge: this.adminApi.alertCount,
    },
    // Va pegada al inventario: son las dos listas con las que se archiva cada
    // producto, y quien las toca es la misma persona.
    { path: '/admin/categorias', label: 'Categorías', icon: 'categorias', roles: ['ADMIN_INVENTARIO'] },
    { path: '/admin/grupos', label: 'Grupos', icon: 'grupos', roles: ['ADMIN_INVENTARIO'] },
    // Primero la caja: es la pantalla que se abre al empezar el día en la
    // tienda física y la única que se usa con un cliente esperando enfrente.
    { path: '/admin/caja', label: 'Caja', icon: 'caja', roles: ['GESTOR_PEDIDOS'] },
    {
      path: '/admin/pedidos',
      label: 'Pedidos',
      icon: 'pedidos',
      roles: ['GESTOR_PEDIDOS'],
      badge: this.adminApi.pendingCount,
    },
    {
      path: '/admin/consolidado',
      label: 'Consolidado',
      icon: 'consolidado',
      roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'],
    },
    { path: '/admin/reportes', label: 'Reportes', icon: 'reportes', roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'] },
    // Facturación antes que Tesorería, en el orden en que ocurren: primero se
    // emite el documento, después se persigue el cobro.
    { path: '/admin/facturacion', label: 'Facturación', icon: 'facturacion', roles: ['GESTOR_PEDIDOS'] },
    // Tesorería se comió cuatro entradas del menú —Cartera, Gastos, Cobros y
    // el cierre que vivía en Reportes— porque las cuatro responden a la misma
    // pregunta desde ángulos distintos: dónde está la plata. Tenerlas
    // separadas obligaba a ir y volver entre menús para cuadrar un solo día.
    //
    // La pantalla de Cobros sigue viva en /admin/cobros y es la única que
    // permite repartir un cobro entre varias facturas o corregir uno ya
    // registrado. Lo que se quitó es la entrada del menú: el cobro del día a
    // día se hace desde «Por cobrar», factura por factura, que es como llega
    // el cliente al mostrador.
    { path: '/admin/tesoreria', label: 'Tesorería', icon: 'cartera', roles: ['GESTOR_PEDIDOS'] },
    {
      path: '/admin/compras',
      label: 'Compras',
      icon: 'compras',
      roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'],
    },
    // Junto a Compras y no junto a Gastos, aunque las dos resten de la
    // ganancia: la merma se decide mirando la bodega, no la caja, y quien la
    // firma es quien acaba de registrar la entrada de esa misma fruta.
    {
      path: '/admin/mermas',
      label: 'Mermas',
      icon: 'mermas',
      roles: ['ADMIN_INVENTARIO'],
    },
    // Pegada a Compras: el proveedor al que se le compra sale de aquí.
    {
      path: '/admin/contactos',
      label: 'Contactos',
      icon: 'contactos',
      roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'],
    },
    {
      path: '/admin/entregas',
      label: 'Entregas',
      icon: 'entregas',
      roles: ['DOMICILIARIO'],
      badge: this.adminApi.deliveryCount,
    },
    { path: '/admin/mayoristas', label: 'Mayoristas', icon: 'mayoristas', roles: ['SUPER_ADMIN'] },
    { path: '/admin/usuarios', label: 'Usuarios', icon: 'usuarios', roles: ['SUPER_ADMIN'] },
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
