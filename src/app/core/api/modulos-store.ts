import { Injectable, signal } from '@angular/core';
import { ModuloKey, ModulosActivos } from './api-client';

/**
 * Qué módulos están encendidos en ESTA instalación — hermano de `TokenStore`,
 * pero para «qué existe» en vez de «quién es».
 *
 * Arranca en todo-encendido a propósito: es el estado de una instalación que
 * nunca ha tocado el panel de módulos, y es el mismo comportamiento que tenía
 * el sistema antes de que este interruptor existiera. `provideAppInitializer`
 * en `app.config.ts` la rellena con lo que de verdad diga el servidor antes
 * de que corra cualquier guard de ruta — ver ese archivo para el porqué.
 */
@Injectable({ providedIn: 'root' })
export class ModulosStore {
  private readonly modulos = signal<ModulosActivos>({
    pos: true,
    ecommerce: true,
    entregas: true,
    tesoreria: true,
  });

  readonly current = this.modulos.asReadonly();

  set(modulos: ModulosActivos): void {
    this.modulos.set(modulos);
  }

  /** ¿Están encendidos TODOS los módulos pedidos? Un guard de ruta que dependa de dos a la vez los pasa juntos. */
  isActive(...claves: readonly ModuloKey[]): boolean {
    const actual = this.modulos();
    return claves.every((clave) => actual[clave]);
  }
}
