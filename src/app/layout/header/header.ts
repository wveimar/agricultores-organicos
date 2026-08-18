import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { CartService } from '../../core/services/cart.service';
import { CatalogService } from '../../core/services/catalog.service';
import { TokenStore } from '../../core/api/token-store';
import { ROLE_LABELS } from '../../core/models/user.model';

/** Píxeles de scroll a partir de los cuales el header se vuelve sólido. */
const SOLID_THRESHOLD = 24;

@Component({
  selector: 'app-header',
  templateUrl: './header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  protected readonly cart = inject(CartService);
  protected readonly tokens = inject(TokenStore);
  private readonly catalog = inject(CatalogService);
  private readonly router = inject(Router);

  /**
   * Sello del nivel de mayorista. `null` para el cliente normal, que es el
   * caso habitual y no debe ver nada.
   *
   * Sale de `CatalogService.wholesaleTier`, la misma señal que decide si los
   * precios llegan con descuento: si el sello aparece, los precios de la
   * vitrina ya son los de esa tarifa. Calcularlo aparte aquí permitiría que
   * el sello dijera una cosa y los precios otra.
   */
  protected readonly wholesaleLabel = computed(() => {
    const tier = this.catalog.wholesaleTier();
    return tier ? ROLE_LABELS[tier] : null;
  });

  /** true en cuanto se baja del umbral: dispara el cambio a fondo sólido. */
  protected readonly isScrolled = signal(false);
  protected readonly isMenuOpen = signal(false);

  /**
   * Solo la portada tiene un hero oscuro detrás del header. En el resto de
   * páginas el fondo es crema, así que el texto en `bone` sería invisible: ahí
   * la barra tiene que arrancar sólida.
   */
  private readonly overHero = signal(false);

  protected readonly isSolid = computed(
    () => !this.overHero() || this.isScrolled() || this.isMenuOpen(),
  );

  constructor() {
    this.syncOverHero();
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.syncOverHero());
  }

  /**
   * Lee `transparentHeader` de la ruta activa más profunda.
   *
   * Recorre el árbol de *snapshots*, no el de `ActivatedRoute`: durante la
   * navegación inicial las rutas intermedias todavía no tienen `snapshot`
   * asignado y leerlo reventaba el arranque de la app.
   */
  private syncOverHero(): void {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) {
      route = route.firstChild;
    }
    this.overHero.set(route.data['transparentHeader'] === true);
  }

  protected readonly links = [
    { label: 'Tienda', href: '#tienda' },
    { label: 'Canastas', href: '#tienda' },
    { label: 'Nuestras fincas', href: '#historia' },
    { label: 'Cómo funciona', href: '#historia' },
  ];

  @HostListener('window:scroll')
  protected onScroll(): void {
    this.isScrolled.set(window.scrollY > SOLID_THRESHOLD);
  }

  protected toggleMenu(): void {
    this.isMenuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.isMenuOpen.set(false);
  }
}
