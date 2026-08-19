import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { CatalogService } from '../../../core/services/catalog.service';
import { CategoryId } from '../../../core/models/product.model';

@Component({
  selector: 'app-category-filter',
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

  protected select(id: CategoryId | 'todos'): void {
    this.catalog.selectCategory(id);
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
