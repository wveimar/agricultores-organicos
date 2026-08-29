import {
  DeudaAbierta,
  repartirPorAntiguedad,
  validarReparto,
} from '../../../../worker/src/allocation';

/**
 * Pruebas del reparto de abonos.
 *
 * Viven aquí y no junto al archivo porque el runner del proyecto (`ng test`)
 * solo mira dentro de `src/`. El código bajo prueba es del Worker y se importa
 * por ruta relativa: es aritmética pura, sin `env.DB` ni globales de Workers,
 * así que corre igual en el entorno del navegador que usa vitest.
 */

function deuda(id: string, saldo: number, emitidaEn: string): DeudaAbierta {
  return { id, saldo, emitidaEn };
}

describe('repartirPorAntiguedad', () => {
  it('cubre una sola deuda exacta', () => {
    const { repartos, anticipo } = repartirPorAntiguedad(45_000, [
      deuda('f1', 45_000, '2026-01-01'),
    ]);

    expect(repartos).toEqual([{ invoiceId: 'f1', monto: 45_000 }]);
    expect(anticipo).toBe(0);
  });

  it('abona parcialmente cuando no alcanza', () => {
    // El caso que motivó el módulo entero: de $45.000 entran $20.000.
    const { repartos, anticipo } = repartirPorAntiguedad(20_000, [
      deuda('f1', 45_000, '2026-01-01'),
    ]);

    expect(repartos).toEqual([{ invoiceId: 'f1', monto: 20_000 }]);
    expect(anticipo).toBe(0);
  });

  it('reparte un pago entre varias facturas, de la más vieja a la más nueva', () => {
    // El restaurante que paga la semana entera de una vez.
    const { repartos, anticipo } = repartirPorAntiguedad(100_000, [
      deuda('nueva', 50_000, '2026-03-10'),
      deuda('vieja', 45_000, '2026-01-05'),
      deuda('media', 30_000, '2026-02-01'),
    ]);

    expect(repartos).toEqual([
      { invoiceId: 'vieja', monto: 45_000 },
      { invoiceId: 'media', monto: 30_000 },
      { invoiceId: 'nueva', monto: 25_000 },
    ]);
    expect(anticipo).toBe(0);
  });

  it('lo que sobra queda como anticipo y no infla la última factura', () => {
    const { repartos, anticipo } = repartirPorAntiguedad(60_000, [
      deuda('f1', 45_000, '2026-01-01'),
    ]);

    // Pagar de más una factura no significa nada: el resto es saldo a favor.
    expect(repartos).toEqual([{ invoiceId: 'f1', monto: 45_000 }]);
    expect(anticipo).toBe(15_000);
  });

  it('sin deudas, todo es anticipo', () => {
    const { repartos, anticipo } = repartirPorAntiguedad(30_000, []);

    expect(repartos).toEqual([]);
    expect(anticipo).toBe(30_000);
  });

  it('ignora las facturas ya saldadas', () => {
    const { repartos } = repartirPorAntiguedad(10_000, [
      deuda('saldada', 0, '2026-01-01'),
      deuda('viva', 10_000, '2026-02-01'),
    ]);

    expect(repartos).toEqual([{ invoiceId: 'viva', monto: 10_000 }]);
  });

  it('desempata por id cuando dos facturas son del mismo día', () => {
    // Sin criterio de desempate el reparto dependería del orden en que la
    // base devolviera las filas, y dos cobros iguales darían resultados
    // distintos sin que nada hubiera cambiado.
    const { repartos } = repartirPorAntiguedad(15_000, [
      deuda('f-b', 10_000, '2026-01-01'),
      deuda('f-a', 10_000, '2026-01-01'),
    ]);

    expect(repartos).toEqual([
      { invoiceId: 'f-a', monto: 10_000 },
      { invoiceId: 'f-b', monto: 5_000 },
    ]);
  });

  it('un monto de cero o negativo no reparte nada', () => {
    expect(repartirPorAntiguedad(0, [deuda('f1', 10_000, '2026-01-01')])).toEqual({
      repartos: [],
      anticipo: 0,
    });
    expect(repartirPorAntiguedad(-500, [deuda('f1', 10_000, '2026-01-01')])).toEqual({
      repartos: [],
      anticipo: 0,
    });
  });

  it('no reordena el array que recibe', () => {
    const deudas = [deuda('nueva', 10_000, '2026-05-01'), deuda('vieja', 10_000, '2026-01-01')];
    repartirPorAntiguedad(20_000, deudas);

    expect(deudas.map((d) => d.id)).toEqual(['nueva', 'vieja']);
  });

  it('nunca reparte más de lo que entró', () => {
    const { repartos, anticipo } = repartirPorAntiguedad(70_000, [
      deuda('f1', 45_000, '2026-01-01'),
      deuda('f2', 45_000, '2026-02-01'),
    ]);

    const sumado = repartos.reduce((total, r) => total + r.monto, 0);
    expect(sumado + anticipo).toBe(70_000);
  });
});

describe('validarReparto', () => {
  const deudas = [deuda('f1', 45_000, '2026-01-01'), deuda('f2', 30_000, '2026-02-01')];

  it('acepta un reparto correcto', () => {
    expect(
      validarReparto(50_000, [
        { invoiceId: 'f1', monto: 20_000 },
        { invoiceId: 'f2', monto: 30_000 },
      ], deudas),
    ).toBeNull();
  });

  it('acepta dejar parte sin repartir: eso es un anticipo', () => {
    expect(validarReparto(50_000, [{ invoiceId: 'f1', monto: 20_000 }], deudas)).toBeNull();
  });

  it('rechaza repartir sobre una factura que no es del cliente', () => {
    const fallo = validarReparto(10_000, [{ invoiceId: 'ajena', monto: 10_000 }], deudas);
    expect(fallo).toContain('ajena');
  });

  it('rechaza abonar más de lo que debe una factura', () => {
    const fallo = validarReparto(90_000, [{ invoiceId: 'f2', monto: 50_000 }], deudas);
    expect(fallo).toContain('30000');
  });

  it('rechaza un reparto que suma más que el pago', () => {
    // Es la invariante que no cabe en un CHECK de SQLite, así que si falla
    // aquí se cuela hasta la base: un pago repartiría más plata de la que entró.
    const fallo = validarReparto(30_000, [
      { invoiceId: 'f1', monto: 20_000 },
      { invoiceId: 'f2', monto: 20_000 },
    ], deudas);

    expect(fallo).toContain('40000');
  });

  it('rechaza líneas en cero o negativas', () => {
    expect(validarReparto(10_000, [{ invoiceId: 'f1', monto: 0 }], deudas)).not.toBeNull();
    expect(validarReparto(10_000, [{ invoiceId: 'f1', monto: -5 }], deudas)).not.toBeNull();
  });
});
