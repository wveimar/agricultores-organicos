import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CatalogService } from '../../../core/services/catalog.service';
import { CategoryId, SORT_LABELS, SortOption } from '../../../core/models/product.model';

@Component({
  selector: 'app-category-filter',
  templateUrl: './category-filter.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryFilter {
  protected readonly catalog = inject(CatalogService);
  protected readonly sortOptions = SORT_LABELS;

  protected select(id: CategoryId | 'todos'): void {
    this.catalog.selectCategory(id);
  }

  protected onSortChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SortOption;
    this.catalog.setSort(value);
  }
}
