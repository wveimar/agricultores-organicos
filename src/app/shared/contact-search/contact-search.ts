import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ApiClient, ApiContactMatch } from '../../core/api/api-client';
import { CopPipe } from '../pipes/cop.pipe';

/**
 * Buscador de cliente — una sola caja que resuelve cédula, nombre y teléfono.
 *
 * ── Por qué es un componente compartido ──
 *
 * La misma pregunta —«¿quién es este cliente?»— aparece en la caja, en Cobros,
 * en Cartera y al facturar a mano. Cada pantalla se lo estaba resolviendo por
 * su cuenta, filtrando en el navegador la agenda entera. Eso funcionaba con
 * treinta fichas y deja de funcionar con tres mil, y además cada copia buscaba
 * por campos ligeramente distintos: en una encontrabas por documento y en otra
 * no. Un solo componente contra un solo endpoint es lo que hace que buscar
 * signifique lo mismo en todas partes.
 *
 * ── Por qué el rebote (debounce) es de 250 ms ──
 *
 * Es el tiempo que separa "el cajero sigue tecleando" de "el cajero espera una
 * respuesta". Más corto dispara una consulta por letra; más largo se siente
 * lento con un cliente enfrente. El servidor además ignora las búsquedas de
 * menos de dos caracteres, así que las primeras teclas no llegan a viajar.
 */
@Component({
  selector: 'app-contact-search',
  standalone: true,
  imports: [CopPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative">
      <label [for]="inputId()" class="mb-1 block text-sm font-medium text-ink">
        {{ etiqueta() }}
      </label>

      <input
        [id]="inputId()"
        type="text"
        autocomplete="off"
        [value]="termino()"
        (input)="onInput($any($event.target).value)"
        (keydown.escape)="limpiar()"
        [placeholder]="placeholder()"
        class="block w-full rounded-lg border border-sand px-4 py-3 text-base text-ink focus:border-moss focus:outline-none focus:ring-2 focus:ring-moss/20"
      />

      @if (buscando()) {
        <p class="mt-1 text-xs text-ink/50">Buscando…</p>
      }

      @if (error(); as mensaje) {
        <p class="mt-1 text-xs text-clay" role="alert">{{ mensaje }}</p>
      }

      @if (resultados().length > 0) {
        <ul
          class="absolute z-20 mt-1 max-h-80 w-full divide-y divide-sand overflow-y-auto rounded-xl border border-sand bg-white shadow-lg"
          role="listbox"
        >
          @for (contacto of resultados(); track contacto.id) {
            <li>
              <button
                type="button"
                role="option"
                (click)="elegir(contacto)"
                class="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition hover:bg-cream"
              >
                <span class="min-w-0">
                  <span class="block truncate text-sm font-medium text-ink">
                    {{ contacto.nombre }}
                  </span>
                  <span class="block text-xs text-ink/60">
                    CC {{ contacto.documento }}
                    @if (contacto.telefono) {
                      · {{ contacto.telefono }}
                    }
                  </span>
                </span>

                <span class="shrink-0 text-right text-xs">
                  @if (contacto.nivelPrecio) {
                    <span class="block font-medium text-moss">
                      {{ nivelCorto(contacto.nivelPrecio) }}
                    </span>
                  }
                  @if (contacto.deuda > 0) {
                    <span class="block text-clay">Debe {{ contacto.deuda | cop }}</span>
                  } @else if (contacto.cupoCredito > 0) {
                    <span class="block text-ink/50">Cupo {{ contacto.cupoCredito | cop }}</span>
                  }
                </span>
              </button>
            </li>
          }
        </ul>
      } @else if (sinResultados()) {
        <p class="mt-1 text-sm text-ink/60">
          Nadie coincide con «{{ termino() }}».
        </p>
      }
    </div>
  `,
})
export class ContactSearch {
  private readonly api = inject(ApiClient);

  readonly etiqueta = input('Cliente');
  readonly placeholder = input('Cédula, nombre o teléfono…');
  readonly inputId = input('contact-search');

  /** El contacto elegido. Quien usa el componente decide qué hacer con él. */
  readonly seleccionado = output<ApiContactMatch>();

  protected readonly termino = signal('');
  protected readonly resultados = signal<readonly ApiContactMatch[]>([]);
  protected readonly buscando = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Solo tras una búsqueda que de verdad volvió vacía, no mientras se teclea. */
  protected readonly sinResultados = signal(false);

  /**
   * El término con rebote. Se separa del que pinta el input para que la caja
   * responda a cada tecla sin que cada tecla dispare una consulta.
   */
  private readonly terminoRebotado = signal('');
  private temporizador: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect((onCleanup) => {
      const query = this.terminoRebotado().trim();

      if (query.length < 2) {
        this.resultados.set([]);
        this.sinResultados.set(false);
        return;
      }

      this.buscando.set(true);
      this.error.set(null);

      const sub = this.api.searchContacts(query).subscribe({
        next: (lista) => {
          this.resultados.set(lista);
          this.sinResultados.set(lista.length === 0);
          this.buscando.set(false);
        },
        error: () => {
          // Si la búsqueda falla, el cajero tiene que poder seguir vendiendo:
          // se avisa y se deja la caja usable en vez de bloquear la pantalla.
          this.error.set('No se pudo buscar. Revisa la conexión.');
          this.resultados.set([]);
          this.buscando.set(false);
        },
      });

      // Una búsqueda vieja que llegue tarde no puede pisar a una más nueva.
      onCleanup(() => sub.unsubscribe());
    });
  }

  protected onInput(valor: string): void {
    this.termino.set(valor);
    this.sinResultados.set(false);

    if (this.temporizador !== null) {
      clearTimeout(this.temporizador);
    }
    this.temporizador = setTimeout(() => this.terminoRebotado.set(valor), 250);
  }

  protected elegir(contacto: ApiContactMatch): void {
    this.seleccionado.emit(contacto);
    this.limpiar();
  }

  /** Deja el buscador listo para la siguiente consulta. */
  limpiar(): void {
    this.termino.set('');
    this.terminoRebotado.set('');
    this.resultados.set([]);
    this.sinResultados.set(false);
  }

  /** 'MAYORISTA_N2' → 'Mayorista N2'. La base guarda el rol, la pantalla lo lee. */
  protected nivelCorto(rol: string): string {
    return rol.replace('MAYORISTA_N', 'Mayorista N');
  }
}
