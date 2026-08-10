import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminStoreService } from '../../../core/services/admin-store.service';
import {
  ADMIN_GROUP_LABELS,
  AdminGroup,
  Product,
  StockLevel,
  UNIT_LABELS,
  marginOf,
  marginPercentOf,
  stockLevelOf,
} from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Clases del semáforo de stock. Una sola fuente para chip y fila. */
export const STOCK_STYLES: Readonly<Record<StockLevel, { chip: string; label: string }>> = {
  agotado: { chip: 'bg-berry/12 text-berry', label: 'Agotado' },
  critico: { chip: 'bg-honey/20 text-clay-deep', label: 'Bajo mínimo' },
  ok: { chip: 'bg-sage-light text-moss-deep', label: 'Disponible' },
};

@Component({
  selector: 'app-inventory-dashboard',
  imports: [ReactiveFormsModule, CopPipe],
  templateUrl: './inventory-dashboard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InventoryDashboard {
  protected readonly store = inject(AdminStoreService);
  private readonly fb = inject(FormBuilder);

  protected readonly groups = ADMIN_GROUP_LABELS;
  protected readonly unitLabels = UNIT_LABELS;
  protected readonly stockStyles = STOCK_STYLES;

  protected readonly activeGroup = signal<AdminGroup | 'todos'>('todos');
  protected readonly query = signal('');
  /** Cuando está activo, la tabla solo muestra lo que hay que reponer. */
  protected readonly onlyAlerts = signal(false);

  /** Producto abierto en el formulario de edición. `null` = ninguno. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly savedId = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    price: [0, [Validators.required, Validators.min(1)]],
    costPrice: [0, [Validators.required, Validators.min(0)]],
    stock: [0, [Validators.required, Validators.min(0)]],
    safetyStock: [0, [Validators.required, Validators.min(0)]],
  });

  protected readonly rows = computed<readonly Product[]>(() => {
    const term = this.query().trim().toLowerCase();
    const onlyAlerts = this.onlyAlerts();

    return this.store
      .byGroup(this.activeGroup())
      .filter((product) => {
        if (onlyAlerts && stockLevelOf(product) === 'ok') {
          return false;
        }
        if (!term) {
          return true;
        }
        return (
          product.name.toLowerCase().includes(term) ||
          product.origin.toLowerCase().includes(term)
        );
      })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  });

  protected readonly countsByGroup = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = {};
    for (const group of this.groups) {
      totals[group.value] = this.store.byGroup(group.value).length;
    }
    return totals;
  });

  protected levelOf(product: Product): StockLevel {
    return stockLevelOf(product);
  }

  protected marginOf(product: Product): number {
    return marginOf(product);
  }

  protected marginPercent(product: Product): number {
    return Math.round(marginPercentOf(product) * 100);
  }

  /** Porcentaje de la barra de stock respecto al doble del umbral. */
  protected fillPercent(product: Product): number {
    const ceiling = Math.max(product.safetyStock * 2, 1);
    return Math.min(100, Math.round((product.stock / ceiling) * 100));
  }

  protected startEdit(product: Product): void {
    this.editingId.set(product.id);
    this.savedId.set(null);
    this.form.setValue({
      price: product.price,
      costPrice: product.costPrice,
      stock: product.stock,
      safetyStock: product.safetyStock,
    });
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
  }

  protected save(productId: string): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.store.updateProduct(productId, this.form.getRawValue());
    this.editingId.set(null);
    this.savedId.set(productId);

    // El aviso de "guardado" se retira solo; no merece un botón de cerrar.
    setTimeout(() => {
      if (this.savedId() === productId) {
        this.savedId.set(null);
      }
    }, 2600);
  }

  protected showError(field: 'price' | 'costPrice' | 'stock' | 'safetyStock'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  protected setGroup(group: AdminGroup | 'todos'): void {
    this.activeGroup.set(group);
    this.editingId.set(null);
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
