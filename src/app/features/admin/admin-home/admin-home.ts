import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TokenStore } from '../../../core/api/token-store';
import { AdminApiService } from '../../../core/services/admin-api.service';
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
  protected readonly adminApi = inject(AdminApiService);
  protected readonly tokens = inject(TokenStore);

  protected readonly canInventory = computed(() => this.tokens.can('ADMIN_INVENTARIO'));
  protected readonly canOrders = computed(() => this.tokens.can('GESTOR_PEDIDOS'));

  /** Primer nombre, para que el saludo no suene a carta formal. */
  protected readonly firstName = computed(
    () => this.tokens.user()?.nombre.split(' ')[0] ?? '',
  );

  protected readonly inventoryValue = computed(() =>
    this.adminApi.products().reduce((total, p) => total + p.stock * p.precio, 0),
  );

  protected refresh(): void {
    this.adminApi.refreshHome();
  }
}
