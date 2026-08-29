/**
 * Pruebas de la aritmética de una factura y de su ciclo de estados.
 *
 * Estas reglas viven repartidas entre SQL (`recalcularStatement`) y las
 * guardas de los endpoints, donde no se pueden probar sin levantar una base.
 * Aquí se reproducen como funciones puras y se fijan con casos: si mañana
 * alguien cambia la regla en el Worker, estas pruebas dicen exactamente qué
 * comportamiento se estaba dando por sentado.
 */

type EstadoFactura = 'emitida' | 'pagada_parcial' | 'pagada' | 'anulada';

/** Lo que hace `UPDATE invoices SET saldo = ...` tras cada abono. */
function saldoDe(total: number, cobrado: number): number {
  // MAX(0, ...): un abono de más no puede dejar el saldo en negativo, porque
  // eso significaría que la factura le debe al cliente — para eso está el
  // anticipo, que vive en el pago y no en la factura.
  return Math.max(0, total - cobrado);
}

/** Lo que hace el CASE del mismo UPDATE. */
function estadoDe(
  estadoActual: EstadoFactura,
  total: number,
  cobrado: number,
): EstadoFactura {
  if (estadoActual === 'anulada') {
    return 'anulada';
  }
  if (cobrado >= total) {
    return 'pagada';
  }
  if (cobrado > 0) {
    return 'pagada_parcial';
  }
  return 'emitida';
}

/** La guarda de `exigirModificable`: con dinero encima no se toca. */
function sePuedeModificar(estado: EstadoFactura, total: number, saldo: number): boolean {
  return estado !== 'anulada' && saldo === total;
}

/** El total que calcula el servidor a partir de las líneas. */
function totalDe(
  lineas: readonly { cantidad: number; precioUnitario: number }[],
  envio: number,
): { subtotal: number; total: number } {
  const subtotal = lineas.reduce(
    (suma, linea) => suma + linea.cantidad * linea.precioUnitario,
    0,
  );
  return { subtotal, total: subtotal + envio };
}

describe('Factura · saldo', () => {
  it('sin abonos, debe todo', () => {
    expect(saldoDe(45_000, 0)).toBe(45_000);
  });

  it('con un abono parcial, debe la diferencia', () => {
    expect(saldoDe(45_000, 20_000)).toBe(25_000);
  });

  it('cubierta exacta, queda en cero', () => {
    expect(saldoDe(45_000, 45_000)).toBe(0);
  });

  it('cobrada de más, NO queda en negativo', () => {
    // Un saldo negativo diría que la factura le debe al cliente. El sobrante
    // es anticipo y vive en el pago, no aquí.
    expect(saldoDe(45_000, 60_000)).toBe(0);
  });
});

describe('Factura · estado', () => {
  it('nace emitida', () => {
    expect(estadoDe('emitida', 45_000, 0)).toBe('emitida');
  });

  it('con un abono parcial pasa a pagada_parcial', () => {
    expect(estadoDe('emitida', 45_000, 20_000)).toBe('pagada_parcial');
  });

  it('cubierta pasa a pagada', () => {
    expect(estadoDe('pagada_parcial', 45_000, 45_000)).toBe('pagada');
  });

  it('vuelve a emitida si se deshace el único abono', () => {
    // Es lo que pasa al borrar un cobro: la deuda tiene que reaparecer entera.
    expect(estadoDe('pagada_parcial', 45_000, 0)).toBe('emitida');
  });

  it('una anulada sigue anulada haga lo que haga el dinero', () => {
    // Anulada es historia: ni un abono la resucita.
    expect(estadoDe('anulada', 45_000, 45_000)).toBe('anulada');
    expect(estadoDe('anulada', 45_000, 0)).toBe('anulada');
  });

  it('una factura en cero nace pagada, no emitida', () => {
    // Caso de borde real: una factura de cortesía por $0. Si se quedara en
    // 'emitida' aparecería para siempre en la cartera pidiendo un cobro de $0.
    expect(estadoDe('emitida', 0, 0)).toBe('pagada');
  });
});

describe('Factura · qué se puede modificar', () => {
  it('una recién emitida se edita y se borra', () => {
    expect(sePuedeModificar('emitida', 45_000, 45_000)).toBe(true);
  });

  it('una con abono parcial ya NO', () => {
    // Cambiarle el total dejaría el abono cobrado contra una cifra que ya no
    // existe; borrarla dejaría la plata en caja sin venta detrás.
    expect(sePuedeModificar('pagada_parcial', 45_000, 25_000)).toBe(false);
  });

  it('una pagada tampoco', () => {
    expect(sePuedeModificar('pagada', 45_000, 0)).toBe(false);
  });

  it('una anulada tampoco: reescribirla borraría el rastro', () => {
    expect(sePuedeModificar('anulada', 45_000, 0)).toBe(false);
  });
});

describe('Factura · total desde las líneas', () => {
  it('suma cantidad por precio', () => {
    expect(
      totalDe(
        [
          { cantidad: 3, precioUnitario: 4_000 },
          { cantidad: 1, precioUnitario: 1_500 },
        ],
        0,
      ),
    ).toEqual({ subtotal: 13_500, total: 13_500 });
  });

  it('el domicilio va aparte del subtotal', () => {
    // `envio` no es venta de producto: los informes lo cuentan separado desde
    // la migración 0019, y meterlo en el subtotal lo mezclaría con la fruta.
    expect(totalDe([{ cantidad: 2, precioUnitario: 5_000 }], 4_000)).toEqual({
      subtotal: 10_000,
      total: 14_000,
    });
  });

  it('sin líneas suma cero', () => {
    expect(totalDe([], 0)).toEqual({ subtotal: 0, total: 0 });
  });

  it('un precio en cero es válido: una cortesía se factura igual', () => {
    expect(totalDe([{ cantidad: 1, precioUnitario: 0 }], 0)).toEqual({
      subtotal: 0,
      total: 0,
    });
  });
});
