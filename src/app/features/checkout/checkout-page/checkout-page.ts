import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CartService } from '../../../core/services/cart.service';
import {
  BANK_DETAILS,
  CheckoutService,
} from '../../../core/services/checkout.service';
import { ApiErrorBody, Shortfall } from '../../../core/api/api-client';
import { PaymentProof } from '../../../core/models/order.model';
import {
  formatDay,
  isCutoffNear,
  nextCutoff,
  nextDispatch,
} from '../../../core/models/ordering-window';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { ProofUploader } from '../proof-uploader/proof-uploader';
import { OrderSuccess } from '../order-success/order-success';

/** Acepta dígitos, espacios, guiones y un `+` inicial: "300 214 5588", "+57 300 214 5588". */
const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{6,17}$/;

@Component({
  selector: 'app-checkout-page',
  imports: [ReactiveFormsModule, CopPipe, ProofUploader, OrderSuccess],
  templateUrl: './checkout-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CheckoutPage {
  protected readonly cart = inject(CartService);
  protected readonly checkout = inject(CheckoutService);
  private readonly fb = inject(FormBuilder);

  protected readonly bank = BANK_DETAILS;

  /** Ventana semanal de acopio; ver `ordering-window.ts`. */
  protected readonly cutoffDay = formatDay(nextCutoff());
  protected readonly dispatchDay = formatDay(nextDispatch());
  protected readonly cutoffNear = isCutoffNear();

  protected readonly shortfalls = signal<readonly Shortfall[] | null>(null);
  protected readonly copied = signal(false);
  protected readonly placing = signal(false);

  /** Se muestra solo tras un intento de envío con el formulario incompleto,
   *  o cuando el servidor rechaza el pedido por un motivo que no es stock. */
  protected readonly formError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(3)]],
    phone: ['', [Validators.required, Validators.pattern(PHONE_PATTERN)]],
    address: ['', [Validators.required, Validators.minLength(5)]],
  });

  protected onProofChange(proof: PaymentProof | null): void {
    this.checkout.setProof(proof);
  }

  protected showError(field: 'name' | 'phone' | 'address'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  /** Copia el número de cuenta: escribirlo a mano es donde se cuelan errores. */
  protected async copyAccount(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.bank.accountNumber);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Sin permiso de portapapeles no pasa nada: el número está a la vista.
    }
  }

  protected submit(): void {
    this.shortfalls.set(null);
    this.formError.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set('Completa los datos obligatorios (nombre, teléfono y dirección) para continuar.');
      return;
    }

    this.placing.set(true);
    const { name, phone, address } = this.form.getRawValue();

    this.checkout.placeOrder({ name, phone, address }).subscribe({
      next: () => {
        this.placing.set(false);
        // El botón está al final del formulario: sin esto, la pantalla de
        // éxito aparecería con el scroll a mitad y el cliente no la vería.
        window.scrollTo({ top: 0, behavior: 'instant' });
      },
      error: (error: ApiErrorBody) => {
        this.placing.set(false);

        if (error.code === 'stock-insuficiente') {
          const shortfalls = (error.details as { shortfalls?: Shortfall[] } | undefined)?.shortfalls ?? [];
          this.shortfalls.set(shortfalls);
          return;
        }

        this.formError.set(error.message);
      },
    });
  }
}
