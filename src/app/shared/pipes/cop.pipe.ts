import { Pipe, PipeTransform } from '@angular/core';

/**
 * Formatea pesos colombianos sin decimales: 9800 → "$ 9.800".
 * Usa Intl directamente para no depender de datos de locale registrados.
 */
@Pipe({ name: 'cop' })
export class CopPipe implements PipeTransform {
  private static readonly formatter = new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });

  transform(value: number): string {
    return CopPipe.formatter.format(value);
  }
}
