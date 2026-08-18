import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

type FilterVariant = 'chips' | 'select';

export interface CategoryFilterOption {
  readonly value: string;
  readonly label: string;
  /** Se omite si no hay conteo que mostrar para esa opción. */
  readonly count?: number;
}

/**
 * Chips (vitrina) o desplegable (admin) para elegir una categoría de una
 * lista. No sabe nada de dónde salen las opciones ni cómo se cuentan: todo
 * llega por `@Input`, así que sirve igual para filtrar el catálogo público,
 * el inventario o el consolidado sin que el componente conozca a ninguno de
 * los tres. Quien lo usa decide qué pasar y qué hacer con `valueChange`.
 */
@Component({
  selector: 'app-category-filter',
  templateUrl: './category-filter.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryFilterComponent {
  readonly variant = input<FilterVariant>('chips');
  readonly options = input<readonly CategoryFilterOption[]>([]);
  readonly selectedValue = input<string>('todos');
  readonly showCounts = input(true);
  readonly id = signal(`cf-${Math.random().toString(36).slice(2, 9)}`);

  readonly valueChange = output<string>();

  protected isActive(optionValue: string): boolean {
    return this.selectedValue() === optionValue;
  }

  protected select(optionValue: string): void {
    this.valueChange.emit(optionValue);
  }
}
