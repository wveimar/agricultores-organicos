import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiClient } from '../../../core/api/api-client';
import { TokenStore } from '../../../core/api/token-store';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { SiteConfigService } from '../../../core/services/site-config.service';
import { UserRole, Workspace } from '../../../core/models/user.model';
import { AdminNavIcon } from './admin-nav-icon';

interface NavItem {
  readonly path: string;
  readonly label: string;
  /** Clave de la silueta. Ver `AdminNavIcon`: es lo único que queda visible
   *  cuando el menú está colapsado. */
  readonly icon: string;
  readonly roles: readonly UserRole[];
  readonly badge?: () => number;
  /**
   * Módulo activable del que depende esta entrada (ver `AdminApiService`,
   * los `modulo*` computed). `undefined` = siempre visible: es una sección
   * que cualquier negocio necesita (Pedidos, Inventario, Facturación…), no
   * una decisión de vertical.
   */
  readonly module?: () => boolean;
  /**
   * Workspace fijo (0040) del que depende esta entrada — Caja, Compras,
   * Mermas, Entregas y Mayoristas son conceptos de retail físico que un
   * admin de tours no usa. `undefined` = visible en cualquier workspace: la
   * mayoría de secciones (Pedidos, Inventario, Reportes…) sirven a las dos
   * vitrinas por igual, porque comparten las mismas tablas de productos y
   * pedidos.
   */
  readonly workspace?: Workspace;
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
  protected readonly brand = inject(SiteConfigService);
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
    {
      path: '/admin/caja',
      label: 'Caja',
      icon: 'caja',
      roles: ['GESTOR_PEDIDOS'],
      module: this.adminApi.moduloPos,
      workspace: 'mercado',
    },
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
      module: this.adminApi.moduloCompras,
      workspace: 'mercado',
    },
    // Junto a Compras y no junto a Gastos, aunque las dos resten de la
    // ganancia: la merma se decide mirando la bodega, no la caja, y quien la
    // firma es quien acaba de registrar la entrada de esa misma fruta.
    {
      path: '/admin/mermas',
      label: 'Mermas',
      icon: 'mermas',
      roles: ['ADMIN_INVENTARIO'],
      module: this.adminApi.moduloMermas,
      workspace: 'mercado',
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
      module: this.adminApi.moduloDomicilios,
      workspace: 'mercado',
    },
    {
      path: '/admin/mayoristas',
      label: 'Mayoristas',
      icon: 'mayoristas',
      roles: ['SUPER_ADMIN'],
      module: this.adminApi.moduloMayoristas,
      workspace: 'mercado',
    },
    { path: '/admin/usuarios', label: 'Usuarios', icon: 'usuarios', roles: ['SUPER_ADMIN'] },
    // Solo SUPER_ADMIN: aquí se prende o apaga todo lo demás de esta lista.
    { path: '/admin/ajustes', label: 'Ajustes', icon: 'ajustes', roles: ['SUPER_ADMIN'] },
  ];

  /**
   * El menú solo muestra lo que el rol puede abrir, lo que su módulo tiene
   * activado, Y lo que el workspace fijo de la cuenta incluye.
   */
  protected readonly navItems = computed(() =>
    this.allItems.filter(
      (item) =>
        this.tokens.can(...item.roles) &&
        (!item.module || item.module()) &&
        (!item.workspace || this.tokens.canWorkspace(item.workspace)),
    ),
  );

  private currentThemeClass: string | null = null;

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
    // Qué módulos están activos: decide qué entradas del menú de arriba se
    // pintan. Cualquier rol del panel puede leerlo — ver la nota en
    // `settings.ts list()`.
    this.adminApi.loadAjustes();

    /**
     * El panel se viste con el tema del workspace fijo de la cuenta (0040):
     * mismo mecanismo que `PublicShell` —una clase `theme-<valor>` en
     * `<body>` que `styles.css` traduce en la paleta azul de Turismo—, pero
     * aquí la fuente es `TokenStore.workspace()` (la cuenta que entró), no
     * la ruta. 'ambos' se queda en el verde de siempre: no hay un "tema
     * mixto" que pintar.
     */
    effect(() => {
      const workspace = this.tokens.workspace();
      const next = workspace === 'turismo' ? 'theme-turismo' : null;

      if (this.currentThemeClass === next) {
        return;
      }
      if (this.currentThemeClass) {
        document.body.classList.remove(this.currentThemeClass);
      }
      if (next) {
        document.body.classList.add(next);
      }
      this.currentThemeClass = next;
    });

    inject(DestroyRef).onDestroy(() => {
      if (this.currentThemeClass) {
        document.body.classList.remove(this.currentThemeClass);
      }
    });
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
