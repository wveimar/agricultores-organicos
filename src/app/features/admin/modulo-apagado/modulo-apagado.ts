import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * A diferencia de `Forbidden`: aquí el rol sí alcanza. Lo que falta es que
 * esta instalación tenga el módulo encendido — es una decisión del negocio,
 * no un permiso de la cuenta, así que la pantalla no habla de pedirle acceso
 * a nadie.
 */
@Component({
  selector: 'app-modulo-apagado',
  imports: [RouterLink],
  template: `
    <div class="mx-auto max-w-md py-20 text-center">
      <p class="text-overline font-semibold uppercase text-signal text-clay">Módulo apagado</p>
      <h1 class="mt-4 text-h2 text-ink">Esta sección no está activa</h1>
      <p class="mt-3 text-sm text-ink-soft">
        No es un problema de permisos — este módulo está apagado en «Módulos activos». Un
        <span class="font-medium text-ink">SUPER_ADMIN</span> puede encenderlo desde ahí si hace falta.
      </p>

      <div class="mt-8 flex flex-wrap justify-center gap-3">
        <a
          routerLink="/admin/modulos"
          class="rounded-full bg-moss px-6 py-3 text-sm font-semibold text-bone transition-colors duration-200 hover:bg-moss-deep"
        >
          Ir a Módulos activos
        </a>
        <a
          routerLink="/admin"
          class="rounded-full border border-sand px-6 py-3 text-sm text-ink-soft transition-colors duration-200 hover:border-stone hover:text-ink"
        >
          Ir a mi panel
        </a>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModuloApagado {}
