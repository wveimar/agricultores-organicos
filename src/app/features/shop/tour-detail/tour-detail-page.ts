import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { CatalogService } from '../../../core/services/catalog.service';
import { CartService } from '../../../core/services/cart.service';
import { ProductSession, formatSessionDate } from '../../../core/models/product.model';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { PhotoCarousel, CarouselPhoto } from '../../../shared/photo-carousel/photo-carousel';
import { TourCalendar } from '../../../shared/tour-calendar/tour-calendar';

/**
 * Ficha de detalle de un producto-servicio: toda la información completa
 * ("al dar clic salgan los detalles completos del tour") — carrusel de
 * fotos, descripción larga y el calendario de disponibilidad, en vez del
 * modal compacto que usa un producto físico con variantes.
 *
 * Ruta propia (`/producto/:slug`) y no un modal más grande: un tour tiene
 * bastante que enseñar —itinerario, qué incluye, fotos, fechas— como para
 * que compartir el enlace a una ficha concreta tenga sentido por sí solo.
 */
@Component({
  selector: 'app-tour-detail-page',
  imports: [RouterLink, CopPipe, PhotoCarousel, TourCalendar],
  templateUrl: './tour-detail-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TourDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly catalog = inject(CatalogService);
  protected readonly cart = inject(CartService);

  /**
   * `toSignal` sobre el observable de parámetros, no `snapshot`: Angular
   * puede reutilizar esta misma instancia al navegar de un tour a otro
   * —misma ruta, `slug` distinto—, y un `snapshot` leído una sola vez en el
   * constructor se quedaría con el primer tour para siempre.
   */
  private readonly slug = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('slug') ?? '')),
    { initialValue: '' },
  );

  protected readonly product = computed(() => this.catalog.productBySlug(this.slug()));

  /**
   * Pone el tema del producto mientras esta ficha está montada, y lo quita al
   * salir. Ver `CatalogService.themeOverride`: sin esto, un tour abierto por
   * enlace directo (sin haber pasado por la solapa "Turismo") se vería con el
   * tema verde de siempre en vez del suyo.
   */
  constructor() {
    effect(() => {
      const product = this.product();
      this.catalog.themeOverride.set(product ? this.catalog.themeForProduct(product) : null);
    });
    inject(DestroyRef).onDestroy(() => this.catalog.themeOverride.set(null));
  }

  protected readonly photos = computed<readonly CarouselPhoto[]>(() => {
    const product = this.product();
    if (!product) {
      return [];
    }
    if (product.photos && product.photos.length > 0) {
      return product.photos.map((p) => ({ url: p.url, alt: p.alt || product.name }));
    }
    // Sin galería propia todavía: se cae a las dos fotos de la tarjeta, para
    // que la ficha nunca se vea vacía mientras nadie sube más.
    const fallback: CarouselPhoto[] = [{ url: product.image, alt: product.imageAlt }];
    if (product.imageHover) {
      fallback.push({ url: product.imageHover, alt: product.imageAlt });
    }
    return fallback;
  });

  protected readonly sessions = computed(() => this.product()?.sessions ?? []);

  protected readonly selectedSessionId = signal<string | null>(null);
  protected readonly selectedSession = computed<ProductSession | null>(() => {
    const id = this.selectedSessionId();
    return this.sessions().find((s) => s.id === id) ?? null;
  });

  protected readonly participants = signal(1);
  protected readonly fechaSesion = formatSessionDate;

  /** Igual que en `ProductSheetModal`: cupo del servidor + lo que esta línea ya tenía en el carrito. */
  protected readonly maxParticipants = computed(() => {
    const session = this.selectedSession();
    const product = this.product();
    if (!session || !product) {
      return 0;
    }
    const yaEnCarrito = this.cart
      .items()
      .find((line) => line.product.id === product.id && line.session?.id === session.id)?.quantity ?? 0;
    return session.capacityAvailable + yaEnCarrito;
  });

  protected readonly cartTypeMismatch = computed(() => {
    const product = this.product();
    return product !== null && product !== undefined && !this.cart.canAdd(product);
  });

  protected readonly canReserve = computed(
    () =>
      !this.cartTypeMismatch() &&
      this.selectedSession() !== null &&
      this.maxParticipants() > 0 &&
      this.participants() >= 1 &&
      this.participants() <= this.maxParticipants(),
  );

  protected onSelectSession(sessionId: string): void {
    this.selectedSessionId.set(sessionId);
    this.participants.set(1);
  }

  protected setParticipants(value: number): void {
    this.participants.set(Math.min(Math.max(1, Math.round(value) || 1), this.maxParticipants()));
  }

  protected reservar(): void {
    const product = this.product();
    const session = this.selectedSession();
    if (!product || !session || !this.canReserve()) {
      return;
    }
    this.cart.addService(product, session, this.participants());
    this.cart.open();
  }

  protected irACheckout(): void {
    this.reservar();
    // Esta ficha solo vive bajo /turismo (0040): no hace falta leer el
    // workspace, ya se sabe cuál es.
    void this.router.navigateByUrl('/turismo/checkout');
  }
}
