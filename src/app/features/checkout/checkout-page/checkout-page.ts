import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CartService } from '../../../core/services/cart.service';
import {
  BANK_DETAILS,
  CheckoutService,
} from '../../../core/services/checkout.service';
import { ApiErrorBody, Shortfall } from '../../../core/api/api-client';
import { PaymentProof, WebPaymentMethod } from '../../../core/models/order.model';
import { componentPortion } from '../../../core/models/product.model';
import {
  formatDay,
  isCutoffNear,
  nextCutoff,
  nextDispatch,
} from '../../../core/models/ordering-window';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { FieldError, FieldErrorState } from '../../../shared/field-error/field-error';
import { ProofUploader } from '../proof-uploader/proof-uploader';
import { OrderSuccess } from '../order-success/order-success';

/** Acepta dígitos, espacios, guiones y un `+` inicial: "300 214 5588", "+57 300 214 5588". */
const PHONE_PATTERN = /^\+?[0-9][0-9\s-]{6,17}$/;

type CampoDatos = 'name' | 'cedula' | 'phone' | 'address';

/**
 * Los tres campos en el mismo orden en que aparecen en pantalla.
 *
 * El orden importa: "el primer campo con error" tiene que ser el primero que
 * el usuario ve, no el primero que devuelva `Object.keys` sobre el formulario.
 * `id` enlaza cada campo con su mensaje de error y con el resumen de arriba.
 */
const CAMPOS: readonly { control: CampoDatos; etiqueta: string; id: string }[] = [
  { control: 'name', etiqueta: 'Nombre completo', id: 'nombre' },
  { control: 'cedula', etiqueta: 'Cédula', id: 'cedula' },
  { control: 'phone', etiqueta: 'Teléfono', id: 'telefono' },
  { control: 'address', etiqueta: 'Dirección de entrega', id: 'direccion' },
];

@Component({
  selector: 'app-checkout-page',
  imports: [ReactiveFormsModule, CopPipe, FieldErrorState, FieldError, ProofUploader, OrderSuccess],
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

  protected readonly metodoPago = this.checkout.metodoPago;

  /** Se muestra solo tras un intento de envío con el formulario incompleto,
   *  o cuando el servidor rechaza el pedido por un motivo que no es stock. */
  protected readonly formError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(3)]],
    // Cinco caracteres es lo más corto que puede ser un documento real.
    // No se valida el formato: aquí entran cédulas, NIT y pasaportes.
    cedula: ['', [Validators.required, Validators.minLength(5)]],
    phone: ['', [Validators.required, Validators.pattern(PHONE_PATTERN)]],
    address: ['', [Validators.required, Validators.minLength(5)]],
  });

  protected readonly campos = CAMPOS;

  /**
   * Campos que fallaron en el último intento de envío.
   *
   * Se calcula **al enviar**, no de forma continua: el resumen solo debe
   * aparecer cuando el usuario ya intentó continuar. Si se recalculara con
   * cada tecla, un formulario recién abierto anunciaría tres errores que
   * nadie ha cometido todavía.
   */
  protected readonly camposConError = signal<readonly { etiqueta: string; id: string }[]>([]);

  private readonly nombreInput = viewChild<ElementRef<HTMLInputElement>>('nombreInput');
  private readonly cedulaInput = viewChild<ElementRef<HTMLInputElement>>('cedulaInput');
  private readonly telefonoInput = viewChild<ElementRef<HTMLInputElement>>('telefonoInput');
  private readonly direccionInput = viewChild<ElementRef<HTMLInputElement>>('direccionInput');

  private focoInicialHecho = false;

  constructor() {
    /**
     * Al llegar a /checkout el foco se queda donde estuviera el enlace que
     * trajo al usuario —normalmente el carrito o el pie—, así que navegar con
     * teclado obligaba a tabular media página para empezar a escribir.
     *
     * Va en un `effect` y no en `ngAfterViewInit` porque el formulario no
     * existe en el primer render: mientras el catálogo carga, el carrito está
     * vacío y la plantilla pinta el aviso de "no hay nada". `viewChild`
     * devuelve una señal, así que el efecto se vuelve a ejecutar solo cuando
     * el campo aparece de verdad.
     */
    effect(() => {
      const primero = this.nombreInput();
      if (!primero || this.focoInicialHecho) {
        return;
      }
      this.focoInicialHecho = true;
      primero.nativeElement.focus();
    });
  }

  protected onProofChange(proof: PaymentProof | null): void {
    this.checkout.setProof(proof);
  }

  /** «2 × 500 gr»: cuánto de un componente lleva UNA canasta de esta línea. */
  protected readonly porcion = componentPortion;

  private refDe(control: CampoDatos): ElementRef<HTMLInputElement> | undefined {
    switch (control) {
      case 'name':
        return this.nombreInput();
      case 'cedula':
        return this.cedulaInput();
      case 'phone':
        return this.telefonoInput();
      case 'address':
        return this.direccionInput();
    }
  }

  /**
   * Lleva el foco al primer campo con error, en orden de pantalla.
   *
   * Sin esto, tras un envío fallido el foco se queda en el botón —al final del
   * formulario— y con lector de pantalla no hay forma de saber qué falló ni
   * dónde: solo que "algo" pasó. Con el foco en el campo, el lector anuncia su
   * etiqueta, su estado inválido y el mensaje enlazado por `aria-describedby`,
   * las tres cosas de una vez.
   */
  protected focusFirstInvalid(): void {
    const primero = CAMPOS.find(({ control }) => this.form.controls[control].invalid);
    this.refDe(primero?.control ?? 'name')?.nativeElement.focus();
  }

  /** Enfoca un campo concreto desde el resumen de errores de la cabecera. */
  protected focusCampo(id: string): void {
    const campo = CAMPOS.find((c) => c.id === id);
    if (campo) {
      this.refDe(campo.control)?.nativeElement.focus();
    }
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

  protected onMetodoPagoChange(valor: string): void {
    this.metodoPago.set(valor as WebPaymentMethod);
  }

  protected submit(): void {
    this.shortfalls.set(null);
    this.formError.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();

      const fallidos = CAMPOS.filter(({ control }) => this.form.controls[control].invalid);
      this.camposConError.set(fallidos.map(({ etiqueta, id }) => ({ etiqueta, id })));
      this.formError.set(
        fallidos.length === 1
          ? `Falta un dato: ${fallidos[0].etiqueta.toLowerCase()}.`
          : `Faltan ${fallidos.length} datos para continuar.`,
      );

      // El foco se mueve en el siguiente ciclo, no ahora mismo: `markAllAsTouched`
      // acaba de cambiar el estado y el `aria-describedby` que enlaza el campo
      // con su mensaje se pinta al renderizar. Enfocando antes, el lector de
      // pantalla anunciaría el campo sin el error que explica qué corregir.
      setTimeout(() => this.focusFirstInvalid());
      return;
    }

    this.camposConError.set([]);
    this.placing.set(true);
    const { name, cedula, phone, address } = this.form.getRawValue();

    this.checkout
      .placeOrder({ name, cedula, phone, address, metodoPago: this.metodoPago() }).subscribe({
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
