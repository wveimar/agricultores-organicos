import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { ROLE_LABELS } from '../../../core/models/user.model';

/**
 * Autenticado pero sin el rol necesario. Es un caso distinto de "no has
 * entrado": repetir el login aquí solo confundiría, porque las credenciales
 * son correctas.
 */
@Component({
  selector: 'app-forbidden',
  imports: [RouterLink],
  template: `
    <div class="mx-auto max-w-md py-20 text-center">
      <p class="text-overline font-semibold uppercase text-clay">Acceso restringido</p>
      <h1 class="mt-4 text-h2 text-ink">Tu rol no abre esta sección</h1>
      <p class="mt-3 text-sm text-ink-soft">
        Entraste como <span class="font-medium text-ink">{{ auth.user()?.name }}</span>, con permisos
        de {{ roleLabel() }}. Si necesitas acceso, pídeselo a administración general.
      </p>

      <div class="mt-8 flex flex-wrap justify-center gap-3">
        <a
          routerLink="/admin"
          class="rounded-full bg-moss px-6 py-3 text-sm font-semibold text-bone transition-colors duration-200 hover:bg-moss-deep"
        >
          Ir a mi panel
        </a>
        <a
          routerLink="/"
          class="rounded-full border border-sand px-6 py-3 text-sm text-ink-soft transition-colors duration-200 hover:border-stone hover:text-ink"
        >
          Volver a la tienda
        </a>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Forbidden {
  protected readonly auth = inject(AuthService);

  protected roleLabel(): string {
    return this.auth.roles().map((role) => ROLE_LABELS[role]).join(' · ') || 'sin rol asignado';
  }
}
