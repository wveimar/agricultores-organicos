import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AdminStoreService } from '../../../core/services/admin-store.service';
import { AuthService } from '../../../core/services/auth.service';
import { ROLE_LABELS, UserRole } from '../../../core/models/user.model';

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
  protected readonly auth = inject(AuthService);
  protected readonly store = inject(AdminStoreService);
  private readonly router = inject(Router);

  protected readonly isSidebarOpen = signal(false);

  private readonly allItems: readonly NavItem[] = [
    { path: '/admin/inventario', label: 'Inventario', roles: ['ADMIN_INVENTARIO'], badge: this.store.alertCount },
    { path: '/admin/pedidos', label: 'Pedidos', roles: ['GESTOR_PEDIDOS'], badge: this.store.pendingCount },
    { path: '/admin/reportes', label: 'Reportes', roles: ['GESTOR_PEDIDOS', 'ADMIN_INVENTARIO'] },
  ];

  /** El menú solo muestra lo que el rol puede abrir de verdad. */
  protected readonly navItems = computed(() =>
    this.allItems.filter((item) => this.auth.can(...item.roles)),
  );

  protected readonly roleLabel = computed(() => {
    const roles = this.auth.roles();
    return roles.map((role) => ROLE_LABELS[role]).join(' · ');
  });

  protected readonly initials = computed(() => {
    const name = this.auth.user()?.name ?? '';
    return name
      .split(' ')
      .slice(0, 2)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase();
  });

  protected toggleSidebar(): void {
    this.isSidebarOpen.update((open) => !open);
  }

  protected closeSidebar(): void {
    this.isSidebarOpen.set(false);
  }

  protected logout(): void {
    this.auth.logout();
    void this.router.navigate(['/admin/login']);
  }
}
