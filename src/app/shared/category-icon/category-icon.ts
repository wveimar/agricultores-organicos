import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Silueta del chip de una categoría.
 *
 * Son SVG monocromos, no emojis, por tres razones concretas:
 *
 * - **Se tiñen.** Todo dibuja con `currentColor`, así que el ícono se vuelve
 *   hueso cuando el chip está activo y tinta cuando no, sin una sola línea de
 *   lógica. Un emoji trae su propio color y pelearía con la paleta —
 *   `doc/plan.md §1`: «un solo acento», «el color lo pone la comida, no la
 *   interfaz».
 * - **Se ven igual en todas partes.** 🥬 lo dibuja Apple de una manera,
 *   Google de otra y Windows de otra; el aspecto de la barra no sería nuestro.
 * - **No se leen en voz alta.** Un emoji dentro del botón hace que el lector
 *   de pantalla anuncie «hoja verde Verduras y raíces». Aquí el `<svg>` va
 *   `aria-hidden` y solo se lee el nombre.
 *
 * El repertorio es código porque son siluetas dibujadas a mano y finitas.
 * **Qué categoría lleva cuál es un dato**, la columna `icono` de la tabla
 * `categories` (migración 0016), elegible desde el panel — si esto fuera un
 * mapa `id → ícono`, cada categoría nueva nacería sin ícono para siempre, que
 * es el fallo que la 0013 vino a cerrar con `grupo_admin`.
 *
 * Una clave desconocida —o vacía— cae en la hoja. Es el motivo de la tienda y
 * nunca desentona, así que una categoría a la que nadie le eligió ícono no se
 * ve rota, solo genérica.
 */
export const CATEGORY_ICONS = [
  { value: 'hoja', label: 'Hoja' },
  { value: 'brote', label: 'Brote' },
  { value: 'fruta', label: 'Fruta' },
  { value: 'espiga', label: 'Espiga' },
  { value: 'panal', label: 'Panal' },
  { value: 'botella', label: 'Botella' },
  { value: 'frasco', label: 'Frasco' },
  { value: 'pan', label: 'Pan' },
  { value: 'plato', label: 'Plato servido' },
  { value: 'canasta', label: 'Canasta' },
  { value: 'bolsa', label: 'Bolsa' },
] as const;

export type CategoryIconName = (typeof CATEGORY_ICONS)[number]['value'];

const NOMBRES: readonly string[] = CATEGORY_ICONS.map((i) => i.value);

@Component({
  selector: 'app-category-icon',
  templateUrl: './category-icon.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryIcon {
  /** Clave de la silueta. Vacía o desconocida cae en `hoja`. */
  readonly name = input<string>('');

  /** Clases del `<svg>`. Quien lo usa decide el tamaño: `size-4`, `size-5`… */
  readonly svgClass = input<string>('size-4');

  /**
   * La clave que de verdad se pinta.
   *
   * El `@switch` de la plantilla ya tiene `@default`, así que normalizar aquí
   * es redundante para dibujar — pero no para el panel, que compara contra
   * esto para saber si la elección guardada sigue existiendo.
   */
  protected readonly resolved = computed<string>(() =>
    NOMBRES.includes(this.name()) ? this.name() : 'hoja',
  );
}
