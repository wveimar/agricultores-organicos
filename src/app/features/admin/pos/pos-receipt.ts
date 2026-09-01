import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { ApiPosVenta } from '../../../core/api/api-client';

/**
 * El recibo de una venta de mostrador.
 *
 * Sirve para las dos cosas que pidió el negocio: el recibo del momento y la
 * reimpresión de cualquier venta vieja, porque las dos parten del mismo dato
 * —la venta con sus líneas y su factura— y no habría razón para maquetarlas
 * dos veces.
 *
 * El CSS de impresión vive aquí y no en los estilos globales: `@media print`
 * esconde TODO menos este bloque, y una regla así de agresiva en un fichero
 * compartido acabaría afectando a pantallas que no tienen nada que ver.
 */
@Component({
  selector: 'app-pos-receipt',
  standalone: true,
  imports: [CopPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './pos-receipt.css',
  template: `
    <div class="recibo rounded-xl border border-sand bg-white p-5 text-ink">
      <header class="border-b border-dashed border-sand pb-3 text-center">
        <p class="text-base font-semibold">Agricultores Orgánicos</p>
        <p class="text-xs text-ink/60">Venta de mostrador</p>
      </header>

      <dl class="mt-3 space-y-1 text-xs">
        <div class="flex justify-between">
          <dt class="text-ink/60">Pedido</dt>
          <dd class="font-medium">{{ venta().referencia }}</dd>
        </div>
        @if (venta().factura; as factura) {
          <div class="flex justify-between">
            <dt class="text-ink/60">Factura</dt>
            <dd class="font-medium">{{ factura.numero }}</dd>
          </div>
        }
        <div class="flex justify-between">
          <dt class="text-ink/60">Cliente</dt>
          <dd class="font-medium">{{ venta().clienteNombre }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-ink/60">Fecha</dt>
          <dd>{{ venta().creadoEn }}</dd>
        </div>
      </dl>

      <table class="mt-4 w-full text-xs">
        <thead>
          <tr class="border-b border-sand text-left text-ink/60">
            <th class="pb-1 font-medium">Producto</th>
            <th class="pb-1 text-right font-medium">Cant.</th>
            <th class="pb-1 text-right font-medium">Valor</th>
          </tr>
        </thead>
        <tbody>
          @for (item of venta().items; track item.productId) {
            <tr class="border-b border-sand/50 last:border-0">
              <td class="py-1.5">
                {{ item.productoNombre }}
                @if (item.motivoAjuste) {
                  <span class="block text-[10px] text-ink/50">
                    Precio ajustado: {{ item.motivoAjuste }}
                  </span>
                }
              </td>
              <td class="py-1.5 text-right">{{ item.cantidad }}</td>
              <td class="py-1.5 text-right">
                {{ item.precioUnitario * item.cantidad | cop }}
              </td>
            </tr>
          }
        </tbody>
      </table>

      <div class="mt-3 border-t border-dashed border-sand pt-3 text-sm">
        <div class="flex justify-between font-semibold">
          <span>Total</span>
          <span>{{ venta().total | cop }}</span>
        </div>
        <p class="mt-1 text-xs text-ink/60">
          @switch (venta().medioPago) {
            @case ('efectivo') {
              Pagado en efectivo
            }
            @case ('tarjeta') {
              Pagado con tarjeta
            }
            @default {
              @if (venta().metodoPago === 'credito') {
                A crédito · vence el {{ venta().venceEn }}
              } @else {
                Pagado
              }
            }
          }
        </p>
        @if (venta().factura; as factura) {
          @if (factura.saldo > 0) {
            <p class="mt-1 text-xs font-medium text-clay">
              Queda debiendo {{ factura.saldo | cop }}
            </p>
          }
        }
      </div>

      <p class="mt-4 text-center text-[10px] text-ink/50">
        Gracias por comprarle directo al campo.
      </p>
    </div>
  `,
})
export class PosReceipt {
  readonly venta = input.required<ApiPosVenta>();
}
