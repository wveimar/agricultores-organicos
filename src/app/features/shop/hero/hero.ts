import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HERO_IMAGE } from '../../../core/data/mock-catalog';
import { CatalogService } from '../../../core/services/catalog.service';

/**
 * Imagen del hero mientras la solapa Turismo está activa.
 *
 * No sale de `mock-catalog.ts` como `HERO_IMAGE` a propósito: aquella es la
 * foto del puesto de mercado, y enseñarla bajo "Turismo" —con el tema ya en
 * azul— sería el mismo desajuste que este componente existe para evitar.
 */
const TOUR_HERO_IMAGE = 'https://picsum.photos/seed/hero-turismo/1600/900';

@Component({
  selector: 'app-hero',
  templateUrl: './hero.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Hero {
  private readonly catalog = inject(CatalogService);

  /**
   * El hero es el primer bloque de la página y el que más se nota el
   * desajuste de vertical: mostrar "Cosecha de la semana" con fotos de
   * verdura mientras la tienda ya está en azul (Turismo, ver `styles.css`)
   * sería justo lo contrario de lo que pide un tema por grupo. Un negocio
   * que solo venda un tipo de cosas puede simplificar esto a una sola
   * versión; este proyecto vende los dos a la vez, así que el hero necesita
   * las dos.
   */
  protected readonly isTurismo = computed(() => this.catalog.activeGroup() === 'turismo');

  /** Imagen de fondo. Carga con prioridad alta: es el LCP de la página. */
  protected readonly image = computed(() => (this.isTurismo() ? TOUR_HERO_IMAGE : HERO_IMAGE));

  private readonly ahora = signal(new Date());

  /** Rango de fechas de la semana actual (lunes a domingo). */
  protected readonly semanaDehoy = computed(() => {
    const hoy = this.ahora();
    const dia = hoy.getDay();
    // Convierte domingo (0) a 7 para que el cálculo sea correcto.
    const diferencia = dia === 0 ? 7 : dia;
    // Retrocede al lunes.
    const lunes = new Date(hoy);
    lunes.setDate(hoy.getDate() - diferencia + 1);

    // Avanza al domingo.
    const domingo = new Date(lunes);
    domingo.setDate(lunes.getDate() + 6);

    // Formato: "Cosecha del 9 al 15 de agosto" o "Cosecha del 9 de agosto al 15 de septiembre".
    const lunesDia = lunes.getDate();
    const lunesFormato = new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(lunes);
    const domingoDia = domingo.getDate();
    const domingoFormato = new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(domingo);

    const mismesMes = lunes.getMonth() === domingo.getMonth();
    if (mismesMes) {
      return `Cosecha del ${lunesDia} al ${domingoDia} de ${lunesFormato}`;
    } else {
      return `Cosecha del ${lunesDia} de ${lunesFormato} al ${domingoDia} de ${domingoFormato}`;
    }
  });
}
