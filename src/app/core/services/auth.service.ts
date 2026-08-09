import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthUser, Session, UserRole, hasRole } from '../models/user.model';
import { KV_KEYS, KvStore } from './kv-store.service';

/**
 * ⚠️ ESTO NO ES SEGURIDAD. Es una simulación visual.
 *
 * El "JWT" que genera este servicio **no está firmado**: se construye en el
 * navegador y se guarda en `localStorage`, donde cualquier script del origen
 * puede leerlo o fabricar uno nuevo con el rol que quiera. Los guards de
 * Angular solo deciden qué se pinta; no protegen ningún dato.
 *
 * Para que esto sea seguridad de verdad hacen falta tres cosas, todas en el
 * servidor:
 *   1. Firmar el token en el backend (HS256/RS256) y **verificar la firma** en
 *      cada petición: es lo único que impide que alguien se invente un rol.
 *   2. Guardarlo en una cookie `HttpOnly` + `Secure` + `SameSite`, no en
 *      `localStorage`, para que un XSS no pueda robarlo.
 *   3. Autorizar **cada endpoint** por rol en el servidor. Un guard de
 *      frontend se salta escribiendo la URL a mano.
 *
 * Mientras no exista backend, trata este módulo como maquetación funcional.
 */

const SESSION_HOURS = 8;

/** Usuarios de demostración. En producción esto vive en la base de datos. */
interface DemoAccount {
  readonly password: string;
  readonly user: AuthUser;
}

const DEMO_ACCOUNTS: Readonly<Record<string, DemoAccount>> = {
  'inventario@agricultores.co': {
    password: 'demo1234',
    user: {
      id: 'u-01',
      name: 'Sara Villamil',
      email: 'inventario@agricultores.co',
      roles: ['ADMIN_INVENTARIO'],
    },
  },
  'pedidos@agricultores.co': {
    password: 'demo1234',
    user: {
      id: 'u-02',
      name: 'Diana Cardona',
      email: 'pedidos@agricultores.co',
      roles: ['GESTOR_PEDIDOS'],
    },
  },
  'admin@agricultores.co': {
    password: 'demo1234',
    user: {
      id: 'u-03',
      name: 'Nicolás Ruiz',
      email: 'admin@agricultores.co',
      roles: ['SUPER_ADMIN'],
    },
  },
};

export type LoginResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'credenciales' | 'captcha' };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly kv = inject(KvStore);

  private readonly session = signal<Session | null>(this.hydrate());

  readonly user = computed(() => this.session()?.user ?? null);
  readonly isAuthenticated = computed(() => this.session() !== null);
  readonly roles = computed<readonly UserRole[]>(() => this.user()?.roles ?? []);

  /** Cuentas de demo, para poder mostrarlas en la pantalla de login. */
  readonly demoAccounts = Object.entries(DEMO_ACCOUNTS).map(([email, account]) => ({
    email,
    password: account.password,
    name: account.user.name,
    roles: account.user.roles,
  }));

  constructor() {
    effect(() => {
      const current = this.session();
      if (current) {
        this.kv.put(KV_KEYS.session, current);
      } else {
        this.kv.delete(KV_KEYS.session);
      }
    });
  }

  can(...allowed: readonly UserRole[]): boolean {
    return hasRole(this.user(), ...allowed);
  }

  /**
   * `turnstileToken` llega del widget de Cloudflare. Aquí solo se comprueba
   * que exista: la validación real es una llamada servidor-a-servidor a
   * `siteverify` con la clave secreta, que nunca puede salir del backend.
   */
  login(email: string, password: string, turnstileToken: string | null): LoginResult {
    if (!turnstileToken) {
      return { ok: false, error: 'captcha' };
    }

    const account = DEMO_ACCOUNTS[email.trim().toLowerCase()];
    if (!account || account.password !== password) {
      return { ok: false, error: 'credenciales' };
    }

    const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
    this.session.set({
      user: account.user,
      token: this.fakeJwt(account.user, expiresAt),
      expiresAt,
    });

    return { ok: true };
  }

  logout(): void {
    this.session.set(null);
  }

  /**
   * Token con la **forma** de un JWT (tres partes en base64url) para que se
   * vea realista en devtools. La firma es una cadena fija: no criptografía.
   */
  private fakeJwt(user: AuthUser, expiresAt: number): string {
    const header = { alg: 'none', typ: 'JWT' };
    const payload = {
      sub: user.id,
      name: user.name,
      email: user.email,
      roles: user.roles,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(expiresAt / 1000),
    };
    return [
      base64Url(JSON.stringify(header)),
      base64Url(JSON.stringify(payload)),
      'firma-simulada-sin-valor',
    ].join('.');
  }

  /** Descarta la sesión guardada si caducó o si el JSON no tiene sentido. */
  private hydrate(): Session | null {
    const stored = this.kv.get<Session>(KV_KEYS.session);
    if (!stored?.user || typeof stored.expiresAt !== 'number') {
      return null;
    }
    if (stored.expiresAt <= Date.now()) {
      this.kv.delete(KV_KEYS.session);
      return null;
    }
    return stored;
  }
}

/** base64url de una cadena UTF-8 (btoa por sí solo se atraganta con acentos). */
function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
