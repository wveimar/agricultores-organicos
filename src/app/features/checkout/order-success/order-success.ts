import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CheckoutService } from '../../../core/services/checkout.service';
import { Order, orderUnits } from '../../../core/models/order.model';
import { componentPortion, formatSessionDate } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

@Component({
  selector: 'app-order-success',
  imports: [CopPipe, RouterLink],
  templateUrl: './order-success.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderSuccess {
  readonly order = input.required<Order>();

  private readonly checkout = inject(CheckoutService);

  protected readonly whatsappUrl = computed(() => this.checkout.whatsappLink(this.order()));
  protected readonly units = computed(() => orderUnits(this.order()));
  /** Al menos una línea reservó una sesión: el pedido es de servicios, no de productos físicos. */
  protected readonly isService = computed(() => this.order().lines.some((line) => line.session));
  /** A qué vitrina vuelve "Seguir comprando" (0040): la del tipo de este pedido. */
  protected readonly shopPath = computed(() => (this.isService() ? '/turismo' : '/mercado'));

  protected startAnother(): void {
    this.checkout.reset();
  }

  /** «2 × 500 gr»: cuánto de un componente lleva UNA canasta de esta línea. */
  protected readonly porcion = componentPortion;
  /** «viernes 14 mar · 9:00 a. m.»: fecha de la sesión reservada de una línea. */
  protected readonly fechaSesion = formatSessionDate;
}
