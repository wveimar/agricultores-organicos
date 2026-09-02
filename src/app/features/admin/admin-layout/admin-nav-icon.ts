import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Las siluetas del menú lateral.
 *
 * Existen por el menú colapsado: encogido a 64 px no cabe el texto, y un menú
 * de dieciséis entradas idénticas no se puede usar. La silueta es lo único que
 * distingue «Pedidos» de «Cobros» cuando no hay etiqueta.
 *
 * Trazos y no relleno, con `currentColor`: heredan el color del enlace, así que
 * la entrada activa se tiñe sola sin una clase condicional por icono.
 *
 * No reutiliza `CategoryIcon`: aquel dibuja el catálogo —hoja, panal, canasta—
 * y estas son secciones del panel. Compartir un repertorio obligaría a que
 * añadir una sección tocara los chips de la tienda, que no tienen nada que ver.
 */
const PATHS: Readonly<Record<string, string>> = {
  // Cajas apiladas: existencias.
  inventario: 'M3 7l9-4 9 4-9 4-9-4Zm0 5l9 4 9-4M3 17l9 4 9-4',
  // Etiqueta con su ojal.
  categorias: 'M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Zm5-5h.01',
  // Cuadrícula: agrupaciones.
  grupos: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  // Registradora con su cajón.
  caja: 'M3 9h18M5 9V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3m1 0v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9M9 14h6',
  // Portapapeles con líneas.
  pedidos: 'M9 4h6v2H9V4Zm-2 2h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm2 6h6M9 16h4',
  // Barras ascendentes.
  reportes: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  // Camión.
  consolidado: 'M3 7h11v9H3V7Zm11 3h4l3 3v3h-7v-6ZM7 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  // Documento con doblez.
  facturacion: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Zm0 0v4h4M9 13h6M9 17h4',
  // Billete.
  cobros: 'M3 7h18v10H3V7Zm9 5a2 2 0 1 0 0-.01M6 10v.01M18 14v.01',
  // Cartera: documento con reloj.
  cartera: 'M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6M17 13v3l2 1m-2-7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  // Flecha saliendo de la caja.
  gastos: 'M4 6h16v12H4V6Zm8 3v6m0 0-2.5-2.5M12 15l2.5-2.5',
  // Agenda de contactos.
  contactos: 'M7 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm-2 5h2m-2 4h2m-2 4h2m6-5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 5c0-1.7 1.3-3 3-3s3 1.3 3 3',
  // Bolsa de compra.
  compras: 'M6 8h12l-1 12H7L6 8Zm3 0V6a3 3 0 0 1 6 0v2',
  // Caneca de basura: lo que se descarta.
  mermas: 'M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m2 0-.7 12a1 1 0 0 1-1 1H8.7a1 1 0 0 1-1-1L7 7m3 4v6m4-6v6',
  // Moto de reparto.
  entregas: 'M5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm14 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-11.5-2.5h9M14 6h3l2 7M7.5 15.5 11 6',
  // Cajas grandes: venta al por mayor.
  mayoristas: 'M3 8l9-4 9 4v8l-9 4-9-4V8Zm9-4v16m9-12-9 4-9-4',
  // Dos personas.
  usuarios: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 8c0-2.8 2.7-5 6-5s6 2.2 6 5m2-13a3 3 0 0 1 0 6m4 7c0-2.2-1.4-4-3.5-4.6',
};

/** Un círculo, para una sección sin silueta propia todavía. */
const POR_DEFECTO = 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z';

@Component({
  selector: 'app-admin-nav-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.class]="svgClass()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path [attr.d]="d()" />
    </svg>
  `,
})
export class AdminNavIcon {
  readonly name = input<string>('');
  readonly svgClass = input<string>('size-5 shrink-0');

  protected readonly d = computed(() => PATHS[this.name()] ?? POR_DEFECTO);
}
