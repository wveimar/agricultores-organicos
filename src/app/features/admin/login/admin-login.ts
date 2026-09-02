import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiClient, ApiErrorBody } from '../../../core/api/api-client';
import { isWholesaleRole } from '../../../core/models/user.model';
import { Turnstile } from '../../../shared/turnstile/turnstile';
import { FieldError, FieldErrorState } from '../../../shared/field-error/field-error';

/*
 * Aquí había una lista de cuentas de demostración con su contraseña a la
 * vista. Se retiró: enseñar qué correos existen le ahorra al atacante la mitad
 * del trabajo, y enseñar la contraseña le ahorra la otra mitad. Las cuentas
 * ahora se crean desde /admin/usuarios, y quien olvida su clave pide que se le
 * asigne otra.
 */

@Component({
  selector: 'app-admin-login',
  imports: [ReactiveFormsModule, RouterLink, Turnstile, FieldErrorState, FieldError],
  templateUrl: './admin-login.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLogin {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiClient);

  /**
   * Sitekey pública de Turnstile, servida por `GET /api/config`.
   *
   * Vacía → el widget entra en modo demo, que es lo que ocurre mientras no se
   * configure `TURNSTILE_SITE_KEY` en el Worker. Viene del servidor y no
   * compilada aquí para que activarla no obligue a reconstruir el frontend.
   * La clave **secreta** nunca llega al navegador: solo la usa el Worker
   * contra `siteverify`.
   */
  protected readonly turnstileSiteKey = signal('');

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  protected readonly turnstileToken = signal<string | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly submitting = signal(false);

  constructor() {
    // Si la petición falla se queda en modo demo: un problema de red no debe
    // dejar la pantalla de entrada inservible.
    this.api.config().subscribe({
      next: ({ turnstileSiteKey }) => this.turnstileSiteKey.set(turnstileSiteKey),
      error: () => this.turnstileSiteKey.set(''),
    });
  }

  protected onVerified(token: string): void {
    // Un token vacío llega cuando Turnstile expira: hay que volver a verificar.
    this.turnstileToken.set(token || null);
  }

  protected submit(): void {
    this.errorMessage.set(null);

    if (this.form.invalid) {
      // Sin esto, los campos que el usuario nunca tocó no muestran su error.
      this.form.markAllAsTouched();
      return;
    }

    if (!this.turnstileToken()) {
      this.errorMessage.set('Completa la verificación anti-bots antes de continuar.');
      return;
    }

    this.submitting.set(true);
    const { email, password } = this.form.getRawValue();

    // El login es una petición HTTP real: el JWT lo firma el Worker con
    // JWT_SECRET, no algo que el navegador pueda fabricarse a sí mismo. El
    // token de Turnstile viaja con él porque quien decide si vale es el
    // servidor — comprobarlo aquí no serviría de nada contra un `curl`.
    this.api.login(email, password, this.turnstileToken()).subscribe({
      next: (session) => {
        this.submitting.set(false);

        // Una cuenta de mayorista no tiene nada que hacer en el panel: sus
        // roles no abren ninguna sección, así que aterrizaría en una portada
        // vacía sin entender por qué. Se le manda a la tienda, que es donde su
        // sesión sí significa algo — los precios ya con su tarifa.
        const soloMayorista =
          session.user.roles.length > 0 && session.user.roles.every(isWholesaleRole);

        if (soloMayorista) {
          void this.router.navigateByUrl('/');
          return;
        }

        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/admin';
        void this.router.navigateByUrl(returnUrl);
      },
      error: (error: ApiErrorBody) => {
        this.submitting.set(false);
        this.errorMessage.set(
          error.code === 'sin-conexion'
            ? error.message
            : 'Correo o contraseña incorrectos.',
        );
      },
    });
  }
}
