import { Injectable } from '@angular/core';

/** Prefijo de namespace: evita chocar con otras apps del mismo origen. */
const NS = 'agro';

/**
 * Versión del esquema persistido. Súbela cuando cambie la forma de los datos
 * guardados: las entradas con versión distinta se descartan y el store vuelve
 * a sembrarse, en vez de hidratar objetos con campos que ya no existen.
 */
const SCHEMA_VERSION = 2;

interface Envelope<T> {
  readonly v: number;
  readonly data: T;
}

/**
 * Almacén clave-valor sobre `localStorage`, con la forma de la API de
 * **Cloudflare KV** (`get` / `put` / `delete` / `list`) para que sustituirlo
 * más adelante sea un cambio localizado.
 *
 * ⚠️ Diferencia importante al migrar: **KV real es asíncrono**. Estos métodos
 * son síncronos porque `localStorage` lo es. Cuando esto pase a un Worker,
 * los métodos devolverán `Promise` y la hidratación del store tendrá que
 * moverse a un `APP_INITIALIZER` o a un resolver de ruta.
 *
 * Tampoco es un sitio seguro para nada sensible: cualquier script del origen
 * puede leerlo. Sirve para preferencias y datos de demo, no para secretos.
 */
@Injectable({ providedIn: 'root' })
export class KvStore {
  private readonly available = this.probe();

  get<T>(key: string): T | null {
    if (!this.available) {
      return null;
    }
    try {
      const raw = localStorage.getItem(this.fullKey(key));
      if (!raw) {
        return null;
      }
      const envelope = JSON.parse(raw) as Envelope<T>;
      // Datos de una versión anterior del esquema: se ignoran a propósito.
      if (envelope?.v !== SCHEMA_VERSION) {
        return null;
      }
      return envelope.data;
    } catch {
      // JSON corrupto o storage bloqueado: se comporta como "no hay nada".
      return null;
    }
  }

  put<T>(key: string, data: T): void {
    if (!this.available) {
      return;
    }
    try {
      const envelope: Envelope<T> = { v: SCHEMA_VERSION, data };
      localStorage.setItem(this.fullKey(key), JSON.stringify(envelope));
    } catch {
      // Cuota llena o modo privado: perder la persistencia no debe tumbar la app.
    }
  }

  delete(key: string): void {
    if (!this.available) {
      return;
    }
    try {
      localStorage.removeItem(this.fullKey(key));
    } catch {
      /* mismo criterio que en put() */
    }
  }

  /** Claves del namespace, ya sin prefijo. */
  list(): string[] {
    if (!this.available) {
      return [];
    }
    const prefix = `${NS}:`;
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  private fullKey(key: string): string {
    return `${NS}:${key}`;
  }

  /**
   * Safari en modo privado y algunas políticas de empresa exponen
   * `localStorage` pero lanzan al escribir. Se comprueba una vez al arrancar.
   */
  private probe(): boolean {
    try {
      if (typeof localStorage === 'undefined') {
        return false;
      }
      const probeKey = `${NS}:__probe__`;
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }
}

export const KV_KEYS = {
  inventory: 'inventory',
  orders: 'orders',
  session: 'session',
} as const;
