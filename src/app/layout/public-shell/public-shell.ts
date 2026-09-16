import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject } from '@angular/core';
import { ActivatedRoute, RouterOutlet } from '@angular/router';
import { Header } from '../header/header';
import { Footer } from '../footer/footer';
import { CartDrawer } from '../../shared/cart-drawer/cart-drawer';
import { ProductSheetModal } from '../../shared/product-sheet-modal/product-sheet-modal';
import { CatalogService } from '../../core/services/catalog.service';
import { PublicWorkspace } from '../../core/models/product.model';

/**
 * Envoltorio de una vitrina pública: header, footer y carrito.
 *
 * Existe para que el panel de administración **no** los herede. Antes vivían
 * en `App`, así que se pintaban también sobre `/admin`, donde el hero y el
 * carrito no pintan nada.
 *
 * Desde 0040 hay DOS instancias de esta ruta —`/mercado` y `/turismo`—, cada
 * una con su propio `data.workspace`: son dos vitrinas independientes que
 * deben "parecer 2 proyectos distintos" (QualityMarketShop / QualityTourShop),
 * no pestañas de una sola tienda. `workspace` se lee UNA vez, del snapshot de
 * la ruta que carga este mismo componente — no hace falta un `Observable`
 * porque moverse de una vitrina a la otra es navegar a una ruta hermana
 * distinta: Angular destruye y reconstruye `PublicShell` entero, así que un
 * valor leído en el constructor ya es correcto para toda la vida de esta
 * instancia.
 *
 * También es quien viste la vitrina con el tema del workspace (0039): una
 * clase `theme-<valor>` en `<body>` que `styles.css` traduce en una paleta de
 * colores distinta (Turismo deja el verde y pasa a un azul claro). Va aquí y
 * no en `App` por el mismo motivo que el resto de este componente — el panel
 * no debe heredar el tema de ninguna vitrina.
 */
@Component({
  selector: 'app-public-shell',
  imports: [RouterOutlet, Header, Footer, CartDrawer, ProductSheetModal],
  templateUrl: './public-shell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicShell {
  private readonly catalog = inject(CatalogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  /** Fijado por la ruta (`data.workspace`) — ver `app.routes.ts`. */
  protected readonly workspace: PublicWorkspace =
    (this.route.snapshot.data['workspace'] as PublicWorkspace | undefined) ?? 'mercado';

  private currentThemeClass: string | null = null;

  constructor() {
    this.catalog.lockWorkspace(this.workspace);

    effect(() => {
      // `themeOverride` manda cuando está puesto: lo usa `TourDetailPage`
      // para que un tour abierto por enlace directo —sin haber pasado por
      // esta vitrina primero— muestre igual su tema.
      const theme = this.catalog.themeOverride() ?? this.catalog.activeGroupTheme();
      const next = theme ? `theme-${theme}` : null;

      if (this.currentThemeClass === next) {
        return;
      }
      if (this.currentThemeClass) {
        document.body.classList.remove(this.currentThemeClass);
      }
      if (next) {
        document.body.classList.add(next);
      }
      this.currentThemeClass = next;
    });

    // Si se navega fuera de la vitrina pública (al panel, por ejemplo) sin
    // pasar por aquí de nuevo, la clase no debe quedarse pegada al `<body>`
    // compartido por toda la app.
    this.destroyRef.onDestroy(() => {
      if (this.currentThemeClass) {
        document.body.classList.remove(this.currentThemeClass);
      }
    });
  }
}
