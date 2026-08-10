import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ReportsService } from '../../../core/services/reports.service';
import { AdminStoreService } from '../../../core/services/admin-store.service';
import { AuthService } from '../../../core/services/auth.service';
import { ADMIN_GROUP_LABELS, AdminGroup } from '../../../core/models/product.model';
import { AbcClass, CashClosing, PAYMENT_METHOD_LABELS } from '../../../core/models/report.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Insignias del podio. Tonos terrosos, nada de oro/plata metálicos. */
const MEDAL_STYLES = [
  { label: 'Más vendido', chip: 'bg-clay text-bone' },
  { label: 'Segundo', chip: 'bg-sage text-moss-deep' },
  { label: 'Tercero', chip: 'bg-sand text-ink-soft' },
] as const;

const ABC_STYLES: Readonly<Record<AbcClass, { chip: string; hint: string }>> = {
  A: { chip: 'bg-moss text-bone', hint: 'Genera hasta el 80 % de los ingresos' },
  B: { chip: 'bg-sage-light text-moss-deep', hint: 'Del 80 % al 95 % de los ingresos' },
  C: { chip: 'bg-linen text-ink-muted', hint: 'Cola larga: mucha referencia, poco ingreso' },
};

@Component({
  selector: 'app-sales-reports',
  imports: [CopPipe],
  templateUrl: './sales-reports.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesReports {
  protected readonly reports = inject(ReportsService);
  protected readonly store = inject(AdminStoreService);
  private readonly auth = inject(AuthService);

  protected readonly groups = ADMIN_GROUP_LABELS;
  protected readonly medals = MEDAL_STYLES;
  protected readonly abcStyles = ABC_STYLES;
  protected readonly methodLabels = PAYMENT_METHOD_LABELS;

  /** Cierre recién hecho, para mostrar el comprobante sin recargar. */
  protected readonly justClosed = signal<CashClosing | null>(null);
  protected readonly confirming = signal(false);

  protected readonly receiptPreview = computed(() => {
    const closing = this.justClosed();
    return closing ? this.reports.buildReceipt(closing) : null;
  });

  protected setGroup(group: AdminGroup | 'todos'): void {
    this.reports.group.set(group);
  }

  /** Posición en el podio global, o -1 si no está en el top 3. */
  protected medalIndex(productId: string): number {
    return this.reports.topProducts().findIndex((row) => row.productId === productId);
  }

  protected askConfirm(): void {
    this.justClosed.set(null);
    this.confirming.set(true);
  }

  protected cancelClose(): void {
    this.confirming.set(false);
  }

  /**
   * Cierre de jornada. Se pide confirmación antes porque archiva pedidos y no
   * hay forma de deshacerlo desde la interfaz.
   */
  protected confirmClose(): void {
    const closedBy = this.auth.user()?.name ?? 'Desconocido';
    const result = this.reports.performClosing(closedBy);
    this.confirming.set(false);

    if (result.ok) {
      this.justClosed.set(result.closing);
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }

  protected download(closing: CashClosing): void {
    this.reports.downloadReceipt(closing);
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  protected sharePercent(share: number): number {
    return Math.round(share * 100);
  }
}
