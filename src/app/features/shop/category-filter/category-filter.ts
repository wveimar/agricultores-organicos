import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CatalogService } from '../../../core/services/catalog.service';
import { CategoryId } from '../../../core/models/product.model';

@Component({
  selector: 'app-category-filter',
  templateUrl: './category-filter.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryFilter {
  protected readonly catalog = inject(CatalogService);

  protected select(id: CategoryId | 'todos'): void {
    this.catalog.selectCategory(id);
  }

  protected onQuery(event: Event): void {
    this.catalog.setQuery((event.target as HTMLInputElement).value);
  }
}
