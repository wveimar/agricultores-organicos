import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminApiService } from '../../../core/services/admin-api.service';
import {
  ApiAllocation,
  ApiDeuda,
  ApiErrorBody,
  ApiPayment,
} from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

const METODOS = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'nequi', label: 'Nequi' },
  { value: 'daviplata', label: 'Daviplata' },
] as const;

/**
 * Cobros — el dinero que entra.
 *
 * Registrar un abono es elegir cliente y monto; contra qué facturas se aplica
 * lo decide el servidor, de la más vieja a la más nueva, que es el
 * comportamiento por defecto de cualquier sistema contable. Cobrar primero lo
 * viejo impide que una deuda envejezca indefinidamente mientras el cliente
 * sigue comprando y pagando lo último.
 *
 * Lo que sobre después de cubrir todo queda como **anticipo**: plata del
 * cliente que todavía no corresponde a ninguna factura. Se avisa al guardar,
 * porque es fácil teclear un cero de más y el resultado no sería un error sino
 * un saldo a favor silencioso.
 *
 * Un cobro ya barrido por un cierre de caja no se toca: sus cifras están
 * congeladas en esa jornada. El servidor lo rechaza igual.
 */
@Component({
  selector: 'app-payments-manager',
  imports: [CopPipe, ReactiveFormsModule],
  templateUrl: './payments-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentsManager {
  protected readonly adminApi = inject(AdminApiService);
  private readonly fb = inject(FormBuilder);

  protected readonly metodos = METODOS;

  protected readonly busqueda = signal('');
  protected readonly abierto = signal(false);
  protected readonly editandoId = signal<string | null>(null);
  protected readonly borrandoId = signal<string | null>(null);
  protected readonly guardando = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Último resultado, para avisar del anticipo sin un modal. */
  protected readonly aviso = signal<string | null>(null);

  /** Las deudas del cliente elegido, para enseñar contra qué se va a aplicar. */
  protected readonly deudas = signal<readonly ApiDeuda[]>([]);
  /** El reparto de un cobro que se está mirando. */
  protected readonly reparto = signal<readonly ApiAllocation[]>([]);

  protected readonly form = this.fb.nonNullable.group({
    contactId: ['', Validators.required],
    monto: [0, [Validators.required, Validators.min(1)]],
    metodo: ['efectivo'],
    nota: [''],
  });

  private readonly valorForm = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });

  constructor() {
    this.adminApi.loadPayments();
    this.adminApi.loadContacts();
  }

  /** Solo los clientes: a un proveedor no se le cobra, se le paga. */
  protected readonly clientes = computed(() =>
    this.adminApi.contacts().filter((contacto) => contacto.esCliente === 1 && contacto.activo === 1),
  );

  protected readonly visible = computed<readonly ApiPayment[]>(() => {
    const termino = this.busqueda().trim().toLowerCase();
    if (!termino) {
      return this.adminApi.payments();
    }
    return this.adminApi
      .payments()
      .filter(
        (pago) =>
          pago.clienteNombre.toLowerCase().includes(termino) ||
          pago.referencia.toLowerCase().includes(termino),
      );
  });

  /** Cuánto del cobro que se está escribiendo va a quedar sin aplicar. */
  protected readonly anticipoPrevisto = computed(() => {
    const monto = this.valorForm().monto ?? 0;
    const deuda = this.deudas().reduce((total, d) => total + d.saldo, 0);
    return Math.max(0, monto - deuda);
  });

  protected readonly deudaTotal = computed(() =>
    this.deudas().reduce((total, d) => total + d.saldo, 0),
  );

  protected etiquetaMetodo(valor: string): string {
    return METODOS.find((m) => m.value === valor)?.label ?? valor;
  }

  /** Igual que en Facturación: SQLite y el seed traen dos formatos distintos. */
  protected fecha(valor: string | null): string {
    if (!valor) {
      return '';
    }
    const iso = valor.includes('T') ? valor : `${valor.replace(' ', 'T')}Z`;
    const fecha = new Date(iso);
    if (Number.isNaN(fecha.getTime())) {
      return valor;
    }
    return fecha.toLocaleDateString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  /** Un cobro cerrado en una jornada ya no se puede tocar. */
  protected sePuedeModificar(pago: ApiPayment): boolean {
    return pago.closingId === null;
  }

  protected onBuscar(event: Event): void {
    this.busqueda.set((event.target as HTMLInputElement).value);
  }

  protected onCliente(event: Event): void {
    const contactId = (event.target as HTMLSelectElement).value;
    this.form.controls.contactId.setValue(contactId);
    this.cargarDeudas(contactId);
  }

  private cargarDeudas(contactId: string): void {
    if (!contactId) {
      this.deudas.set([]);
      return;
    }
    this.adminApi.deudasDe(contactId).subscribe({
      next: (lista) => this.deudas.set(lista),
      error: () => this.deudas.set([]),
    });
  }

  protected abrir(): void {
    this.error.set(null);
    this.aviso.set(null);
    this.deudas.set([]);
    this.form.reset({ contactId: '', monto: 0, metodo: 'efectivo', nota: '' });
    this.editandoId.set(null);
    this.abierto.set(true);
  }

  protected editar(pago: ApiPayment): void {
    this.error.set(null);
    this.aviso.set(null);
    this.form.reset({
      contactId: pago.contactId ?? '',
      monto: pago.monto,
      metodo: pago.metodo,
      nota: pago.nota ?? '',
    });
    if (pago.contactId) {
      this.cargarDeudas(pago.contactId);
    }
    this.editandoId.set(pago.id);
    this.abierto.set(true);
  }

  protected cerrar(): void {
    this.abierto.set(false);
    this.editandoId.set(null);
    this.error.set(null);
  }

  /** Enseña contra qué facturas se aplicó un cobro ya registrado. */
  protected verReparto(pago: ApiPayment): void {
    this.adminApi.paymentDetail(pago.id).subscribe({
      next: ({ allocations }) => this.reparto.set(allocations),
      error: (fallo: ApiErrorBody) => this.error.set(fallo.message),
    });
  }

  protected guardar(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Falta el cliente o el monto.');
      return;
    }

    const valor = this.form.getRawValue();
    const id = this.editandoId();

    const peticion = id
      ? this.adminApi.updatePayment(id, {
          monto: valor.monto,
          metodo: valor.metodo,
          nota: valor.nota || null,
        })
      : this.adminApi.createPayment({
          contactId: valor.contactId,
          monto: valor.monto,
          metodo: valor.metodo,
          nota: valor.nota || null,
        });

    this.error.set(null);
    this.guardando.set(true);

    peticion.subscribe({
      next: ({ anticipo }) => {
        this.guardando.set(false);
        this.abierto.set(false);
        this.editandoId.set(null);
        // Se avisa siempre que sobre plata: teclear un cero de más no da error,
        // da un saldo a favor que nadie pidió.
        this.aviso.set(
          anticipo > 0
            ? `Quedaron ${anticipo.toLocaleString('es-CO')} sin aplicar: es saldo a favor del cliente.`
            : null,
        );
      },
      error: (fallo: ApiErrorBody) => {
        this.guardando.set(false);
        this.error.set(fallo.message);
      },
    });
  }

  protected preguntarBorrar(id: string): void {
    this.error.set(null);
    this.borrandoId.set(id);
  }

  protected cancelarBorrar(): void {
    this.borrandoId.set(null);
  }

  protected borrar(id: string): void {
    this.error.set(null);
    this.guardando.set(true);

    this.adminApi.deletePayment(id).subscribe({
      next: () => {
        this.guardando.set(false);
        this.borrandoId.set(null);
        this.aviso.set('Cobro deshecho: las facturas que tocaba vuelven a deber.');
      },
      error: (fallo: ApiErrorBody) => {
        this.guardando.set(false);
        this.borrandoId.set(null);
        this.error.set(fallo.message);
      },
    });
  }
}
