import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { Turnstile } from '../../../shared/turnstile/turnstile';

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
  protected readonly auth = inject(AuthService);

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

  protected fillDemo(email: string, password: string): void {
    this.form.setValue({ email, password });
    this.errorMessage.set(null);
  }

  protected submit(): void {
    this.errorMessage.set(null);

    if (this.form.invalid) {
      // Sin esto, los campos que el usuario nunca tocó no muestran su error.
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    const { email, password } = this.form.getRawValue();
    const result = this.auth.login(email, password, this.turnstileToken());
    this.submitting.set(false);

    if (!result.ok) {
      this.errorMessage.set(
        result.error === 'captcha'
          ? 'Completa la verificación anti-bots antes de continuar.'
          : 'Correo o contraseña incorrectos.',
      );
      return;
    }

    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') ?? '/admin';
    void this.router.navigateByUrl(returnUrl);
  }

  protected showError(field: 'email' | 'password'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }
}
