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

/** Un cliente con algo pendiente, y todas sus facturas abiertas. */
interface GrupoDeudor {
  readonly key: string;
  readonly contactId: string | null;
  readonly clienteNombre: string;
  readonly totalDebe: number;
  readonly facturas: readonly ApiDeuda[];
}

/** Los cobros de un mismo cliente, agrupados para el historial. */
interface GrupoPagos {
  readonly key: string;
  readonly clienteNombre: string;
  readonly pagos: readonly ApiPayment[];
}

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
    this.adminApi.loadDeudores();
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

  /**
   * Quién debe, agrupado por cliente — el «quién llamar hoy» de esta pantalla.
   *
   * Siempre visible, sin tener que abrir «Registrar cobro» y buscar un nombre
   * a ciegas en el desplegable. La llave es el `contactId`; sin él —no
   * debería pasar aquí, toda factura con saldo viene de un pedido o de un
   * alta manual con cliente— se agrupa por nombre, igual que en Facturación.
   *
   * `deudores()` ya llega ordenado `contact_id, emitida_en` desde el
   * servidor, así que las facturas de cada grupo salen de la más vieja a la
   * más nueva sin tener que reordenarlas aquí — es justo el orden en que se
   * van a cobrar.
   */
  protected readonly gruposDeudores = computed<readonly GrupoDeudor[]>(() => {
    const porCliente = new Map<
      string,
      { contactId: string | null; clienteNombre: string; facturas: ApiDeuda[] }
    >();

    for (const deuda of this.adminApi.deudores()) {
      const key = deuda.contactId ?? `nombre:${deuda.clienteNombre}`;
      const grupo = porCliente.get(key);
      if (grupo) {
        grupo.facturas.push(deuda);
      } else {
        porCliente.set(key, {
          contactId: deuda.contactId,
          clienteNombre: deuda.clienteNombre,
          facturas: [deuda],
        });
      }
    }

    return [...porCliente.entries()]
      .map(([key, grupo]) => ({
        key,
        contactId: grupo.contactId,
        clienteNombre: grupo.clienteNombre,
        totalDebe: grupo.facturas.reduce((suma, f) => suma + f.saldo, 0),
        facturas: grupo.facturas,
      }))
      .sort((a, b) => b.totalDebe - a.totalDebe || a.clienteNombre.localeCompare(b.clienteNombre, 'es'));
  });

  /**
   * El historial de cobros, agrupado por cliente.
   *
   * Sin reordenar nada: `visible()` ya llega del servidor con el más reciente
   * primero, así que basta con ir metiendo cada cobro en el grupo de su
   * cliente en el orden en que aparecen — el primer cliente en tener un cobro
   * es, sin más cálculo, el de movimiento más reciente. Un `Map` conserva el
   * orden de inserción por eso mismo.
   */
  protected readonly gruposPagos = computed<readonly GrupoPagos[]>(() => {
    const porCliente = new Map<string, { clienteNombre: string; pagos: ApiPayment[] }>();

    for (const pago of this.visible()) {
      const key = pago.contactId ?? `nombre:${pago.clienteNombre}`;
      const grupo = porCliente.get(key);
      if (grupo) {
        grupo.pagos.push(pago);
      } else {
        porCliente.set(key, { clienteNombre: pago.clienteNombre, pagos: [pago] });
      }
    }

    return [...porCliente.entries()].map(([key, grupo]) => ({
      key,
      clienteNombre: grupo.clienteNombre,
      pagos: grupo.pagos,
    }));
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

  /**
   * Abre el formulario con este cliente ya elegido, desde el panel de
   * deudores. Evita el desplegable: quien mira esa lista ya sabe a quién le
   * va a cobrar, y ya tiene sus facturas delante — no hace falta preguntarle
   * dos veces.
   *
   * Sin `contactId` (grupo agrupado por nombre, sin ficha real) no hay a
   * quién asignarle el cobro por API, así que no se ofrece el atajo — ver la
   * plantilla, que solo pinta el botón cuando `grupo.contactId` existe.
   */
  protected cobrarA(grupo: GrupoDeudor): void {
    if (!grupo.contactId) {
      return;
    }
    this.error.set(null);
    this.aviso.set(null);
    this.editandoId.set(null);
    this.form.reset({ contactId: grupo.contactId, monto: 0, metodo: 'efectivo', nota: '' });
    this.deudas.set(grupo.facturas);
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
