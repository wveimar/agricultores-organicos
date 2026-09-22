import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * A dónde llega quien entra a `/` o `/checkout` cuando E-commerce está
 * apagado en esta instalación. No es un error: es una tienda que decidió
 * vender solo de mostrador. El catálogo del cajero sigue intacto — esto solo
 * cierra la puerta pública.
 */
@Component({
  selector: 'app-tienda-no-disponible',
  template: `
    <div class="mx-auto max-w-md px-4 py-24 text-center">
      <h1 class="text-h2 text-ink">La tienda en línea no está disponible por ahora</h1>
      <p class="mt-3 text-sm text-ink-soft">
        Este negocio solo atiende de mostrador en este momento. Si necesitas algo, visítanos en
        tienda o escríbenos directamente.
      </p>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TiendaNoDisponible {}
