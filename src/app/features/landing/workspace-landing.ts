import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SiteConfigService } from '../../core/services/site-config.service';

/**
 * Portada neutra (0040): lo primero que ve quien llega a la raíz del
 * dominio, antes de entrar a una de las dos vitrinas independientes.
 *
 * No vive bajo `PublicShell` a propósito — no tiene sentido decorarla con el
 * header o el tema de Mercado ni con los de Turismo, porque todavía no se ha
 * elegido ninguno. Es su propia página, sin marca de ningún workspace más
 * que la del panel (`SiteConfigService.siteName()`), usada aquí como el
 * nombre paraguas que agrupa a las dos.
 */
@Component({
  selector: 'app-workspace-landing',
  imports: [RouterLink],
  templateUrl: './workspace-landing.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceLanding {
  protected readonly brand = inject(SiteConfigService);
}
