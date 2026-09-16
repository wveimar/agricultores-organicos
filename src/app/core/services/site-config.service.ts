import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiClient, ApiSiteConfig } from '../api/api-client';
import { PublicWorkspace } from '../models/product.model';

/**
 * La marca del sitio, tal como la sirve `GET /api/config` — ver `leerMarca()`
 * en el Worker. Nombre, WhatsApp y datos bancarios vivían compilados en el
 * frontend (`index.html`, header, footer, `checkout.service.ts`, recibos,
 * reportes exportables); ahora son datos que llegan del servidor, editables
 * desde `PUT /api/admin/settings` sin recompilar ni desplegar.
 *
 * Los valores por defecto de abajo son los mismos que el Worker sirve si
 * nadie ha tocado el ajuste — así que mientras la petición está en camino
 * (o si falla) la tienda se ve exactamente igual que antes de existir este
 * servicio, no en blanco.
 */
const DEFAULT_CONFIG: ApiSiteConfig = {
  turnstileSiteKey: '',
  siteName: 'Agricultores Orgánicos',
  siteTagline: 'Del surco a tu cocina',
  metaDescription:
    'Cooperativa de familias campesinas. Fruta, verdura y despensa orgánica cosechada el mismo día y entregada sin intermediarios.',
  footerDescription:
    'Una cooperativa de familias campesinas que vende directo, sin intermediarios. El 72 % de lo que pagas se queda en la finca.',
  whatsappNumber: '573016066121',
  bank: {
    bank: 'Bancolombia',
    accountType: 'Cuenta de ahorros',
    accountNumber: '64715834837',
    holder: 'wveimar Mamian Ramirez',
    holderDocument: 'cc 70-907-972',
  },
  marketName: 'QualityMarketShop',
  marketTagline: 'Del surco a tu cocina',
  marketMetaDescription:
    'Cooperativa de familias campesinas. Fruta, verdura y despensa orgánica cosechada el mismo día y entregada sin intermediarios.',
  marketFooterDescription:
    'Una cooperativa de familias campesinas que vende directo, sin intermediarios. El 72 % de lo que pagas se queda en la finca.',
  tourName: 'QualityTourShop',
  tourTagline: 'Experiencias para vivir',
  tourMetaDescription: 'Tours, actividades y alojamiento en el Oriente antioqueño, reservables en línea.',
  tourFooterDescription: 'Experiencias reservables con disponibilidad real: tours, actividades y alojamiento.',
};

@Injectable({ providedIn: 'root' })
export class SiteConfigService {
  private readonly api = inject(ApiClient);

  private readonly loaded = signal<ApiSiteConfig>(DEFAULT_CONFIG);
  readonly config = this.loaded.asReadonly();

  readonly siteName = computed(() => this.loaded().siteName);
  readonly siteTagline = computed(() => this.loaded().siteTagline);
  readonly metaDescription = computed(() => this.loaded().metaDescription);
  readonly footerDescription = computed(() => this.loaded().footerDescription);
  readonly whatsappNumber = computed(() => this.loaded().whatsappNumber);
  readonly bank = computed(() => this.loaded().bank);
  readonly turnstileSiteKey = computed(() => this.loaded().turnstileSiteKey);

  /**
   * El nombre partido en dos, para el tratamiento a dos colores que usan el
   * encabezado y el pie de página («Agricultores» / «Orgánicos» en un tono
   * distinto). Se parte por el primer espacio; un nombre de una sola palabra
   * («Tour Andes» sin espacio, o «Andes» a secas) deja `rest` vacío y la
   * plantilla pinta solo `first`, sin el segundo color.
   */
  readonly brandParts = computed<{ first: string; rest: string }>(() => {
    const name = this.siteName();
    const idx = name.indexOf(' ');
    return idx === -1 ? { first: name, rest: '' } : { first: name.slice(0, idx), rest: name.slice(idx + 1) };
  });

  /** «AO» para «Agricultores Orgánicos»: el logo colapsado del panel admin. */
  readonly initials = computed(() => {
    const { first, rest } = this.brandParts();
    return `${first[0] ?? ''}${rest[0] ?? ''}`.toUpperCase();
  });

  /**
   * Marca de cada vitrina pública (0040): `/mercado` y `/turismo` ya no
   * comparten `siteName` —ese sigue siendo el del *panel*—, cada uno tiene
   * el suyo. `Header`/`Footer` reciben el workspace por `input()` (lo fija
   * la ruta, ver `PublicShell`) y llaman a estos métodos en vez de a
   * `siteName()`/`brandParts()` a secas.
   */
  nameFor(workspace: PublicWorkspace): string {
    const config = this.loaded();
    return workspace === 'turismo' ? config.tourName : config.marketName;
  }

  taglineFor(workspace: PublicWorkspace): string {
    const config = this.loaded();
    return workspace === 'turismo' ? config.tourTagline : config.marketTagline;
  }

  metaDescriptionFor(workspace: PublicWorkspace): string {
    const config = this.loaded();
    return workspace === 'turismo' ? config.tourMetaDescription : config.marketMetaDescription;
  }

  footerDescriptionFor(workspace: PublicWorkspace): string {
    const config = this.loaded();
    return workspace === 'turismo' ? config.tourFooterDescription : config.marketFooterDescription;
  }

  /** Mismo partido a dos colores que `brandParts()`, para el nombre de un workspace. */
  brandPartsFor(workspace: PublicWorkspace): { first: string; rest: string } {
    const name = this.nameFor(workspace);
    const idx = name.indexOf(' ');
    return idx === -1 ? { first: name, rest: '' } : { first: name.slice(0, idx), rest: name.slice(idx + 1) };
  }

  constructor() {
    // Si falla, se queda en los valores por defecto: un problema de red no
    // debe dejar la tienda sin marca ni datos de pago.
    this.api.config().subscribe({
      next: (config) => this.loaded.set(config),
      error: () => {},
    });
  }
}
