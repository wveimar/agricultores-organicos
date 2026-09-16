import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { ApiAdminProductSession, ApiClient, ApiErrorBody } from '../../../../core/api/api-client';
import { formatSessionDate } from '../../../../core/models/product.model';

/**
 * Sesiones de un producto-servicio (migración 0038): las salidas/citas que
 * la tienda ofrece para reservar. Es el equivalente de `RecipeEditor` para
 * el flujo de servicios — mismo patrón: recibe el id del producto ya creado
 * (una sesión no existe sin su producto), llama directo a `ApiClient` para
 * este sub-recurso, y cada respuesta trae la lista completa actualizada.
 */
@Component({
  selector: 'app-sessions-editor',
  templateUrl: './sessions-editor.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionsEditor {
  private readonly api = inject(ApiClient);

  readonly productId = input.required<string>();

  protected readonly sessions = signal<readonly ApiAdminProductSession[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);

  /** Formulario de alta. `inicio` es lo que da un `<input type="datetime-local">`. */
  protected readonly nuevoInicio = signal('');
  protected readonly nuevaUbicacion = signal('');
  protected readonly nuevoCupo = signal(10);
  protected readonly adding = signal(false);

  protected readonly fechaSesion = formatSessionDate;

  constructor() {
    queueMicrotask(() => this.load());
  }

  private load(): void {
    this.loading.set(true);
    this.api.listProductSessions(this.productId()).subscribe({
      next: (sesiones) => {
        this.sessions.set(sesiones);
        this.loading.set(false);
      },
      error: (err: ApiErrorBody) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected cupoDisponible(session: ApiAdminProductSession): number {
    return session.cupoTotal - session.cupoReservado;
  }

  protected add(): void {
    const inicioLocal = this.nuevoInicio();
    if (!inicioLocal || this.nuevoCupo() < 1) {
      return;
    }

    this.adding.set(true);
    this.error.set(null);

    this.api
      .createProductSession(this.productId(), {
        // El input no trae huso horario: `Date` lo interpreta en la hora
        // local del navegador, que es justo lo que el admin tecleó.
        inicio: new Date(inicioLocal).toISOString(),
        ubicacion: this.nuevaUbicacion().trim() || undefined,
        cupoTotal: this.nuevoCupo(),
      })
      .subscribe({
        next: (sesiones) => {
          this.sessions.set(sesiones);
          this.adding.set(false);
          this.nuevoInicio.set('');
          this.nuevaUbicacion.set('');
          this.nuevoCupo.set(10);
        },
        error: (err: ApiErrorBody) => {
          this.adding.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected onCupoChange(event: Event): void {
    this.nuevoCupo.set(Number((event.target as HTMLInputElement).value) || 1);
  }

  protected toggleActivo(session: ApiAdminProductSession): void {
    this.busyId.set(session.id);
    this.error.set(null);

    this.api
      .updateProductSession(this.productId(), session.id, { activo: session.activo === 1 ? 0 : 1 })
      .subscribe({
        next: (sesiones) => {
          this.sessions.set(sesiones);
          this.busyId.set(null);
        },
        error: (err: ApiErrorBody) => {
          this.busyId.set(null);
          this.error.set(err.message);
        },
      });
  }

  /** Falla con `sesion-con-reservas` si ya tiene gente apuntada: hay que desactivarla en vez de borrarla. */
  protected remove(session: ApiAdminProductSession): void {
    this.busyId.set(session.id);
    this.error.set(null);

    this.api.deleteProductSession(this.productId(), session.id).subscribe({
      next: (sesiones) => {
        this.sessions.set(sesiones);
        this.busyId.set(null);
      },
      error: (err: ApiErrorBody) => {
        this.busyId.set(null);
        this.error.set(err.message);
      },
    });
  }
}
