import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiProduct } from '../../../core/api/api-client';
import { ADMIN_GROUP_LABELS, AdminGroup, UNIT_LABELS } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

type StockLevel = 'agotado' | 'critico' | 'ok';

/** Clases del semáforo de stock. Una sola fuente para chip y fila. */
export const STOCK_STYLES: Readonly<Record<StockLevel, { chip: string; label: string }>> = {
  agotado: { chip: 'bg-berry/12 text-berry', label: 'Agotado' },
  critico: { chip: 'bg-honey/20 text-clay-deep', label: 'Bajo mínimo' },
  ok: { chip: 'bg-sage-light text-moss-deep', label: 'Disponible' },
};

function levelOf(product: ApiProduct): StockLevel {
  if (product.stock <= 0) {
    return 'agotado';
  }
  return product.stock <= (product.stockSeguridad ?? 0) ? 'critico' : 'ok';
}

@Component({
  selector: 'app-inventory-dashboard',
  imports: [ReactiveFormsModule, RouterLink, CopPipe],
  templateUrl: './inventory-dashboard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InventoryDashboard {
  protected readonly adminApi = inject(AdminApiService);
  private readonly fb = inject(FormBuilder);

  protected readonly groups = ADMIN_GROUP_LABELS;
  protected readonly stockStyles = STOCK_STYLES;

  protected readonly activeGroup = signal<AdminGroup | 'todos'>('todos');
  protected readonly query = signal('');
  /** Cuando está activo, la tabla solo muestra lo que hay que reponer. */
  protected readonly onlyAlerts = signal(false);

  /** Producto abierto en el formulario de edición. `null` = ninguno. */
  protected readonly editingId = signal<string | null>(null);
  protected readonly savedId = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    price: [0, [Validators.required, Validators.min(1)]],
    costPrice: [0, [Validators.required, Validators.min(0)]],
    stock: [0, [Validators.required, Validators.min(0)]],
    safetyStock: [0, [Validators.required, Validators.min(0)]],
  });

  constructor() {
    this.adminApi.loadProducts();
  }

  protected readonly rows = computed<readonly ApiProduct[]>(() => {
    const group = this.activeGroup();
    const term = this.query().trim().toLowerCase();
    const onlyAlerts = this.onlyAlerts();

    return this.adminApi
      .products()
      .filter((product) => {
        if (group !== 'todos' && product.grupoAdmin !== group) {
          return false;
        }
        if (onlyAlerts && levelOf(product) === 'ok') {
          return false;
        }
        if (!term) {
          return true;
        }
        return (
          product.nombre.toLowerCase().includes(term) ||
          product.origen.toLowerCase().includes(term)
        );
      })
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });

  protected readonly countsByGroup = computed<Record<string, number>>(() => {
    const totals: Record<string, number> = { todos: this.adminApi.products().length };
    for (const product of this.adminApi.products()) {
      totals[product.grupoAdmin] = (totals[product.grupoAdmin] ?? 0) + 1;
    }
    return totals;
  });

  protected readonly inventoryValue = computed(() =>
    this.adminApi.products().reduce((total, p) => total + p.stock * p.precio, 0),
  );

  protected readonly inventoryCost = computed(() =>
    this.adminApi.products().reduce((total, p) => total + p.stock * (p.precioCosto ?? 0), 0),
  );

  protected readonly potentialProfit = computed(() => this.inventoryValue() - this.inventoryCost());

  protected levelOf(product: ApiProduct): StockLevel {
    return levelOf(product);
  }

  protected marginOf(product: ApiProduct): number {
    return product.precio - (product.precioCosto ?? 0);
  }

  protected marginPercent(product: ApiProduct): number {
    return product.precio > 0 ? Math.round((this.marginOf(product) / product.precio) * 100) : 0;
  }

  /** `unidad` llega como texto libre desde la API; se resuelve con fallback. */
  protected unitLabel(product: ApiProduct): string {
    return (UNIT_LABELS as Record<string, string>)[product.unidad] ?? product.unidad;
  }

  /** Porcentaje de la barra de stock respecto al doble del umbral. */
  protected fillPercent(product: ApiProduct): number {
    const ceiling = Math.max((product.stockSeguridad ?? 0) * 2, 1);
    return Math.min(100, Math.round((product.stock / ceiling) * 100));
  }

  protected startEdit(product: ApiProduct): void {
    this.editingId.set(product.id);
    this.savedId.set(null);
    this.saveError.set(null);
    this.form.setValue({
      price: product.precio,
      costPrice: product.precioCosto ?? 0,
      stock: product.stock,
      safetyStock: product.stockSeguridad ?? 0,
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

    this.saveError.set(null);
    this.saving.set(true);
    const { price, costPrice, stock, safetyStock } = this.form.getRawValue();

    this.adminApi
      .updateProduct(productId, { precio: price, precioCosto: costPrice, stock, stockSeguridad: safetyStock })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editingId.set(null);
          this.savedId.set(productId);

          // El aviso de "guardado" se retira solo; no merece un botón de cerrar.
          setTimeout(() => {
            if (this.savedId() === productId) {
              this.savedId.set(null);
            }
          }, 2600);
        },
        error: (error: ApiErrorBody) => {
          this.saving.set(false);
          this.saveError.set(error.message);
        },
      });
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
