import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { CartService } from '../../core/services/cart.service';

/** Píxeles de scroll a partir de los cuales el header se vuelve sólido. */
const SOLID_THRESHOLD = 24;

@Component({
  selector: 'app-header',
  templateUrl: './header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  protected readonly cart = inject(CartService);

  /** true en cuanto se baja del umbral: dispara el cambio a fondo sólido. */
  protected readonly isScrolled = signal(false);
  protected readonly isMenuOpen = signal(false);

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
