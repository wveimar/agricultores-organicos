import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { SiteConfigService } from '../../core/services/site-config.service';
import { PublicWorkspace } from '../../core/models/product.model';

const COLUMNS_MERCADO = [
  {
    title: 'Tienda',
    links: ['Verduras y raíces', 'Frutas frescas', 'Listos para comer', 'Canastas semanales'],
  },
  {
    title: 'La cooperativa',
    links: ['Nuestras 3 fincas', 'Cómo fijamos los precios', 'Certificación orgánica', 'Trabaja con nosotros'],
  },
  {
    title: 'Ayuda',
    links: ['Zonas de entrega', 'Preguntas frecuentes', 'Devoluciones', 'Contacto'],
  },
];

const COLUMNS_TURISMO = [
  {
    title: 'Experiencias',
    links: ['Tours', 'Actividades', 'Alojamiento', 'Disponibilidad'],
  },
  {
    title: 'Sobre nosotros',
    links: ['Cómo elegimos los tours', 'Guías locales', 'Seguridad', 'Trabaja con nosotros'],
  },
  {
    title: 'Ayuda',
    links: ['Cómo reservar', 'Preguntas frecuentes', 'Cancelaciones', 'Contacto'],
  },
];

@Component({
  selector: 'app-footer',
  templateUrl: './footer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Footer {
  /** Qué vitrina es esta — la fija la ruta. Ver `PublicShell`. */
  readonly workspace = input.required<PublicWorkspace>();

  protected readonly brand = inject(SiteConfigService);
  protected readonly year = new Date().getFullYear();

  /** Marca de esta vitrina, no la del panel: ver `SiteConfigService.brandPartsFor`. */
  protected readonly brandParts = computed(() => this.brand.brandPartsFor(this.workspace()));
  protected readonly footerDescription = computed(() =>
    this.brand.footerDescriptionFor(this.workspace()),
  );
  protected readonly siteName = computed(() => this.brand.nameFor(this.workspace()));

  protected readonly columns = computed(() =>
    this.workspace() === 'turismo' ? COLUMNS_TURISMO : COLUMNS_MERCADO,
  );
}
