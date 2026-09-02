import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AdminApiService } from '../../../core/services/admin-api.service';
import { TokenStore } from '../../../core/api/token-store';
import { ApiErrorBody, ApiUser } from '../../../core/api/api-client';
import { CopPipe } from '../../../shared/pipes/cop.pipe';
import { FieldError, FieldErrorState } from '../../../shared/field-error/field-error';
import {
  ROLE_HINTS,
  ROLE_LABELS,
  STAFF_ROLES,
  UserRole,
  WHOLESALE_ROLES,
  isWholesaleOnly,
  isWholesaleRole,
} from '../../../core/models/user.model';

/** Mismo mínimo que exige el servidor. */
const MIN_PASSWORD = 8;

/**
 * Los roles se ofrecen en dos bloques, no en una lista de seis casillas
 * iguales.
 *
 * Conceder acceso al panel y ponerle tarifa de mayorista a un cliente son
 * decisiones de naturaleza opuesta —una abre pantallas, la otra cambia lo que
 * se cobra— y en una lista plana están a un clic de distancia. Separarlas es
 * lo que evita marcar «Administración general» queriendo marcar «Mayorista
 * Oro».
 */
const ROLE_GROUPS = [
  {
    key: 'panel' as const,
    title: 'Acceso al panel',
    hint: 'Personal de la cooperativa. Abre secciones de administración.',
    roles: STAFF_ROLES,
  },
  {
    key: 'mayorista' as const,
    title: 'Tarifa de mayorista',
    hint: 'Clientes. No abren ninguna sección: solo cambian el precio que pagan.',
    roles: WHOLESALE_ROLES,
  },
];

type UserFilter = 'todos' | 'panel' | 'mayoristas' | 'inactivos';

const USER_FILTERS: ReadonlyArray<{ value: UserFilter; label: string }> = [
  { value: 'todos', label: 'Todas' },
  { value: 'panel', label: 'Con acceso al panel' },
  { value: 'mayoristas', label: 'Clientes mayoristas' },
  { value: 'inactivos', label: 'Desactivadas' },
];

@Component({
  selector: 'app-users-manager',
  imports: [ReactiveFormsModule, CopPipe, FieldErrorState, FieldError],
  templateUrl: './users-manager.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersManager {
  protected readonly adminApi = inject(AdminApiService);
  private readonly tokens = inject(TokenStore);
  private readonly fb = inject(FormBuilder);

  protected readonly roleGroups = ROLE_GROUPS;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly roleHints = ROLE_HINTS;
  protected readonly filters = USER_FILTERS;
  protected readonly minPassword = MIN_PASSWORD;

  /** Id de la sesión actual: marca "tú" y bloquea acciones sobre uno mismo. */
  protected readonly currentUserId = computed(() => this.tokens.user()?.id ?? null);

  protected readonly filter = signal<UserFilter>('todos');
  protected readonly query = signal('');

  constructor() {
    this.adminApi.loadUsers();
    // Para el selector "Contacto enlazado" del formulario de edición.
    this.adminApi.loadContacts();
  }

  // ────────────────────────── Filtrado del listado ──────────────────────────

  /**
   * Con los mayoristas dentro, esta lista deja de ser "el equipo" y pasa a
   * mezclar dos poblaciones: quien administra y quien compra. El filtro es lo
   * que permite volver a ver una sola — sobre todo «Con acceso al panel», que
   * es la lista que hay que poder auditar de un vistazo.
   */
  protected readonly visibleUsers = computed<readonly ApiUser[]>(() => {
    const filtro = this.filter();
    const term = this.query().trim().toLowerCase();

    return this.adminApi.users().filter((user) => {
      if (filtro === 'mayoristas' && !isWholesaleOnly(user.roles)) {
        return false;
      }
      if (filtro === 'panel' && isWholesaleOnly(user.roles)) {
        return false;
      }
      if (filtro === 'inactivos' && user.activo === 1) {
        return false;
      }
      if (!term) {
        return true;
      }
      return (
        user.nombre.toLowerCase().includes(term) || user.email.toLowerCase().includes(term)
      );
    });
  });

  protected readonly countsByFilter = computed<Record<UserFilter, number>>(() => {
    const users = this.adminApi.users();
    const mayoristas = users.filter((u) => isWholesaleOnly(u.roles)).length;
    return {
      todos: users.length,
      panel: users.length - mayoristas,
      mayoristas,
      inactivos: users.filter((u) => u.activo !== 1).length,
    };
  });

  protected setFilter(value: UserFilter): void {
    this.filter.set(value);
    // Un panel abierto sobre una fila que el filtro va a ocultar se quedaría
    // editando algo que ya no se ve.
    this.editingId.set(null);
    this.resettingId.set(null);
  }

  protected isWholesaleOnly(user: ApiUser): boolean {
    return isWholesaleOnly(user.roles);
  }

  /** Distingue el sello de tarifa del de acceso: son cosas distintas. */
  protected isWholesaleRole(role: UserRole): boolean {
    return isWholesaleRole(role);
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
    // '' = sin enlazar. Sin validadores: es un campo opcional para todo el
    // mundo salvo para quien de verdad se le va a fiar.
    contactId: [''],
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
      contactId: user.contactId ?? '',
    });
  }

  /**
   * Contactos que se pueden ofrecer para enlazar a ESTA cuenta: clientes
   * activos que no estén ya enlazados a otra.
   *
   * El propio contacto de la cuenta que se está editando se incluye aunque
   * ya esté "en uso" — por ella misma — para que el selector lo siga
   * mostrando como elegido y no como si hubiera desaparecido.
   */
  protected readonly contactosDisponibles = computed(() => {
    const editandoId = this.editingId();
    const enUsoPorOtra = new Set(
      this.adminApi
        .users()
        .filter((u) => u.contactId && u.id !== editandoId)
        .map((u) => u.contactId as string),
    );

    return this.adminApi
      .contacts()
      .filter((c) => c.esCliente === 1 && c.activo === 1 && !enUsoPorOtra.has(c.id))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  });

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
    const { nombre, email, roles, contactId } = this.editForm.getRawValue();

    // Solo se envía lo que cambió: así el servidor no rehace trabajo, y un
    // guardado sin cambios devuelve "sin-cambios" en vez de tocar la fila.
    const patch: {
      nombre?: string;
      email?: string;
      roles?: UserRole[];
      contactId?: string | null;
    } = {};
    if (nombre.trim() !== user.nombre) patch.nombre = nombre.trim();
    if (email.trim().toLowerCase() !== user.email) patch.email = email.trim().toLowerCase();
    if (roles.join() !== [...user.roles].join()) patch.roles = roles;
    if ((contactId || null) !== user.contactId) patch.contactId = contactId || null;

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

  /**
   * Avisa cuando se está **concediendo** administración general.
   *
   * En la edición se compara contra lo que la cuenta ya tenía: repetir el aviso
   * cada vez que se abre un SUPER_ADMIN existente lo convertiría en ruido que
   * se ignora, y entonces no avisaría de nada el día que importa.
   *
   * No bloquea nada — es una decisión legítima. Solo obliga a leerla.
   */
  protected createGrantsSuperAdmin(): boolean {
    return this.createForm.controls.roles.value.includes('SUPER_ADMIN');
  }

  protected editGrantsSuperAdmin(user: ApiUser): boolean {
    return (
      this.editForm.controls.roles.value.includes('SUPER_ADMIN') &&
      !user.roles.includes('SUPER_ADMIN')
    );
  }

  /** Resumen de lo marcado, para el pie de cada bloque de casillas. */
  protected selectedSummary(roles: readonly UserRole[]): string {
    if (roles.length === 0) {
      return 'Sin roles: la cuenta no podrá entrar ni tendrá tarifa.';
    }
    const panel = roles.filter((r) => !isWholesaleRole(r));
    const tarifa = roles.filter(isWholesaleRole);

    const partes: string[] = [];
    if (panel.length > 0) {
      partes.push(`entra al panel (${panel.map((r) => ROLE_LABELS[r]).join(', ')})`);
    }
    if (tarifa.length > 0) {
      partes.push(`compra con ${tarifa.map((r) => ROLE_LABELS[r]).join(', ')}`);
    }
    return `Esta cuenta ${partes.join(' y ')}.`;
  }

  protected formatDate(iso: string): string {
    return new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('es-CO', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
}
