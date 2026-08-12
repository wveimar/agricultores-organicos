import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { TokenStore } from '../../../core/api/token-store';
import { ApiErrorBody, ApiUser } from '../../../core/api/api-client';
import { ALL_ROLES, ROLE_LABELS, UserRole } from '../../../core/models/user.model';

/** Mismo mínimo que exige el servidor. */
const MIN_PASSWORD = 8;

@Component({
  selector: 'app-users-manager',
  imports: [ReactiveFormsModule],
  templateUrl: './users-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersManager {
  protected readonly adminApi = inject(AdminApiService);
  private readonly tokens = inject(TokenStore);
  private readonly fb = inject(FormBuilder);

  protected readonly roles = ALL_ROLES;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly minPassword = MIN_PASSWORD;

  /** Id de la sesión actual: marca "tú" y bloquea acciones sobre uno mismo. */
  protected readonly currentUserId = computed(() => this.tokens.user()?.id ?? null);

  constructor() {
    this.adminApi.loadUsers();
  }

  // ───────────────────────────── Crear cuenta ─────────────────────────────

  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  protected readonly createdName = signal<string | null>(null);
  protected readonly showCreate = signal(false);

  protected readonly createForm = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(3)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
    roles: this.fb.nonNullable.control<UserRole[]>([], [Validators.required]),
  });

  protected toggleCreate(): void {
    this.showCreate.update((open) => !open);
    this.createError.set(null);
    this.createForm.reset({ nombre: '', email: '', password: '', roles: [] });
  }

  protected toggleRole(role: UserRole): void {
    const control = this.createForm.controls.roles;
    const actuales = control.value;
    control.setValue(
      actuales.includes(role) ? actuales.filter((r) => r !== role) : [...actuales, role],
    );
    control.markAsDirty();
  }

  protected hasRole(role: UserRole): boolean {
    return this.createForm.controls.roles.value.includes(role);
  }

  /**
   * Sugiere una contraseña larga y aleatoria.
   *
   * Se genera con `crypto.getRandomValues`, no con `Math.random`: este valor
   * protege una cuenta del panel, y `Math.random` es predecible.
   */
  protected suggestPassword(): void {
    const alfabeto = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const clave = Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('');
    this.createForm.controls.password.setValue(clave);
    this.createForm.controls.password.markAsDirty();
  }

  protected create(): void {
    if (this.createForm.invalid || this.createForm.controls.roles.value.length === 0) {
      this.createForm.markAllAsTouched();
      this.createError.set('Completa los datos y asigna al menos un rol.');
      return;
    }

    this.createError.set(null);
    this.creating.set(true);
    const { nombre, email, password, roles } = this.createForm.getRawValue();

    this.adminApi.createUser({ nombre, email, password, roles }).subscribe({
      next: (creado) => {
        this.creating.set(false);
        this.showCreate.set(false);
        this.createdName.set(creado.nombre);
        this.createForm.reset({ nombre: '', email: '', password: '', roles: [] });
        setTimeout(() => this.createdName.set(null), 5000);
      },
      error: (error: ApiErrorBody) => {
        this.creating.set(false);
        this.createError.set(error.message);
      },
    });
  }

  // ─────────────────────── Contraseña de otra cuenta ───────────────────────

  protected readonly resettingId = signal<string | null>(null);
  protected readonly resetError = signal<string | null>(null);
  protected readonly resetDoneId = signal<string | null>(null);
  protected readonly savingId = signal<string | null>(null);

  protected readonly resetForm = this.fb.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
  });

  protected startReset(user: ApiUser): void {
    this.resettingId.set(user.id);
    this.editingId.set(null);
    this.resetError.set(null);
    this.resetDoneId.set(null);
    this.resetForm.reset({ password: '' });
  }

  // ────────────────────── Editar nombre, correo y roles ──────────────────────

  protected readonly editingId = signal<string | null>(null);
  protected readonly editDoneId = signal<string | null>(null);

  protected readonly editForm = this.fb.nonNullable.group({
    nombre: ['', [Validators.required, Validators.minLength(3)]],
    email: ['', [Validators.required, Validators.email]],
    roles: this.fb.nonNullable.control<UserRole[]>([], [Validators.required]),
  });

  protected startEdit(user: ApiUser): void {
    this.editingId.set(user.id);
    this.resettingId.set(null);
    this.resetError.set(null);
    this.editDoneId.set(null);
    this.editForm.setValue({
      nombre: user.nombre,
      email: user.email,
      roles: [...user.roles],
    });
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
  }

  protected toggleEditRole(role: UserRole): void {
    const control = this.editForm.controls.roles;
    const actuales = control.value;
    control.setValue(
      actuales.includes(role) ? actuales.filter((r) => r !== role) : [...actuales, role],
    );
    control.markAsDirty();
  }

  protected hasEditRole(role: UserRole): boolean {
    return this.editForm.controls.roles.value.includes(role);
  }

  /** Cambiar el correo cambia con qué se inicia sesión: conviene avisarlo. */
  protected emailCambia(user: ApiUser): boolean {
    return this.editForm.controls.email.value.trim().toLowerCase() !== user.email;
  }

  protected saveEdit(user: ApiUser): void {
    if (this.editForm.invalid || this.editForm.controls.roles.value.length === 0) {
      this.editForm.markAllAsTouched();
      this.resetError.set('Revisa los datos y deja al menos un rol asignado.');
      return;
    }

    this.resetError.set(null);
    this.savingId.set(user.id);
    const { nombre, email, roles } = this.editForm.getRawValue();

    // Solo se envía lo que cambió: así el servidor no rehace trabajo, y un
    // guardado sin cambios devuelve "sin-cambios" en vez de tocar la fila.
    const patch: { nombre?: string; email?: string; roles?: UserRole[] } = {};
    if (nombre.trim() !== user.nombre) patch.nombre = nombre.trim();
    if (email.trim().toLowerCase() !== user.email) patch.email = email.trim().toLowerCase();
    if (roles.join() !== [...user.roles].join()) patch.roles = roles;

    if (Object.keys(patch).length === 0) {
      this.savingId.set(null);
      this.editingId.set(null);
      return;
    }

    this.adminApi.updateUser(user.id, patch).subscribe({
      next: () => {
        this.savingId.set(null);
        this.editingId.set(null);
        this.editDoneId.set(user.id);
        setTimeout(() => this.editDoneId.set(null), 5000);
      },
      error: (error: ApiErrorBody) => {
        this.savingId.set(null);
        this.resetError.set(error.message);
      },
    });
  }

  protected cancelReset(): void {
    this.resettingId.set(null);
  }

  protected confirmReset(userId: string): void {
    if (this.resetForm.invalid) {
      this.resetForm.markAllAsTouched();
      return;
    }

    this.resetError.set(null);
    this.savingId.set(userId);

    this.adminApi.updateUser(userId, { password: this.resetForm.getRawValue().password }).subscribe({
      next: () => {
        this.savingId.set(null);
        this.resettingId.set(null);
        this.resetDoneId.set(userId);
        setTimeout(() => this.resetDoneId.set(null), 5000);
      },
      error: (error: ApiErrorBody) => {
        this.savingId.set(null);
        this.resetError.set(error.message);
      },
    });
  }

  /**
   * Da de alta o de baja una cuenta.
   *
   * No se borra: los pedidos guardan `aprobado_por` apuntando al usuario, y
   * borrarlo dejaría el historial sin saber quién aprobó qué. Desactivar
   * impide entrar y conserva la traza.
   */
  protected toggleActive(user: ApiUser): void {
    this.resetError.set(null);
    this.savingId.set(user.id);

    this.adminApi.updateUser(user.id, { activo: user.activo === 1 ? 0 : 1 }).subscribe({
      next: () => this.savingId.set(null),
      error: (error: ApiErrorBody) => {
        this.savingId.set(null);
        this.resetError.set(error.message);
      },
    });
  }

  // ──────────────────────── Contraseña propia ────────────────────────

  protected readonly showOwn = signal(false);
  protected readonly ownSaving = signal(false);
  protected readonly ownError = signal<string | null>(null);
  protected readonly ownDone = signal(false);

  protected readonly ownForm = this.fb.nonNullable.group({
    actual: ['', Validators.required],
    nueva: ['', [Validators.required, Validators.minLength(MIN_PASSWORD)]],
  });

  protected toggleOwn(): void {
    this.showOwn.update((open) => !open);
    this.ownError.set(null);
    this.ownDone.set(false);
    this.ownForm.reset({ actual: '', nueva: '' });
  }

  protected changeOwn(): void {
    if (this.ownForm.invalid) {
      this.ownForm.markAllAsTouched();
      return;
    }

    this.ownError.set(null);
    this.ownSaving.set(true);
    const { actual, nueva } = this.ownForm.getRawValue();

    this.adminApi.changeOwnPassword(actual, nueva).subscribe({
      next: () => {
        this.ownSaving.set(false);
        this.ownDone.set(true);
        this.showOwn.set(false);
        this.ownForm.reset({ actual: '', nueva: '' });
        setTimeout(() => this.ownDone.set(false), 5000);
      },
      error: (error: ApiErrorBody) => {
        this.ownSaving.set(false);
        this.ownError.set(error.message);
      },
    });
  }

  // ──────────────────────────────── Ayudas ────────────────────────────────

  protected roleLabel(role: UserRole): string {
    return ROLE_LABELS[role];
  }

  protected showCreateError(field: 'nombre' | 'email' | 'password'): boolean {
    const control = this.createForm.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  protected formatDate(iso: string): string {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
}
