import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminStoreService } from '../../../core/services/admin-store.service';
import { AuthService } from '../../../core/services/auth.service';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/**
 * Portada del panel: resumen y accesos según el rol. Sustituye a un redirect
 * automático porque un `SUPER_ADMIN` no tiene un único destino natural.
 */
@Component({
  selector: 'app-admin-home',
  imports: [RouterLink, CopPipe],
  templateUrl: './admin-home.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminHome {
  protected readonly store = inject(AdminStoreService);
  protected readonly auth = inject(AuthService);

  protected readonly canInventory = computed(() => this.auth.can('ADMIN_INVENTARIO'));
  protected readonly canOrders = computed(() => this.auth.can('GESTOR_PEDIDOS'));

  /** Primer nombre, para que el saludo no suene a carta formal. */
  protected readonly firstName = computed(() => this.auth.user()?.name.split(' ')[0] ?? '');

  protected reset(): void {
    this.store.resetDemo();
  }
}
