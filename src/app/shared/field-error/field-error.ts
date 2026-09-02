import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  computed,
  effect,
  input,
  signal,
} from '@angular/core';
import { AbstractControl } from '@angular/forms';

/**
 * El mensaje de error de un campo de formulario — la parte que se repetía,
 * casi letra por letra, en una docena de pantallas.
 *
 * Antes de esto, cada formulario reinventaba tres cosas idénticas:
 *   1. Un método `showError(campo)` con la misma regla exacta:
 *      `control.invalid && (control.touched || control.dirty)`.
 *   2. Los dos atributos de accesibilidad escritos a mano en cada `<input>`:
 *      `[attr.aria-invalid]` y `[attr.aria-describedby]`.
 *   3. Un `id="error-x"` en el `<p>` del mensaje, repetido a mano dentro del
 *      `aria-describedby` de arriba — dos cadenas que tenían que coincidir
 *      letra por letra y que nada avisaba si un día dejaban de hacerlo.
 *
 * Lo que SIGUE viviendo en cada formulario, a propósito, es el TEXTO del
 * mensaje: cada campo de esta app explica qué corregir con sus propias
 * palabras («Escribe tu nombre, mínimo 3 letras», no «Campo requerido»), y
 * eso no se puede generar solo — un generador de mensajes por tipo de
 * validador aplanaría justo lo que hace útiles a estos mensajes.
 *
 * ── Por qué son DOS piezas y no una ──
 *
 * La primera idea —un único componente `<app-field-error>` leído desde el
 * `<input>` de al lado vía variable de plantilla— se probó y falló con
 * `NG0950`: Angular evalúa los bindings de una plantilla en el orden en que
 * aparecen, así que el `<input>` (que viene primero) no puede leer un input
 * `required` del componente de abajo (que se resuelve después) — el valor
 * simplemente no existe todavía en ese punto de la pasada.
 *
 * La solución es invertir la dirección: la directiva `[appFieldError]` vive
 * EN el propio `<input>`, así que su estado siempre está listo en el momento
 * en que ese mismo elemento lo necesita — no depende de nadie más. El
 * componente `<app-field-error>`, que va después, solo LEE esa directiva ya
 * resuelta a través de `[for]`. Como referencia hacia atrás (a algo que ya
 * terminó de procesarse), nunca choca con el orden de evaluación.
 *
 * Como beneficio extra, la directiva pone `aria-invalid`/`aria-describedby`
 * ella sola: ya no hace falta escribirlos a mano en cada `<input>`.
 *
 * ```html
 * <input
 *   formControlName="nombre"
 *   #errNombre="fieldError"
 *   [appFieldError]="form.controls.nombre"
 *   [class]="errNombre.visible() ? 'border-berry' : 'border-sand'"
 * />
 * <app-field-error [for]="errNombre" message="Escribe tu nombre (mínimo 3 letras)." />
 * ```
 */
@Directive({
  selector: '[appFieldError]',
  standalone: true,
  exportAs: 'fieldError',
  host: {
    '[attr.aria-invalid]': 'visible()',
    '[attr.aria-describedby]': 'visible() ? id : ayudaId()',
  },
})
export class FieldErrorState {
  private static contador = 0;

  /** Único por instancia y estable durante su vida: no se recalcula en cada render. */
  readonly id = `field-error-${FieldErrorState.contador++}`;

  readonly appFieldError = input.required<AbstractControl | null>();

  /**
   * El `id` de un texto de ayuda permanente, para cuando el campo tiene uno
   * además de su mensaje de error — el caso de la cédula en el checkout,
   * que explica para qué sirve el dato mientras no hay nada que corregir.
   *
   * Sin esto, `aria-describedby` tendría que elegirse a mano en la plantilla
   * cada vez que el error NO está visible, compitiendo por el mismo atributo
   * que esta misma directiva ya escribe — dos dueños del mismo atributo es
   * justo el tipo de cosa que Angular no deja resolver de forma predecible.
   */
  readonly ayudaId = input<string | null>(null);

  /**
   * Fuerza el mensaje visible aunque el control no esté `touched`/`dirty`.
   *
   * Existe para el caso de `payments-manager`: el formulario se abre con el
   * cliente ya elegido desde la lista de deudores (`cobrarA()`), así que ese
   * control nace `pristine` — nadie lo tocó, lo llenó el código. Sin esta vía
   * de escape, un intento de envío no podría marcar ese campo como inválido
   * hasta que el cajero, por casualidad, hiciera clic dentro y saliera de él.
   */
  readonly forzado = input(false);

  private readonly tick = signal(0);

  readonly visible = computed(() => {
    this.tick();
    const control = this.appFieldError();
    if (!control) {
      return false;
    }
    return control.invalid && (control.touched || control.dirty || this.forzado());
  });

  constructor() {
    // Ver la nota larga en `FieldError` sobre por qué hace falta suscribirse
    // a `control.events` en vez de confiar en `valueChanges`/`statusChanges`.
    effect((onCleanup) => {
      const control = this.appFieldError();
      if (!control) {
        return;
      }
      const suscripcion = control.events.subscribe(() => this.tick.update((n) => n + 1));
      onCleanup(() => suscripcion.unsubscribe());
    });
  }
}

@Component({
  selector: 'app-field-error',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (for().visible()) {
      <!--
        Sin role="alert" a propósito: esa marca es para interrupciones de
        página —el banner de "no se pudo guardar"—, no para un mensaje que ya
        se anuncia solo en cuanto el foco entra al campo, vía
        aria-describedby. Ponerlo aquí interrumpiría al lector de pantalla
        por cada campo que se invalida mientras se escribe, y además dejaría
        varias regiones "alert" compitiendo en la misma pantalla.
      -->
      <p [id]="for().id" class="mt-2 flex items-start gap-1.5 text-sm text-berry">
        <svg
          class="mt-0.5 size-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 9v4m0 4h.01" />
          <path
            d="M10.29 3.86 1.82 18a1.5 1.5 0 0 0 1.29 2.25h17.78A1.5 1.5 0 0 0 22.18 18L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z"
          />
        </svg>
        <span>{{ message() }}</span>
      </p>
    }
  `,
})
export class FieldError {
  /**
   * La directiva del `<input>` correspondiente, vía su variable de plantilla
   * (`#algo="fieldError"`). No es el `AbstractControl` directamente: la
   * directiva es la única que sabe el `id` correcto y si tocarlo cuenta como
   * "ya se intentó" — repetir esa lógica aquí sería la misma duplicación que
   * este componente existe para evitar.
   */
  readonly for = input.required<FieldErrorState>();
  readonly message = input.required<string>();
}
