import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Header } from '../header/header';
import { Footer } from '../footer/footer';
import { CartDrawer } from '../../shared/cart-drawer/cart-drawer';
import { ProductVariantsModal } from '../../shared/product-variants-modal/product-variants-modal';

/**
 * Envoltorio de la tienda pública: header, footer y carrito.
 *
 * Existe para que el panel de administración **no** los herede. Antes vivían
 * en `App`, así que se pintaban también sobre `/admin`, donde el hero y el
 * carrito no pintan nada.
 */
@Component({
  selector: 'app-public-shell',
  imports: [RouterOutlet, Header, Footer, CartDrawer, ProductVariantsModal],
  templateUrl: './public-shell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicShell {}
