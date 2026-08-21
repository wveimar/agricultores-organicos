import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CheckoutService } from '../../../core/services/checkout.service';
import { Order, orderUnits } from '../../../core/models/order.model';
import { componentPortion } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

@Component({
  selector: 'app-order-success',
  imports: [CopPipe],
  templateUrl: './order-success.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderSuccess {
  readonly order = input.required<Order>();

  private readonly checkout = inject(CheckoutService);

  protected readonly whatsappUrl = computed(() => this.checkout.whatsappLink(this.order()));
  protected readonly units = computed(() => orderUnits(this.order()));

  protected startAnother(): void {
    this.checkout.reset();
  }

  /** «2 × 500 gr»: cuánto de un componente lleva UNA canasta de esta línea. */
  protected readonly porcion = componentPortion;
}
