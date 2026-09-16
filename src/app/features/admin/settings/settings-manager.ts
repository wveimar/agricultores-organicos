import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { ApiAjuste, ApiErrorBody } from '../../../core/api/api-client';

/** Una etiqueta corta para cada clave — `descripcion` ya explica el detalle debajo. */
const ETIQUETAS: Record<string, string> = {
  site_nombre: 'Nombre del panel',
  site_tagline: 'Frase corta (tagline) del panel',
  site_meta_descripcion: 'Descripción para buscadores (panel)',
  site_footer_descripcion: 'Descripción del pie de página (panel)',
  contacto_whatsapp: 'WhatsApp',
  banco_nombre: 'Banco',
  banco_tipo_cuenta: 'Tipo de cuenta',
  banco_numero_cuenta: 'Número de cuenta',
  banco_titular: 'Titular de la cuenta',
  banco_titular_documento: 'Documento del titular',
  site_nombre_mercado: 'Nombre de la vitrina',
  site_tagline_mercado: 'Frase corta (tagline)',
  site_meta_descripcion_mercado: 'Descripción para buscadores',
  site_footer_descripcion_mercado: 'Descripción del pie de página',
  site_nombre_turismo: 'Nombre de la vitrina',
  site_tagline_turismo: 'Frase corta (tagline)',
  site_meta_descripcion_turismo: 'Descripción para buscadores',
  site_footer_descripcion_turismo: 'Descripción del pie de página',
  modulo_pos: 'Punto de venta (Caja)',
  modulo_mermas: 'Mermas',
  modulo_compras_proveedores: 'Compras a proveedores',
  modulo_mayoristas: 'Mayoristas',
  modulo_domicilios: 'Domicilios',
  modulo_venta_por_peso: 'Venta a granel (por peso)',
  pos_recibo_por_defecto: 'Recibo por defecto en caja',
};

/** El orden en que se pintan dentro de cada sección — no el orden alfabético de las claves. */
const SECCIONES: readonly { titulo: string; ayuda: string; claves: readonly string[] }[] = [
  {
    titulo: 'Marca del panel',
    ayuda:
      'El nombre y los datos que ve solo quien entra a este panel: el login, el menú del admin y los recibos. La tienda pública NO usa esto — cada vitrina tiene su propia marca, más abajo.',
    claves: [
      'site_nombre',
      'site_tagline',
      'site_meta_descripcion',
      'site_footer_descripcion',
      'contacto_whatsapp',
      'banco_nombre',
      'banco_tipo_cuenta',
      'banco_numero_cuenta',
      'banco_titular',
      'banco_titular_documento',
    ],
  },
  {
    titulo: 'Marca de Mercado (/mercado)',
    ayuda: 'El nombre y las descripciones de la vitrina de productos físicos — QualityMarketShop por defecto.',
    claves: [
      'site_nombre_mercado',
      'site_tagline_mercado',
      'site_meta_descripcion_mercado',
      'site_footer_descripcion_mercado',
    ],
  },
  {
    titulo: 'Marca de Turismo (/turismo)',
    ayuda: 'El nombre y las descripciones de la vitrina de tours y reservas — QualityTourShop por defecto.',
    claves: [
      'site_nombre_turismo',
      'site_tagline_turismo',
      'site_meta_descripcion_turismo',
      'site_footer_descripcion_turismo',
    ],
  },
  {
    titulo: 'Módulos activables',
    ayuda:
      'Secciones enteras del panel que un negocio de servicios (tours, citas…) no necesita. Apagarlas las quita del menú de todo el mundo; los datos que ya existan no se borran.',
    claves: [
      'modulo_pos',
      'modulo_mermas',
      'modulo_compras_proveedores',
      'modulo_mayoristas',
      'modulo_domicilios',
      'modulo_venta_por_peso',
    ],
  },
  {
    titulo: 'Otros ajustes',
    ayuda: 'Preferencias de operación del día a día.',
    claves: ['pos_recibo_por_defecto'],
  },
];

/**
 * Ajustes de operación: marca del sitio y módulos activables por negocio.
 *
 * Es la interfaz para lo que hasta ahora solo se podía cambiar llamando a
 * `PUT /api/admin/settings` a mano — el mismo endpoint, la misma lista
 * blanca (`AJUSTES` en el Worker). Sin esta pantalla, "editable sin tocar
 * código" solo era cierto para quien sabía usar curl.
 */
@Component({
  selector: 'app-settings-manager',
  templateUrl: './settings-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsManager {
  protected readonly adminApi = inject(AdminApiService);
  protected readonly secciones = SECCIONES;

  /** Lo que hay escrito en cada campo AHORA, para no perder cambios sin guardar al repintar. */
  protected readonly borrador = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly busyClave = signal<string | null>(null);
  protected readonly errorClave = signal<string | null>(null);
  protected readonly errorMensaje = signal<string | null>(null);
  protected readonly guardadoClave = signal<string | null>(null);

  private readonly porClave = computed(
    () => new Map(this.adminApi.ajustes().map((a) => [a.clave, a])),
  );

  constructor() {
    this.adminApi.loadAjustes();
  }

  protected ajuste(clave: string): ApiAjuste | undefined {
    return this.porClave().get(clave);
  }

  protected etiqueta(clave: string): string {
    return ETIQUETAS[clave] ?? clave;
  }

  /** El valor mostrado: lo que se está editando si lo hay, si no el guardado. */
  protected valorActual(clave: string): string {
    return this.borrador().get(clave) ?? this.ajuste(clave)?.valor ?? '';
  }

  protected onTexto(clave: string, event: Event): void {
    const valor = (event.target as HTMLInputElement).value;
    this.borrador.update((mapa) => new Map(mapa).set(clave, valor));
  }

  protected tieneCambioSinGuardar(clave: string): boolean {
    const borrador = this.borrador().get(clave);
    return borrador !== undefined && borrador !== (this.ajuste(clave)?.valor ?? '');
  }

  protected guardarTexto(clave: string): void {
    const valor = this.valorActual(clave).trim();
    if (!valor) {
      this.errorClave.set(clave);
      this.errorMensaje.set('No puede quedar vacío.');
      return;
    }
    this.guardar(clave, valor);
  }

  protected alternar(clave: string): void {
    const actual = this.valorActual(clave);
    this.guardar(clave, actual === '0' ? '1' : '0');
  }

  private guardar(clave: string, valor: string): void {
    this.busyClave.set(clave);
    this.errorClave.set(null);
    this.errorMensaje.set(null);

    this.adminApi.updateSetting(clave, valor).subscribe({
      next: () => {
        this.busyClave.set(null);
        this.borrador.update((mapa) => {
          const siguiente = new Map(mapa);
          siguiente.delete(clave);
          return siguiente;
        });
        this.guardadoClave.set(clave);
        setTimeout(() => {
          if (this.guardadoClave() === clave) {
            this.guardadoClave.set(null);
          }
        }, 1800);
      },
      error: (error: ApiErrorBody) => {
        this.busyClave.set(null);
        this.errorClave.set(clave);
        this.errorMensaje.set(error.message);
      },
    });
  }
}
