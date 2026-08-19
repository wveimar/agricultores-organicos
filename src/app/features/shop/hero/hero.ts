import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { HERO_IMAGE } from '../../../core/data/mock-catalog';

@Component({
  selector: 'app-hero',
  templateUrl: './hero.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Hero {
  /** Imagen de fondo. Carga con prioridad alta: es el LCP de la página. */
  protected readonly image = HERO_IMAGE;

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
