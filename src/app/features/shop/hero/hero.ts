import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HERO_IMAGE } from '../../../core/data/mock-catalog';

@Component({
  selector: 'app-hero',
  templateUrl: './hero.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Hero {
  /** Imagen de fondo. Carga con prioridad alta: es el LCP de la página. */
  protected readonly image = HERO_IMAGE;
}
