import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  viewChild,
} from '@angular/core';
import { CatalogService } from '../../../core/services/catalog.service';
import { AdminGroup, CategoryId } from '../../../core/models/product.model';
import { CategoryIcon } from '../../../shared/category-icon/category-icon';

@Component({
  selector: 'app-category-filter',
  imports: [CategoryIcon],
  templateUrl: './category-filter.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // El atajo se escucha en el documento y no en el propio campo: sirve
    // justamente para llegar a él desde cualquier punto de la página.
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class CategoryFilter {
  protected readonly catalog = inject(CatalogService);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('buscador');
  private readonly chips = viewChild<ElementRef<HTMLElement>>('chips');
  private readonly solapas = viewChild<ElementRef<HTMLElement>>('solapas');

  constructor() {
    // El primer ajuste no se anima: es la posición de partida, no un
    // movimiento, y verla deslizarse sola al cargar la página parece un fallo.
    let primera = true;

    /**
     * Trae a la vista el chip activo cuando queda fuera de pantalla.
     *
     * Con diez categorías la fila mide bastante más que un teléfono. Al
     * recargar con «Canastas» puesta —o al llegar desde un enlace— su chip
     * está a la derecha, fuera del encuadre, y la barra se ve como si no
     * hubiera nada seleccionado mientras la rejilla enseña una sola sección.
     *
     * Va en `afterRenderEffect` y no en `effect`: mide y desplaza el DOM, así
     * que tiene que correr con la vista ya pintada. Y lee `visibleCategories`
     * aunque no use el valor, porque al llegar el catálogo la barra pasa de un
     * chip a diez: sin esa dependencia el efecto no volvería a correr y el
     * chip activo se quedaría escondido.
     */
    afterRenderEffect(() => {
      const activa = this.catalog.activeCategory();
      this.catalog.visibleCategories();

      const fila = this.chips()?.nativeElement;
      const chip = fila?.querySelector<HTMLElement>(`[data-category="${activa}"]`);
      if (!chip) {
        return;
      }

      chip.scrollIntoView({
        // `nearest` y no `center`: centrar movería la fila en cada toque,
        // incluso con el chip ya entero a la vista. `nearest` solo actúa
        // cuando de verdad hace falta.
        inline: 'nearest',
        // Obligatorio. Sin él el navegador también desplaza la página en
        // vertical para «traer» la barra, que al ser pegajosa ya se veía: el
        // salto deja la rejilla a media altura sin motivo.
        block: 'nearest',
        behavior: primera || this.prefiereMenosMovimiento() ? 'instant' : 'smooth',
      });

      primera = false;
    });

    /**
     * Lo mismo con las solapas, y por el mismo motivo: en cuanto hay cuatro
     * grupos la fila deja de caber en un teléfono y se desplaza. Recargar
     * dentro de un grupo que quedó a la derecha dejaría la carpeta con
     * ninguna solapa abierta a la vista.
     *
     * Lleva su propia bandera y no la de los chips: las dos filas se pintan y
     * se recolocan por su cuenta, y compartir el «ya no es la primera vez»
     * haría que la segunda en llegar se deslizara sola al cargar.
     */
    let primeraSolapa = true;

    afterRenderEffect(() => {
      const abierto = this.catalog.activeGroup();
      this.catalog.visibleGroups();

      const fila = this.solapas()?.nativeElement;
      const solapa = fila?.querySelector<HTMLElement>(`[data-grupo="${abierto}"]`);
      if (!solapa) {
        return;
      }

      solapa.scrollIntoView({
        inline: 'nearest',
        block: 'nearest',
        behavior: primeraSolapa || this.prefiereMenosMovimiento() ? 'instant' : 'smooth',
      });

      primeraSolapa = false;
    });
  }

  /** `doc/plan.md §6`: el movimiento es discreto, y opcional si el sistema lo pide. */
  private prefiereMenosMovimiento(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  protected select(id: CategoryId | 'todos'): void {
    this.catalog.selectCategory(id);
  }

  /** Abre una solapa. El servicio se encarga de soltar el chip que había puesto. */
  protected selectGroup(id: AdminGroup | 'todos'): void {
    this.catalog.selectGroup(id);
  }

  protected onQuery(event: Event): void {
    this.catalog.setQuery((event.target as HTMLInputElement).value);
  }

  /**
   * Ctrl+K —⌘K en Mac— lleva el foco al buscador, y Escape lo deshace.
   *
   * Escape solo actúa con el foco ya dentro del campo. Fuera de él es la tecla
   * que cierra el modal de variantes y el menú del header: quedársela aquí
   * apagaría cosas que sí se querían cerrar.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const input = this.searchInput()?.nativeElement;
    if (!input) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
      input.select();
      return;
    }

    if (event.key === 'Escape' && document.activeElement === input) {
      event.preventDefault();

      // Primer Escape limpia lo escrito; el segundo suelta el foco. Limpiar y
      // salir a la vez dejaría sin manera de corregir una búsqueda a medias.
      if (this.catalog.query()) {
        this.catalog.setQuery('');
      } else {
        input.blur();
      }
    }
  }
}
