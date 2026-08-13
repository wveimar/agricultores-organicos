import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiClient, ApiErrorBody } from '../../../core/api/api-client';

const MIN_PASSWORD = 8;

/**
 * Las dos mitades de la recuperación, en un solo componente.
 *
 * Comparten pantalla, encabezado y estilos, y el usuario las recorre seguidas:
 * pide el enlace, abre el correo, vuelve aquí con el token. Separarlas en dos
 * componentes duplicaría la plantilla para ahorrar un `@if`.
 *
 * El modo lo decide la URL: con `?token=` se muestra el formulario de
 * contraseña nueva; sin él, el de pedir el enlace.
 */
@Component({
  selector: 'app-recover-password',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './recover-password.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecoverPassword {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly minPassword = MIN_PASSWORD;

  protected readonly token = this.route.snapshot.queryParamMap.get('token');
  protected readonly modo = computed<'pedir' | 'restablecer'>(() =>
    this.token ? 'restablecer' : 'pedir',
  );

  protected readonly enviando = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly enviado = signal(false);
  protected readonly listo = signal(false);

  // ─────────────────────────── Pedir el enlace ───────────────────────────

  protected readonly pedirForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected pedir(): void {
    if (this.pedirForm.invalid) {
      this.pedirForm.markAllAsTouched();
      return;
    }

    this.error.set(null);
    this.enviando.set(true);

    this.api.requestPasswordReset(this.pedirForm.getRawValue().email).subscribe({
      // El servidor responde igual exista o no la cuenta, y la pantalla hace
      // lo mismo: un mensaje distinto aquí delataría qué correos están
      // registrados, que es justo lo que el endpoint evita.
      next: () => {
        this.enviando.set(false);
        this.enviado.set(true);
      },
      error: (err: ApiErrorBody) => {
        this.enviando.set(false);
        this.error.set(err.message);
      },
    });
  }

  // ──────────────────────── Elegir contraseña nueva ────────────────────────

  protected readonly nuevaForm = this.fb.nonNullable.group({
    nueva: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
    repetir: ['', [Validators.required]],
  });

  protected readonly noCoinciden = computed(() => false);

  protected restablecer(): void {
    const { nueva, repetir } = this.nuevaForm.getRawValue();

    if (this.nuevaForm.invalid) {
      this.nuevaForm.markAllAsTouched();
      return;
    }

    // Se comprueba aquí y no con un validador de grupo porque el mensaje debe
    // aparecer al enviar, no mientras se escribe la segunda vez: hasta
    // terminar de teclearla, "no coinciden" siempre sería cierto y siempre
    // sería ruido.
    if (nueva !== repetir) {
      this.error.set('Las dos contraseñas no coinciden.');
      return;
    }

    this.error.set(null);
    this.enviando.set(true);

    this.api.resetPassword(this.token!, nueva).subscribe({
      next: () => {
        this.enviando.set(false);
        this.listo.set(true);
        // Se va al login por su propio pie tras un momento, para que dé tiempo
        // a leer que salió bien.
        setTimeout(() => void this.router.navigate(['/admin/login']), 2500);
      },
      error: (err: ApiErrorBody) => {
        this.enviando.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected mostrarError(campo: 'nueva' | 'repetir'): boolean {
    const control = this.nuevaForm.controls[campo];
    return control.invalid && (control.touched || control.dirty);
  }
}
