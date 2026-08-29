import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiErrorBody, ApiInvoice, ApiInvoiceInput } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Los estados, en el orden en que se miran: primero lo que falta por cobrar. */
const ESTADOS = [
  { value: 'emitida', label: 'Por cobrar' },
  { value: 'pagada_parcial', label: 'Abonadas' },
  { value: 'pagada', label: 'Pagadas' },
  { value: 'anulada', label: 'Anuladas' },
] as const;

type Estado = (typeof ESTADOS)[number]['value'];

/**
 * Facturación — el libro de ventas.
 *
 * Aquí no se crea nada. La factura nace sola al aprobar un pedido, dentro del
 * mismo `batch()` que descuenta el inventario (migración 0027), porque un
 * despacho sin documento contable no es un estado que deba poder existir.
 *
 * Lo único que se puede hacer sobre una factura emitida es **anularla**, y
 * exige motivo. No hay edición: corregir es anular y emitir de nuevo, que es
 * lo que deja rastro de que hubo una corrección. Es la misma regla de Odoo,
 * QuickBooks y Stripe, y la razón de que los abonos cuelguen de la factura y
 * no del pedido — el pedido sí se edita, y la deuda del cliente no puede
 * moverse cada vez que alguien corrige una línea.
 *
 * El filtro por estado se resuelve en el cliente y no pidiendo de nuevo al
 * servidor: son como mucho 200 filas ya en memoria, y recargar por cada
 * pestaña haría parpadear las cifras de la cabecera.
 */
@Component({
  selector: 'app-invoices-manager',
  imports: [CopPipe, ReactiveFormsModule],
  templateUrl: './invoices-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvoicesManager {
  protected readonly adminApi = inject(AdminApiService);
  private readonly fb = inject(FormBuilder);

  protected readonly estados = ESTADOS;

  protected readonly busqueda = signal('');
  protected readonly estadoActivo = signal<Estado | 'todos'>('todos');

  /** Factura cuya confirmación de anulación está abierta. */
  protected readonly anulandoId = signal<string | null>(null);
  protected readonly motivo = signal('');
  /** Factura cuya confirmación de borrado está abierta. */
  protected readonly borrandoId = signal<string | null>(null);
  protected readonly guardando = signal(false);
  protected readonly error = signal<string | null>(null);

  /** `null` = formulario cerrado · `'nueva'` = creando · un id = editando. */
  protected readonly editandoId = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    clienteNombre: ['', [Validators.required, Validators.maxLength(120)]],
    clienteTelefono: [''],
    envio: [0, [Validators.min(0)]],
    venceEn: [''],
    items: this.fb.array([this.lineaVacia()]),
  });

  protected get items(): FormArray {
    return this.form.controls.items;
  }

  constructor() {
    this.adminApi.loadInvoices();
  }

  private lineaVacia() {
    return this.fb.nonNullable.group({
      descripcion: ['', [Validators.required, Validators.maxLength(160)]],
      cantidad: [1, [Validators.required, Validators.min(1)]],
      precioUnitario: [0, [Validators.required, Validators.min(0)]],
    });
  }

  /**
   * El valor del formulario como señal.
   *
   * Hace falta el puente explícito: un `FormArray` no es reactivo para las
   * señales, así que un `computed` que leyera `items.controls` se calcularía
   * una sola vez y el total se quedaría clavado en cero mientras se escribe.
   * `toSignal` sobre `valueChanges` es lo que lo despierta.
   */
  private readonly valorForm = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });

  /**
   * El total tal como lo va a calcular el servidor.
   *
   * Es solo para verlo mientras se escribe: la cifra que se guarda la suma el
   * Worker. Si el servidor confiara en este número, mandar un total inventado
   * desde el navegador sería facturar lo que a uno le diera la gana.
   */
  protected readonly totalForm = computed(() => {
    const valor = this.valorForm();
    const lineas = (valor.items ?? []) as { cantidad?: number; precioUnitario?: number }[];
    const subtotal = lineas.reduce(
      (suma, linea) => suma + (linea.cantidad || 0) * (linea.precioUnitario || 0),
      0,
    );
    return subtotal + (valor.envio || 0);
  });

  protected agregarLinea(): void {
    this.items.push(this.lineaVacia());
  }

  protected quitarLinea(i: number): void {
    // Nunca por debajo de una: una factura sin líneas la rechaza el servidor,
    // y dejar el formulario en un estado que no se puede guardar es una trampa.
    if (this.items.length > 1) {
      this.items.removeAt(i);
    }
  }

  protected crear(): void {
    this.error.set(null);
    this.form.reset({ clienteNombre: '', clienteTelefono: '', envio: 0, venceEn: '' });
    this.items.clear();
    this.items.push(this.lineaVacia());
    this.editandoId.set('nueva');
  }

  protected editar(factura: ApiInvoice): void {
    this.error.set(null);

    // Las líneas no vienen en el listado: se piden al abrir, que es cuando se
    // necesitan. Traerlas con las 200 facturas sería cargar un documento
    // entero por fila para enseñar cuatro campos.
    this.adminApi.invoiceDetail(factura.id).subscribe({
      next: ({ invoice, items }) => {
        this.form.patchValue({
          clienteNombre: invoice.clienteNombre,
          clienteTelefono: invoice.clienteTelefono,
          envio: invoice.envio,
          venceEn: invoice.venceEn ? invoice.venceEn.slice(0, 10) : '',
        });

        this.items.clear();
        for (const item of items) {
          const linea = this.lineaVacia();
          linea.patchValue({
            descripcion: item.descripcion,
            cantidad: item.cantidad,
            precioUnitario: item.precioUnitario,
          });
          this.items.push(linea);
        }
        if (this.items.length === 0) {
          this.items.push(this.lineaVacia());
        }

        this.editandoId.set(invoice.id);
      },
      error: (fallo: ApiErrorBody) => this.error.set(fallo.message),
    });
  }

  protected cerrarFormulario(): void {
    this.editandoId.set(null);
    this.error.set(null);
  }

  protected guardar(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Revisa los campos marcados: falta algo por llenar.');
      return;
    }

    const valor = this.form.getRawValue();
    const entrada: ApiInvoiceInput = {
      clienteNombre: valor.clienteNombre,
      clienteTelefono: valor.clienteTelefono,
      envio: valor.envio,
      venceEn: valor.venceEn || null,
      items: valor.items.map((linea) => ({
        descripcion: linea.descripcion,
        cantidad: linea.cantidad,
        precioUnitario: linea.precioUnitario,
      })),
    };

    const id = this.editandoId();
    const peticion =
      id === 'nueva'
        ? this.adminApi.createInvoice(entrada)
        : this.adminApi.updateInvoice(id!, entrada);

    this.error.set(null);
    this.guardando.set(true);

    peticion.subscribe({
      next: () => {
        this.guardando.set(false);
        this.editandoId.set(null);
      },
      error: (fallo: ApiErrorBody) => {
        this.guardando.set(false);
        this.error.set(fallo.message);
      },
    });
  }

  // ─────────────────────────── Notas crédito y débito ───────────────────────────

  /** Factura a la que se le está emitiendo una nota. */
  protected readonly notandoId = signal<string | null>(null);

  protected readonly formNota = this.fb.nonNullable.group({
    tipo: ['nota_credito' as 'nota_credito' | 'nota_debito'],
    motivo: ['', [Validators.required, Validators.maxLength(200)]],
    descripcion: ['', [Validators.required, Validators.maxLength(160)]],
    monto: [0, [Validators.required, Validators.min(1)]],
  });

  /**
   * Solo se le emiten notas a una factura, nunca a otra nota.
   *
   * Encadenar correcciones de correcciones haría imposible reconstruir cuánto
   * se debe de verdad. El Worker lo rechaza igual; esto evita el botón.
   */
  protected sePuedeNotar(factura: ApiInvoice): boolean {
    return factura.tipo === 'factura' && factura.estado !== 'anulada';
  }

  protected esNota(factura: ApiInvoice): boolean {
    return factura.tipo !== 'factura';
  }

  protected etiquetaTipo(factura: ApiInvoice): string {
    if (factura.tipo === 'nota_credito') return 'Nota crédito';
    if (factura.tipo === 'nota_debito') return 'Nota débito';
    return 'Factura';
  }

  protected abrirNota(factura: ApiInvoice): void {
    this.error.set(null);
    this.formNota.reset({ tipo: 'nota_credito', motivo: '', descripcion: '', monto: 0 });
    this.notandoId.set(factura.id);
  }

  protected cerrarNota(): void {
    this.notandoId.set(null);
    this.error.set(null);
  }

  protected emitirNota(): void {
    const id = this.notandoId();
    if (!id) {
      return;
    }
    if (this.formNota.invalid) {
      this.formNota.markAllAsTouched();
      this.error.set('Falta el motivo, la descripción o el monto.');
      return;
    }

    const valor = this.formNota.getRawValue();
    this.error.set(null);
    this.guardando.set(true);

    this.adminApi
      .crearNota(id, {
        tipo: valor.tipo,
        motivo: valor.motivo,
        items: [
          { descripcion: valor.descripcion, cantidad: 1, precioUnitario: valor.monto },
        ],
      })
      .subscribe({
        next: () => {
          this.guardando.set(false);
          this.notandoId.set(null);
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

    this.adminApi.deleteInvoice(id).subscribe({
      next: () => {
        this.guardando.set(false);
        this.borrandoId.set(null);
      },
      error: (fallo: ApiErrorBody) => {
        this.guardando.set(false);
        this.borrandoId.set(null);
        this.error.set(fallo.message);
      },
    });
  }

  protected readonly visible = computed<readonly ApiInvoice[]>(() => {
    const termino = this.busqueda().trim().toLowerCase();
    const estado = this.estadoActivo();

    return this.adminApi.invoices().filter((factura) => {
      if (estado !== 'todos' && factura.estado !== estado) {
        return false;
      }
      if (!termino) {
        return true;
      }
      // También por número: quien llama por teléfono cita «la FAC-000123»
      // antes que su propio nombre.
      return (
        factura.clienteNombre.toLowerCase().includes(termino) ||
        factura.numero.toLowerCase().includes(termino) ||
        factura.clienteTelefono.includes(termino)
      );
    });
  });

  /** Cuántas hay en cada pestaña. */
  protected readonly porEstado = computed<Record<string, number>>(() => {
    const cuenta: Record<string, number> = {};
    for (const factura of this.adminApi.invoices()) {
      cuenta[factura.estado] = (cuenta[factura.estado] ?? 0) + 1;
    }
    return cuenta;
  });

  /** Lo que suman las que se están viendo, que con un filtro no es el total. */
  protected readonly saldoVisible = computed(() =>
    this.visible().reduce((suma, factura) => suma + factura.saldo, 0),
  );

  /**
   * `true` cuando la factura ya pasó su fecha de vencimiento y sigue debiendo.
   *
   * Se compara contra el reloj del navegador, a diferencia de la pantalla de
   * Cartera, donde la antigüedad la calcula el Worker. Aquí es solo un aviso
   * visual y no decide si se despacha nada, así que un día de diferencia entre
   * husos no cambia ninguna decisión.
   */
  protected vencida(factura: ApiInvoice): boolean {
    if (!factura.venceEn || factura.saldo === 0 || factura.estado === 'anulada') {
      return false;
    }
    return new Date(factura.venceEn) < new Date();
  }

  /**
   * Si esta factura todavía se puede anular.
   *
   * Una con dinero encima no: anularla daría la deuda por buena mientras el
   * abono sigue existiendo, y la caja reportaría plata sin venta detrás. Lo
   * que corresponde ahí es una nota crédito con su devolución. El Worker
   * rechaza igual la operación — esto solo evita ofrecer un botón que falla.
   */
  protected sePuedeAnular(factura: ApiInvoice): boolean {
    return factura.estado === 'emitida';
  }

  /**
   * Si todavía se puede editar o borrar.
   *
   * Misma regla que en el Worker: mientras no haya entrado dinero. Con un
   * abono encima, cambiarle el total dejaría ese cobro contra una cifra que
   * ya no existe, y borrarla dejaría la plata en la caja sin venta detrás.
   * Una anulada tampoco se toca: reescribirla borraría el rastro de que hubo
   * una corrección.
   */
  protected sePuedeModificar(factura: ApiInvoice): boolean {
    return factura.estado !== 'anulada' && factura.saldo === factura.total;
  }

  /**
   * Fecha legible.
   *
   * Hay que aceptar dos formatos: el ISO con `T` y `Z` que traen las filas
   * sembradas, y el `YYYY-MM-DD HH:MM:SS` que devuelve `datetime('now')` de
   * SQLite. El segundo lo parsean distinto los navegadores —algunos como hora
   * local, Safari directamente lo rechaza—, así que se normaliza a UTC antes
   * de construir la fecha en vez de confiar en `new Date(texto)`.
   */
  protected fecha(valor: string | null): string {
    if (!valor) {
      return '';
    }

    const iso = valor.includes('T') ? valor : `${valor.replace(' ', 'T')}Z`;
    const fecha = new Date(iso);

    if (Number.isNaN(fecha.getTime())) {
      // Antes que pintar «Invalid Date» en una pantalla de contabilidad,
      // enseñar el dato crudo: al menos se puede comparar con la base.
      return valor;
    }

    return fecha.toLocaleDateString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  protected etiquetaEstado(factura: ApiInvoice): string {
    return ESTADOS.find((e) => e.value === factura.estado)?.label ?? factura.estado;
  }

  protected seleccionarEstado(estado: Estado | 'todos'): void {
    this.estadoActivo.set(this.estadoActivo() === estado ? 'todos' : estado);
  }

  protected onBuscar(event: Event): void {
    this.busqueda.set((event.target as HTMLInputElement).value);
  }

  protected onMotivo(event: Event): void {
    this.motivo.set((event.target as HTMLInputElement).value);
  }

  protected preguntar(id: string): void {
    this.error.set(null);
    this.motivo.set('');
    this.anulandoId.set(id);
  }

  protected cancelar(): void {
    this.anulandoId.set(null);
    this.motivo.set('');
  }

  protected anular(id: string): void {
    const motivo = this.motivo().trim();
    if (!motivo) {
      // Se comprueba aquí además de en el Worker para no gastar un viaje: una
      // factura anulada sin explicación es un agujero que nadie puede auditar.
      this.error.set('Escribe por qué se anula: queda en el histórico.');
      return;
    }

    this.error.set(null);
    this.guardando.set(true);

    this.adminApi.anularInvoice(id, motivo).subscribe({
      next: () => {
        this.guardando.set(false);
        this.anulandoId.set(null);
        this.motivo.set('');
      },
      error: (error: ApiErrorBody) => {
        this.guardando.set(false);
        this.error.set(error.message);
      },
    });
  }
}
