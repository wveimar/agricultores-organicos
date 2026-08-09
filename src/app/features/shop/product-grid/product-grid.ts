import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CatalogService } from '../../../core/services/catalog.service';
import { ProductCard } from '../product-card/product-card';

@Component({
  selector: 'app-product-grid',
  imports: [ProductCard],
  templateUrl: './product-grid.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProductGrid {
  protected readonly catalog = inject(CatalogService);
}
