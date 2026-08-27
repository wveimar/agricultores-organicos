import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { AccountType, ApiContact, ApiErrorBody } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';

/** Los del CHECK de la tabla, con etiqueta para el desplegable. */
const TIPOS_CUENTA: ReadonlyArray<{ value: AccountType; label: string }> = [
  { value: 'ahorros', label: 'Ahorros' },
  { value: 'corriente', label: 'Corriente' },
  { value: 'nequi', label: 'Nequi' },
  { value: 'daviplata', label: 'Daviplata' },
];

type Vista = 'todos' | 'proveedor' | 'cliente';

/**
 * La agenda: proveedores y clientes en una sola lista.
 *
 * Una sola tabla y una sola pantalla porque son la misma clase de cosa, y
 * porque la misma persona puede ser las dos: a una vereda se le compra lechuga
 * y esa misma vereda compra huevos. Las pestañas de arriba son un filtro sobre
 * la misma lista, no tres listas distintas — así, alguien que es ambas aparece
 * en las tres.
 *
 * Los clientes no se crean a mano en el caso normal: el checkout los va
 * fichando por teléfono a medida que compran (ver `encontrarOCrearCliente()`
 * en el Worker). Esta pantalla es para completar sus datos, corregir un nombre
 * mal escrito y llevar la agenda de proveedores, que sí se teclea.
 */
@Component({
  selector: 'app-contacts-manager',
  imports: [CopPipe],
  templateUrl: './contacts-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactsManager {
  protected readonly adminApi = inject(AdminApiService);
  protected readonly tiposCuenta = TIPOS_CUENTA;

  // ── Lista ──
  protected readonly vista = signal<Vista>('todos');
  protected readonly busqueda = signal('');
  protected readonly verInactivos = signal(false);

  // ── Formulario ──
  protected readonly abierto = signal(false);
  /** Con valor = editamos esa ficha. `null` con `abierto` = ficha nueva. */
  protected readonly editandoId = signal<string | null>(null);

  protected readonly nombre = signal('');
  protected readonly esProveedor = signal(false);
  protected readonly esCliente = signal(false);
  protected readonly telefono = signal('');
  protected readonly direccion = signal('');
  protected readonly notas = signal('');
  protected readonly banco = signal('');
  protected readonly tipoCuenta = signal<AccountType | ''>('');
  protected readonly numeroCuenta = signal('');
  protected readonly titular = signal('');
  protected readonly documento = signal('');
  protected readonly activo = signal(true);

  protected readonly guardando = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly ocupadoId = signal<string | null>(null);
  protected readonly confirmandoBorrado = signal<string | null>(null);
  protected readonly expandido = signal<string | null>(null);

  constructor() {
    this.adminApi.loadContacts();
  }

  // ─────────────────────────── Lista ───────────────────────────

  protected readonly visibles = computed<readonly ApiContact[]>(() => {
    const vista = this.vista();
    const termino = this.busqueda().trim().toLowerCase();
    const inactivos = this.verInactivos();

    return this.adminApi.contacts().filter((c) => {
      if (!inactivos && c.activo === 0) {
        return false;
      }
      if (vista === 'proveedor' && c.esProveedor !== 1) {
        return false;
      }
      if (vista === 'cliente' && c.esCliente !== 1) {
        return false;
      }
      if (!termino) {
        return true;
      }
      return (
        c.nombre.toLowerCase().includes(termino) ||
        (c.telefono ?? '').includes(termino) ||
        (c.direccion ?? '').toLowerCase().includes(termino)
      );
    });
  });

  /** Los contadores de las pestañas, sobre la agenda entera. */
  protected readonly conteos = computed(() => {
    const lista = this.adminApi.contacts().filter((c) => this.verInactivos() || c.activo === 1);
    return {
      todos: lista.length,
      proveedor: lista.filter((c) => c.esProveedor === 1).length,
      cliente: lista.filter((c) => c.esCliente === 1).length,
      ambos: lista.filter((c) => c.esProveedor === 1 && c.esCliente === 1).length,
    };
  });

  /** Lo que se le debe a los proveedores, sumado sobre lo que se ve. */
  protected readonly porPagarTotal = computed(() =>
    this.visibles().reduce((suma, c) => suma + (c.porPagar ?? 0), 0),
  );

  protected cambiarVista(vista: Vista): void {
    this.vista.set(vista);
  }

  protected onBusqueda(event: Event): void {
    this.busqueda.set((event.target as HTMLInputElement).value);
  }

  protected alternarInactivos(): void {
    this.verInactivos.update((v) => !v);
  }

  protected alternar(contacto: ApiContact): void {
    this.expandido.set(this.expandido() === contacto.id ? null : contacto.id);
  }

  /** ¿Tiene con qué girarle? Si no, la ficha está a medias. */
  protected tieneCuenta(contacto: ApiContact): boolean {
    return !!(contacto.banco && contacto.numeroCuenta);
  }

  // ─────────────────────────── Formulario ───────────────────────────

  protected nuevo(comoProveedor: boolean): void {
    this.editandoId.set(null);
    this.nombre.set('');
    // Se preselecciona según desde dónde se abrió: en la pestaña de
    // proveedores lo normal es dar de alta un proveedor.
    this.esProveedor.set(comoProveedor);
    this.esCliente.set(!comoProveedor);
    this.telefono.set('');
    this.direccion.set('');
    this.notas.set('');
    this.banco.set('');
    this.tipoCuenta.set('');
    this.numeroCuenta.set('');
    this.titular.set('');
    this.documento.set('');
    this.activo.set(true);
    this.formError.set(null);
    this.feedback.set(null);
    this.abierto.set(true);
  }

  protected editar(contacto: ApiContact): void {
    this.editandoId.set(contacto.id);
    this.nombre.set(contacto.nombre);
    this.esProveedor.set(contacto.esProveedor === 1);
    this.esCliente.set(contacto.esCliente === 1);
    this.telefono.set(contacto.telefono ?? '');
    this.direccion.set(contacto.direccion ?? '');
    this.notas.set(contacto.notas ?? '');
    this.banco.set(contacto.banco ?? '');
    this.tipoCuenta.set(contacto.tipoCuenta ?? '');
    this.numeroCuenta.set(contacto.numeroCuenta ?? '');
    this.titular.set(contacto.titular ?? '');
    this.documento.set(contacto.documento ?? '');
    this.activo.set(contacto.activo === 1);
    this.formError.set(null);
    this.feedback.set(null);
    this.abierto.set(true);
  }

  protected cerrar(): void {
    this.abierto.set(false);
    this.editandoId.set(null);
    this.formError.set(null);
  }

  protected onTexto(destino: 'nombre' | 'telefono' | 'direccion' | 'banco' | 'numeroCuenta' | 'titular' | 'documento', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this[destino].set(value);
  }

  protected onNotas(event: Event): void {
    this.notas.set((event.target as HTMLTextAreaElement).value);
  }

  protected onTipoCuenta(event: Event): void {
    this.tipoCuenta.set((event.target as HTMLSelectElement).value as AccountType | '');
  }

  /**
   * Al menos una bandera: un contacto que no es ni proveedor ni cliente no
   * tendría pantalla donde aparecer. El servidor lo rechaza igual.
   */
  protected readonly puedeGuardar = computed(
    () => this.nombre().trim().length > 0 && (this.esProveedor() || this.esCliente()),
  );

  protected guardar(): void {
    if (!this.puedeGuardar() || this.guardando()) {
      return;
    }

    this.guardando.set(true);
    this.formError.set(null);

    const payload = {
      nombre: this.nombre().trim(),
      esProveedor: this.esProveedor(),
      esCliente: this.esCliente(),
      telefono: this.telefono().trim() || null,
      direccion: this.direccion().trim() || null,
      notas: this.notas().trim() || null,
      banco: this.banco().trim() || null,
      tipoCuenta: this.tipoCuenta() || null,
      numeroCuenta: this.numeroCuenta().trim() || null,
      titular: this.titular().trim() || null,
      documento: this.documento().trim() || null,
      activo: this.activo(),
    };

    const id = this.editandoId();
    const peticion = id
      ? this.adminApi.updateContact(id, payload)
      : this.adminApi.createContact(payload);

    peticion.subscribe({
      next: (contacto) => {
        this.guardando.set(false);
        this.abierto.set(false);
        this.editandoId.set(null);
        this.feedback.set(`${contacto.nombre} ${id ? 'actualizado' : 'agregado a la agenda'}.`);
      },
      error: (error: ApiErrorBody) => {
        this.guardando.set(false);
        // El caso frecuente es `telefono-repetido`, cuyo mensaje ya dice de
        // quién es el número y qué hacer: se muestra tal cual.
        this.formError.set(error.message);
      },
    });
  }

  /** Desactivar es la vía normal de "quitar": conserva el historial. */
  protected alternarActivo(contacto: ApiContact): void {
    this.ocupadoId.set(contacto.id);
    this.formError.set(null);

    this.adminApi
      .updateContact(contacto.id, {
        nombre: contacto.nombre,
        esProveedor: contacto.esProveedor === 1,
        esCliente: contacto.esCliente === 1,
        telefono: contacto.telefono,
        direccion: contacto.direccion,
        notas: contacto.notas,
        banco: contacto.banco,
        tipoCuenta: contacto.tipoCuenta,
        numeroCuenta: contacto.numeroCuenta,
        titular: contacto.titular,
        documento: contacto.documento,
        activo: contacto.activo !== 1,
      })
      .subscribe({
        next: (actualizado) => {
          this.ocupadoId.set(null);
          this.feedback.set(
            `${actualizado.nombre} ${actualizado.activo === 1 ? 'reactivado' : 'desactivado'}.`,
          );
        },
        error: (error: ApiErrorBody) => {
          this.ocupadoId.set(null);
          this.formError.set(error.message);
        },
      });
  }

  protected pedirBorrado(contacto: ApiContact): void {
    this.confirmandoBorrado.set(contacto.id);
    this.formError.set(null);
  }

  protected cancelarBorrado(): void {
    this.confirmandoBorrado.set(null);
  }

  protected borrar(contacto: ApiContact): void {
    this.ocupadoId.set(contacto.id);
    this.formError.set(null);

    this.adminApi.deleteContact(contacto.id).subscribe({
      next: () => {
        this.ocupadoId.set(null);
        this.confirmandoBorrado.set(null);
        this.feedback.set(`${contacto.nombre} eliminado de la agenda.`);
      },
      error: (error: ApiErrorBody) => {
        this.ocupadoId.set(null);
        this.confirmandoBorrado.set(null);
        // Con historial detrás el servidor responde `contacto-con-historial` y
        // el mensaje ya sugiere desactivar en vez de borrar.
        this.formError.set(error.message);
      },
    });
  }

  protected formatDate(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    return new Date(iso).toLocaleDateString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
}
