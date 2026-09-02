import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { ApiMerma, MOTIVO_MERMA_LABELS, MotivoMerma } from '../../../core/api/api-client';

/**
 * El acta de baja de inventario, para imprimir y archivar.
 *
 * Es el soporte contable de la pérdida: lleva lo que exige una auditoría —qué
 * salió, cuánto, por qué, quién lo autorizó y cuándo— y las dos líneas de firma
 * que se rellenan a mano. Esas firmas van en el papel y no en la base de datos
 * a propósito: el sistema ya guarda quién registró el acta con su usuario y su
 * hora, que es la traza que de verdad no se puede falsificar; la firma física
 * es la que pide el archivador.
 *
 * El CSS de impresión vive aquí, igual que en `pos-receipt`: una regla
 * `@media print` que reordena la página entera es demasiado agresiva para un
 * fichero compartido.
 */
@Component({
  selector: 'app-merma-acta',
  standalone: true,
  imports: [CopPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './merma-acta.css',
  template: `
    <div class="acta rounded-xl border border-sand bg-white p-6 text-ink">
      <header class="border-b border-sand pb-3">
        <p class="text-base font-semibold">Agricultores Orgánicos</p>
        <p class="font-serif text-lg">Acta de baja de inventario</p>
        <p class="mt-1 text-xs text-ink/60">
          Salida por merma · Documento interno de control de inventario
        </p>
      </header>

      <dl class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div>
          <dt class="text-ink/50">Acta n.º</dt>
          <dd class="font-medium">{{ merma().id.slice(0, 8).toUpperCase() }}</dd>
        </div>
        <div>
          <dt class="text-ink/50">Fecha y hora</dt>
          <dd class="font-medium">{{ merma().creadoEn }}</dd>
        </div>
        <div>
          <dt class="text-ink/50">Responsable</dt>
          <dd class="font-medium">{{ merma().creadoPor ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-ink/50">Pérdida al costo</dt>
          <dd class="font-medium">{{ merma().totalCosto | cop }}</dd>
        </div>
      </dl>

      <!--
        Separación horizontal en cada celda, no solo vertical: sin ella la
        cantidad y el motivo se leen pegados ("2 kgDeshidratación"), que en un
        documento que se archiva es justo lo que no puede pasar.

        (Ojo: este comentario vive dentro de un template literal de
        JavaScript. Un acento grave aquí cierra la cadena y rompe el
        componente entero — pasó al escribirlo.)
      -->
      <table class="mt-4 w-full text-left text-xs">
        <thead class="border-b border-sand text-ink/50">
          <tr>
            <th class="pb-1 pr-2 font-medium">Producto</th>
            <th class="px-2 pb-1 text-right font-medium">Cant.</th>
            <th class="px-2 pb-1 font-medium">Motivo</th>
            <th class="pb-1 pl-2 text-right font-medium">Costo</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-sand/60">
          @for (item of merma().items; track item.productId) {
            <tr>
              <td class="py-1.5 pr-2">
                {{ item.productoNombre }}
                @if (item.observacion) {
                  <span class="block text-[10px] text-ink/50">{{ item.observacion }}</span>
                }
              </td>
              <td class="tabular whitespace-nowrap px-2 py-1.5 text-right">
                {{ item.cantidad }} {{ item.unidad }}
              </td>
              <td class="px-2 py-1.5">{{ etiqueta(item.motivo) }}</td>
              <td class="tabular whitespace-nowrap py-1.5 pl-2 text-right">
                {{ item.subtotalCosto | cop }}
              </td>
            </tr>
          }
        </tbody>
        <tfoot class="border-t border-sand font-semibold">
          <tr>
            <td class="pr-2 pt-2" colspan="3">Total dado de baja (al costo)</td>
            <td class="tabular whitespace-nowrap pl-2 pt-2 text-right">
              {{ merma().totalCosto | cop }}
            </td>
          </tr>
          <tr class="text-ink/60">
            <td colspan="3" class="pr-2 font-normal">Valor de venta que se deja de facturar</td>
            <td class="tabular whitespace-nowrap pl-2 text-right font-normal">
              {{ merma().totalVenta | cop }}
            </td>
          </tr>
        </tfoot>
      </table>

      @if (merma().observaciones; as nota) {
        <div class="mt-4 border-t border-sand pt-3 text-xs">
          <p class="text-ink/50">Observaciones</p>
          <p class="mt-1">{{ nota }}</p>
        </div>
      }

      <!--
        Las firmas: dos rayas y dos rótulos. Es lo único del acta que no sale
        del sistema, porque es justamente lo que el sistema no puede dar — el
        gesto de alguien haciéndose responsable en papel.
      -->
      <div class="mt-10 grid grid-cols-2 gap-8 text-xs">
        <div>
          <div class="border-t border-ink/40 pt-1">Responsable de la baja</div>
          <p class="text-ink/50">{{ merma().creadoPor ?? '' }}</p>
        </div>
        <div>
          <div class="border-t border-ink/40 pt-1">Supervisor / administrador</div>
          <p class="text-ink/50">Nombre y firma</p>
        </div>
      </div>
    </div>
  `,
})
export class MermaActa {
  readonly merma = input.required<ApiMerma>();

  protected etiqueta(motivo: MotivoMerma): string {
    return MOTIVO_MERMA_LABELS[motivo];
  }
}
