import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { KV_KEYS, KvStore } from '../services/kv-store.service';
import { ROLE_LABELS, UserRole } from '../models/user.model';

export interface ApiSession {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly nombre: string;
    readonly roles: readonly UserRole[];
  };
}

/**
 * Guarda la sesión emitida por el backend.
 *
 * A diferencia del `AuthService` de la demo, este token **sí** está firmado por
 * el servidor: el navegador no puede fabricar uno válido sin `JWT_SECRET`.
 *
 * Sigue guardado en `localStorage`, que es accesible desde JavaScript. El
 * siguiente paso real en seguridad es que el backend lo emita como cookie
 * `HttpOnly` + `Secure` + `SameSite=Strict`, para que un XSS no pueda leerlo.
 */
@Injectable({ providedIn: 'root' })
export class TokenStore {
  private readonly kv = inject(KvStore);
  private readonly session = signal<ApiSession | null>(this.hydrate());

  readonly current = this.session.asReadonly();
  readonly token = computed(() => this.session()?.token ?? null);
  readonly user = computed(() => this.session()?.user ?? null);
  readonly isAuthenticated = computed(() => this.session() !== null);

  readonly roles = computed<readonly UserRole[]>(() => this.user()?.roles ?? []);

  readonly roleLabel = computed(() => this.roles().map((role) => ROLE_LABELS[role]).join(' · '));

  readonly initials = computed(() => {
    const name = this.user()?.nombre ?? '';
    return name
      .split(' ')
      .slice(0, 2)
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase();
  });

  constructor() {
    effect(() => {
      const session = this.session();
      if (session) {
        this.kv.put(KV_KEYS.apiSession, session);
      } else {
        this.kv.delete(KV_KEYS.apiSession);
      }
    });
  }

  set(session: ApiSession): void {
    this.session.set(session);
  }

  clear(): void {
    this.session.set(null);
  }

  /**
   * SUPER_ADMIN abre cualquier puerta; el resto necesita el rol exacto.
   * Es la misma regla que aplica `requireRole` en el Worker — la de aquí
   * decide qué se pinta, la del servidor decide qué se permite de verdad.
   */
  can(...allowed: readonly UserRole[]): boolean {
    const roles = this.roles();
    if (roles.includes('SUPER_ADMIN')) {
      return true;
    }
    return allowed.some((role) => roles.includes(role));
  }

  /** Descarta la sesión guardada si ya expiró, sin esperar a un 401. */
  private hydrate(): ApiSession | null {
    const stored = this.kv.get<ApiSession>(KV_KEYS.apiSession);
    if (!stored?.token || typeof stored.expiresAt !== 'number') {
      return null;
    }
    return stored.expiresAt > Date.now() ? stored : null;
  }
}
