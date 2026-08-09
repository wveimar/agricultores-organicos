import {
  Directive,
  ElementRef,
  OnDestroy,
  afterNextRender,
  inject,
  input,
} from '@angular/core';

/**
 * Fade-in discreto cuando el elemento entra en el viewport.
 * Sin librerías: un IntersectionObserver que se desconecta tras revelar.
 * Los estilos `.reveal` / `.is-visible` viven en src/styles.css.
 */
@Directive({
  selector: '[appReveal]',
  host: { class: 'reveal' },
})
export class RevealDirective implements OnDestroy {
  /** Retardo en ms, para escalonar elementos hermanos. */
  readonly appReveal = input<number>(0);

  private readonly host = inject(ElementRef<HTMLElement>);
  private observer?: IntersectionObserver;

  constructor() {
    afterNextRender(() => {
      const element = this.host.nativeElement as HTMLElement;

      // Sin soporte de IntersectionObserver, el contenido se muestra sin más.
      if (!('IntersectionObserver' in window)) {
        element.classList.add('is-visible');
        return;
      }

      element.style.transitionDelay = `${this.appReveal()}ms`;

      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              element.classList.add('is-visible');
              this.observer?.disconnect();
            }
          }
        },
        { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
      );

      this.observer.observe(element);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
