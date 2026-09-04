import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { CopPipe } from '../../../../shared/pipes/cop.pipe';

/** Por dónde se movió la plata. Determina a qué cuenta va o de cuál sale. */
export type MetodoPago = 'efectivo' | 'transferencia';

export interface PagoConfirmado {
  readonly monto: number;
  readonly metodo: MetodoPago;
}

/**
 * La ventana de registrar plata: sirve para cobrar y para girar.
 *
 * ── Por qué uno solo para las dos pestañas ──
 *
 * Cobrarle a un cliente y girarle a una finca son la misma operación con el
 * signo cambiado: un tercero, un saldo, cuánto se mueve y por dónde. Dos
 * modales separados serían el mismo formulario copiado, y el día que hubiera
 * que arreglar una validación habría que acordarse de arreglar las dos.
 *
 * ── Por qué el método es obligatorio y no tiene valor «por si acaso» ──
 *
 * De él sale la cuenta: efectivo toca el cajón, transferencia toca el banco.
 * Si se dejara adivinar, el arqueo del turno cuadraría contra el cajón
 * equivocado y el cajero tendría billetes de menos sin que nadie sepa por qué.
 * Por eso el selector muestra a qué cuenta va a caer la plata, no solo el
 * nombre del medio.
 */
@Component({
  selector: 'app-registrar-pago-modal',
  standalone: true,
  imports: [CopPipe],
  templateUrl: './registrar-pago-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegistrarPagoModal {
  /** «Registrar cobro» o «Registrar giro». */
  readonly titulo = input.required<string>();
  /** A quién se le cobra o a quién se le gira. */
  readonly tercero = input.required<string>();
  /** El número de factura o el detalle de la compra, para no equivocarse. */
  readonly referencia = input<string | null>(null);
  /** Lo que falta. Es el tope del abono y el valor con el que arranca. */
  readonly saldo = input.required<number>();
  /** Lo que ya se movió antes, si hubo abonos previos. */
  readonly abonado = input(0);
  /** Verdadero mientras el Worker responde. */
  readonly trabajando = input(false);
  /** Lo que dijo el Worker si falló, para mostrarlo dentro de la ventana. */
  readonly error = input<string | null>(null);
  /** Cambia de dónde SALE la plata en vez de a dónde entra (giros). */
  readonly esSalida = input(false);

  readonly confirmar = output<PagoConfirmado>();
  readonly cancelar = output<void>();

  protected readonly monto = signal(0);
  protected readonly metodo = signal<MetodoPago>('efectivo');

  constructor() {
    // Arranca con el saldo completo escrito: cobrar todo lo que se debe es el
    // caso de siempre, y así ese caso es un solo clic. Quien viene a abonar
    // una parte borra el número y escribe la suya — un campo vacío obligaría
    // a teclear la cifra completa en el caso frecuente.
    effect(() => this.monto.set(this.saldo()));
  }

  protected readonly excede = computed(() => this.monto() > this.saldo());

  protected readonly esAbonoParcial = computed(
    () => this.monto() > 0 && this.monto() < this.saldo(),
  );

  protected readonly restante = computed(() => Math.max(0, this.saldo() - this.monto()));

  protected readonly puedeConfirmar = computed(
    () => this.monto() > 0 && !this.excede() && !this.trabajando(),
  );

  /** A qué cuenta va a caer (o de cuál va a salir) según el método elegido. */
  protected readonly cuenta = computed(() =>
    this.metodo() === 'efectivo' ? 'Caja (efectivo)' : 'Cuenta bancaria',
  );

  protected onMonto(valor: string): void {
    this.monto.set(Math.max(0, Math.floor(Number(valor) || 0)));
  }

  protected todo(): void {
    this.monto.set(this.saldo());
  }

  protected enviar(): void {
    if (!this.puedeConfirmar()) return;
    this.confirmar.emit({ monto: this.monto(), metodo: this.metodo() });
  }
}
