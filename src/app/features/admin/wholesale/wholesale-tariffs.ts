import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiWholesaleRow } from '../../../core/api/api-client';
import { ROLE_LABELS, WHOLESALE_ROLES, WholesaleRole } from '../../../core/models/user.model';
import { CATEGORIES } from '../../../core/data/mock-catalog';
import { ProductUnit, unitPresentation } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { CategoryFilterComponent } from '../../../shared/components/category-filter/category-filter';

/** Nombre legible de cada categoría, de la misma lista que pinta la vitrina. */
const CATEGORY_LABEL: Readonly<Record<string, string>> = Object.fromEntries(
  CATEGORIES.filter((c) => c.id !== 'todos').map((c) => [c.id, c.name]),
);

@Component({
  selector: 'app-wholesale-tariffs',
  imports: [CopPipe, CategoryFilterComponent],
  templateUrl: './wholesale-tariffs.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WholesaleTariffs {
  private readonly adminApi = inject(AdminApiService);

  protected readonly tiers = WHOLESALE_ROLES;
  protected readonly roleLabels = ROLE_LABELS;

  protected readonly tier = signal<WholesaleRole>('MAYORISTA_N1');
  protected readonly query = signal('');
  protected readonly category = signal('todos');

  /** Solo los que ya tienen tarifa. Para repasar lo negociado sin ruido. */
  protected readonly onlyWithDiscount = signal(false);

  /** Fila que se está guardando, para bloquear su input mientras viaja. */
  protected readonly savingId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);

  /** Productos marcados para la aplicación masiva. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly bulkPercent = signal('');
  protected readonly bulkSaving = signal(false);

  protected readonly tariff = this.adminApi.wholesaleTariff;
  protected readonly loading = this.adminApi.wholesaleLoading;

  constructor() {
    this.adminApi.loadWholesaleTariff(this.tier());
  }

  protected selectTier(tier: WholesaleRole): void {
    if (tier === this.tier()) {
      return;
    }
    this.tier.set(tier);
    // La selección es de productos *para este nivel*: arrastrarla al siguiente
    // haría que un "aplicar a los marcados" tocara una tarifa que no se está
    // mirando.
    this.selected.set(new Set());
    this.feedback.set(null);
    this.error.set(null);
    this.adminApi.loadWholesaleTariff(tier);
  }

  protected readonly rows = computed<readonly ApiWholesaleRow[]>(() => {
    const term = this.query().trim().toLowerCase();
    const categoria = this.category();
    const soloConDescuento = this.onlyWithDiscount();

    return (this.tariff()?.products ?? []).filter((row) => {
      if (categoria !== 'todos' && row.categoriaId !== categoria) {
        return false;
      }
      if (soloConDescuento && row.porcentaje === null) {
        return false;
      }
      return !term || row.nombre.toLowerCase().includes(term);
    });
  });

  /** Categorías presentes en el catálogo, con su conteo. */
  protected readonly categoryOptions = computed(() => {
    const productos = this.tariff()?.products ?? [];
    const counts = new Map<string, number>();
    for (const row of productos) {
      counts.set(row.categoriaId, (counts.get(row.categoriaId) ?? 0) + 1);
    }

    return [
      { value: 'todos', label: 'Todas', count: productos.length },
      ...[...counts.entries()]
        .sort((a, b) =>
          (CATEGORY_LABEL[a[0]] ?? a[0]).localeCompare(CATEGORY_LABEL[b[0]] ?? b[0], 'es'),
        )
        .map(([id, count]) => ({ value: id, label: CATEGORY_LABEL[id] ?? id, count })),
    ];
  });

  protected readonly selectedCount = computed(() => this.selected().size);

  /** `true` si todo lo visible está marcado. Para el checkbox de la cabecera. */
  protected readonly allVisibleSelected = computed(() => {
    const visibles = this.rows();
    if (visibles.length === 0) {
      return false;
    }
    const marcados = this.selected();
    return visibles.every((row) => marcados.has(row.productId));
  });

  protected isSelected(productId: string): boolean {
    return this.selected().has(productId);
  }

  protected toggleRow(productId: string): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  }

  /**
   * Marca o desmarca **lo visible**, no el catálogo entero: si hay un filtro
   * puesto, "todos" tiene que significar los que se están viendo. Marcar en
   * silencio lo que el filtro oculta es la forma de aplicar una tarifa a
   * cuarenta productos sin querer.
   */
  protected toggleAllVisible(): void {
    const visibles = this.rows().map((row) => row.productId);
    this.selected.update((current) => {
      const next = new Set(current);
      const todosMarcados = visibles.every((id) => next.has(id));
      for (const id of visibles) {
        if (todosMarcados) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  // ─────────────────────────── Guardado por fila ───────────────────────────

  /**
   * Guarda el descuento de un producto.
   *
   * Se dispara en `change` (al salir del campo o pulsar Enter), no en cada
   * pulsación: con `input` se mandaría una petición por dígito, y teclear
   * "15" pasaría antes por "1", dejando la tarifa en 1 % si la segunda
   * petición llegara desordenada.
   */
  protected saveRow(row: ApiWholesaleRow, raw: string): void {
    const valor = raw.trim() === '' ? 0 : Number(raw);

    if (!Number.isInteger(valor) || valor < 0 || valor > 100) {
      this.error.set(`"${raw}" no es un porcentaje válido: usa un entero entre 0 y 100.`);
      return;
    }
    if (valor === (row.porcentaje ?? 0)) {
      return;
    }

    this.error.set(null);
    this.feedback.set(null);
    this.savingId.set(row.productId);

    this.adminApi.setWholesaleDiscount(this.tier(), row.productId, valor).subscribe({
      next: (res) => {
        this.savingId.set(null);
        this.feedback.set(
          res.porcentaje === null
            ? `${row.nombre} vuelve al precio de lista.`
            : `${row.nombre}: −${res.porcentaje} % → ${this.money(res.precioMayorista)}` +
              (res.bajoCosto ? ' · queda por debajo del costo' : ''),
        );
      },
      error: (err: ApiErrorBody) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  // ──────────────────────────── Aplicación masiva ────────────────────────────

  protected applyBulk(): void {
    const raw = this.bulkPercent().trim();
    const valor = raw === '' ? NaN : Number(raw);

    if (!Number.isInteger(valor) || valor < 0 || valor > 100) {
      this.error.set('Escribe un porcentaje entero entre 0 y 100.');
      return;
    }

    const ids = [...this.selected()];
    if (ids.length === 0) {
      return;
    }

    this.error.set(null);
    this.feedback.set(null);
    this.bulkSaving.set(true);

    this.adminApi.setWholesaleBulk(this.tier(), ids, valor).subscribe({
      next: (res) => {
        this.bulkSaving.set(false);
        this.selected.set(new Set());
        this.bulkPercent.set('');
        this.feedback.set(
          res.porcentaje === null
            ? `${res.aplicados} producto(s) vuelven al precio de lista.`
            : `−${res.porcentaje} % aplicado a ${res.aplicados} producto(s).`,
        );
      },
      error: (err: ApiErrorBody) => {
        this.bulkSaving.set(false);
        this.error.set(err.message);
      },
    });
  }

  // ─────────────────────────────── Presentación ───────────────────────────────

  protected unitLabel(row: ApiWholesaleRow): string {
    return unitPresentation(row.cantidadUnidad ?? 1, row.unidad as ProductUnit);
  }

  /** Margen que queda sobre el costo de la finca al precio de mayorista. */
  protected margin(row: ApiWholesaleRow): number {
    return row.precioMayorista - row.precioCosto;
  }

  protected marginPercent(row: ApiWholesaleRow): number {
    return row.precioMayorista > 0
      ? Math.round((this.margin(row) / row.precioMayorista) * 100)
      : 0;
  }

  /** `true` cuando la tarifa vende por debajo de lo que se le paga a la finca. */
  protected belowCost(row: ApiWholesaleRow): boolean {
    return row.precioMayorista < row.precioCosto;
  }

  private money(value: number): string {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      maximumFractionDigits: 0,
    }).format(value);
  }
}
