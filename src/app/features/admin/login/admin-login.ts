import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiClient, ApiErrorBody } from '../../../core/api/api-client';
import { Turnstile } from '../../../shared/turnstile/turnstile';

/*
 * Aquí había una lista de cuentas de demostración con su contraseña a la
 * vista. Se retiró: enseñar qué correos existen le ahorra al atacante la mitad
 * del trabajo, y enseñar la contraseña le ahorra la otra mitad. Las cuentas
 * ahora se crean desde /admin/usuarios, y quien olvida su clave pide que se le
 * asigne otra.
 */

@Component({
  selector: 'app-admin-login',
  imports: [ReactiveFormsModule, RouterLink, Turnstile],
  templateUrl: './admin-login.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLogin {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiClient);

  /**
   * Sitekey pública de Turnstile. Vacía → el widget entra en modo demo.
   * En un despliegue real llega de la configuración de entorno; la clave
   * **secreta** nunca aparece aquí: solo la usa el servidor en `siteverify`.
   */
  protected readonly turnstileSiteKey = '';

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  protected readonly turnstileToken = signal<string | null>(null);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly submitting = signal(false);

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
    // JWT_SECRET, no algo que el navegador pueda fabricarse a sí mismo.
    this.api.login(email, password).subscribe({
      next: () => {
        this.submitting.set(false);
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

  protected showError(field: 'email' | 'password'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }
}
