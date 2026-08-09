import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** API que inyecta el script de Cloudflare en `window`. */
declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: Record<string, unknown>): string;
      remove(widgetId: string): void;
      reset(widgetId: string): void;
    };
    onloadTurnstileCallback?: () => void;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type Mode = 'demo' | 'real' | 'error';

/**
 * Widget de Cloudflare Turnstile.
 *
 * Con una `siteKey` real carga el script de Cloudflare y renderiza el widget
 * de verdad. Sin ella entra en **modo demo**: dibuja un marcador con la misma
 * caja y emite un token falso, para poder maquetar y probar el login sin
 * cuenta de Cloudflare.
 *
 * ⚠️ El token que emite este componente **no prueba nada por sí solo**. Quien
 * decide si es válido es el servidor, llamando a `siteverify` con la clave
 * secreta. Un login que solo compruebe que el token "existe" en el navegador
 * no está protegido contra bots.
 */
@Component({
  selector: 'app-turnstile',
  templateUrl: './turnstile.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Turnstile implements OnDestroy {
  /** Sitekey pública. Vacía → modo demo. */
  readonly siteKey = input<string>('');

  readonly verified = output<string>();

  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('widget');
  private readonly host = inject(ElementRef);

  protected readonly mode = signal<Mode>('demo');
  protected readonly demoChecked = signal(false);

  private widgetId?: string;

  constructor() {
    afterNextRender(() => {
      if (!this.siteKey()) {
        this.mode.set('demo');
        return;
      }
      this.mode.set('real');
      this.loadScript()
        .then(() => this.renderWidget())
        .catch(() => this.mode.set('error'));
    });
  }

  /** En modo demo el usuario marca la casilla y se emite un token de mentira. */
  protected confirmDemo(): void {
    this.demoChecked.set(true);
    this.verified.emit('demo-token-sin-validez');
  }

  private loadScript(): Promise<void> {
    if (window.turnstile) {
      return Promise.resolve();
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_URL}"]`);
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('turnstile')), { once: true });
      });
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('turnstile')), { once: true });
      document.head.appendChild(script);
    });
  }

  private renderWidget(): void {
    if (!window.turnstile) {
      this.mode.set('error');
      return;
    }
    this.widgetId = window.turnstile.render(this.container().nativeElement, {
      sitekey: this.siteKey(),
      theme: 'light',
      callback: (token: string) => this.verified.emit(token),
      'error-callback': () => this.mode.set('error'),
      // Un token caducado no debe seguir contando como verificación válida.
      'expired-callback': () => this.verified.emit(''),
    });
  }

  ngOnDestroy(): void {
    if (this.widgetId && window.turnstile) {
      window.turnstile.remove(this.widgetId);
    }
    void this.host;
  }
}
