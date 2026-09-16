import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SiteConfigService } from './core/services/site-config.service';
import { PublicWorkspace } from './core/models/product.model';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly router = inject(Router);
  private readonly titleService = inject(Title);
  private readonly meta = inject(Meta);
  private readonly siteConfig = inject(SiteConfigService);

  /**
   * `data.pageTitle` de la ruta activa más profunda, o `null` en la portada
   * (que no lleva uno: ahí el título es "{nombre} · {tagline}" a secas).
   *
   * Antes cada ruta llevaba su `title` completo quemado en `app.routes.ts`
   * ("Agricultores Orgánicos · Del surco a tu cocina"). Eso exigía tocar
   * código para cambiar de marca Y no podía reaccionar si la marca cambiaba
   * en caliente desde `PUT /api/admin/settings` — el `title` de una ruta de
   * Angular se fija una vez, al navegar. Aquí la ruta solo dice QUÉ página
   * es; el nombre y la frase salen siempre de `SiteConfigService`.
   */
  private readonly pageTitle = signal<string | null>(null);

  /**
   * `data.workspace` de la ruta activa (0040): `/mercado` o `/turismo`, o
   * `null` fuera de ambas (el panel, la portada). Decide de qué marca sale
   * el título de la pestaña — `SiteConfigService.siteName()` a secas es la
   * del *panel*, y las dos vitrinas ya no la comparten.
   */
  private readonly workspace = signal<PublicWorkspace | null>(null);

  constructor() {
    this.syncPageTitle();
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.syncPageTitle());

    // Reacciona tanto a un cambio de página como a que la marca termine de
    // cargar (o cambie): las dos cosas deciden el título final.
    effect(() => {
      const workspace = this.workspace();
      const siteName = workspace ? this.siteConfig.nameFor(workspace) : this.siteConfig.siteName();
      const tagline = workspace ? this.siteConfig.taglineFor(workspace) : this.siteConfig.siteTagline();
      const metaDescription = workspace
        ? this.siteConfig.metaDescriptionFor(workspace)
        : this.siteConfig.metaDescription();
      const page = this.pageTitle();

      this.titleService.setTitle(page ? `${page} · ${siteName}` : `${siteName} · ${tagline}`);
      this.meta.updateTag({ name: 'description', content: metaDescription });
    });
  }

  /** Mismo patrón que `Header.syncOverHero()`: recorre los *snapshots*, no `ActivatedRoute`. */
  private syncPageTitle(): void {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) {
      route = route.firstChild;
    }
    this.pageTitle.set((route.data['pageTitle'] as string | undefined) ?? null);
    this.workspace.set((route.data['workspace'] as PublicWorkspace | undefined) ?? null);
  }
}
