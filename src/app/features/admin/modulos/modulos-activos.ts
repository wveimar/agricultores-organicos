import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ModulosStore } from '../../../core/api/modulos-store';
import { ApiErrorBody } from '../../../core/api/api-client';

/** Un módulo tal como lo pinta esta pantalla, con su nombre legible y su descripción. */
interface FilaModulo {
  readonly clave: 'modulo_pos' | 'modulo_ecommerce' | 'modulo_entregas' | 'modulo_tesoreria';
  readonly nombre: string;
}

/**
 * «Módulos activos» — el interruptor central del negocio.
 *
 * Apagar uno de estos cuatro no borra nada: los pedidos, facturas y
 * movimientos que ya existen se quedan exactamente donde están. Lo único que
 * cambia es qué aparece en el menú y qué le exige el sistema a un pedido
 * NUEVO — el mismo principio que ya sigue el resto del proyecto de nunca
 * confundir "apagado" con "borrado".
 */
@Component({
  selector: 'app-modulos-activos',
  standalone: true,
  templateUrl: './modulos-activos.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModulosActivosScreen {
  protected readonly admin = inject(AdminApiService);
  private readonly modulosStore = inject(ModulosStore);

  protected readonly filas: readonly FilaModulo[] = [
    { clave: 'modulo_pos', nombre: 'POS (Caja)' },
    { clave: 'modulo_ecommerce', nombre: 'E-commerce (tienda pública)' },
    { clave: 'modulo_entregas', nombre: 'Entregas (domicilios)' },
    { clave: 'modulo_tesoreria', nombre: 'Tesorería (caja, movimientos, cierre)' },
  ];

  protected readonly cambiando = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.admin.loadAjustes();
  }

  protected activo(clave: FilaModulo['clave']): boolean {
    return this.admin.ajustes().find((a) => a.clave === clave)?.valor !== '0';
  }

  protected descripcion(clave: FilaModulo['clave']): string {
    return this.admin.ajustes().find((a) => a.clave === clave)?.descripcion ?? '';
  }

  /**
   * El último canal de venta encendido no se deja apagar desde aquí — el
   * Worker lo rechazaría igual, pero deshabilitar el interruptor evita el
   * viaje de ida y vuelta para enterarse.
   */
  protected readonly ultimoCanalDeVenta = computed(() => {
    const pos = this.activo('modulo_pos');
    const ecommerce = this.activo('modulo_ecommerce');
    if (pos && !ecommerce) return 'modulo_pos';
    if (ecommerce && !pos) return 'modulo_ecommerce';
    return null;
  });

  protected bloqueado(clave: FilaModulo['clave']): boolean {
    return this.ultimoCanalDeVenta() === clave;
  }

  protected alternar(clave: FilaModulo['clave']): void {
    if (this.bloqueado(clave) || this.cambiando()) return;

    const nuevoValor = this.activo(clave) ? '0' : '1';
    this.cambiando.set(clave);
    this.error.set(null);

    this.admin.updateSetting(clave, nuevoValor).subscribe({
      next: () => {
        this.cambiando.set(null);
        // `admin.updateSetting()` ya actualizó `ajustes()` antes de llegar
        // aquí, así que `activo()` ya lee el valor nuevo para los cuatro.
        //
        // La pantalla que se está viendo ahora mismo también obedece al
        // interruptor: sin este `set()`, apagar POS aquí no le quitaría
        // "Caja" al menú hasta refrescar la página.
        this.modulosStore.set({
          pos: this.activo('modulo_pos'),
          ecommerce: this.activo('modulo_ecommerce'),
          entregas: this.activo('modulo_entregas'),
          tesoreria: this.activo('modulo_tesoreria'),
        });
      },
      error: (err: ApiErrorBody) => {
        this.cambiando.set(null);
        this.error.set(err.message);
      },
    });
  }
}
