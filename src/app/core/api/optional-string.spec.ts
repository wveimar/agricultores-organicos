import { optionalString, requireString } from '../../../../worker/src/http';

/**
 * El bug que este helper cierra ya se cometió tres veces en este proyecto:
 *
 *   · `categories.icono`      — un ícono vacío se rechazaba como obligatorio
 *   · `categories.descripcion`— la descripción «opcional» no lo era
 *   · `payments.nota`         — mismo caso, encontrado probando en el navegador
 *
 * Siempre por lo mismo: un `FormControl` NUNCA es `undefined`. Un formulario
 * reactivo manda la clave siempre, con `null` o `''` cuando está en blanco, y
 * una validación que solo contemple `undefined` la rechaza.
 *
 * Estas pruebas fijan las tres formas de «vacío» que llegan de un cliente HTTP.
 */
describe('optionalString', () => {
  it('trata como vacío las tres formas en que llega un campo en blanco', () => {
    // Ausente: nadie mandó la clave.
    expect(optionalString(undefined, 'nota')).toBeNull();
    // `null`: lo que manda un FormControl reseteado.
    expect(optionalString(null, 'nota')).toBeNull();
    // Cadena vacía: lo que manda un input de texto sin tocar.
    expect(optionalString('', 'nota')).toBeNull();
  });

  it('los espacios en blanco cuentan como vacío', () => {
    // Sin esto, teclear un espacio y borrarlo dejaría una nota de un carácter.
    expect(optionalString('   ', 'nota')).toBeNull();
  });

  it('devuelve el texto recortado cuando sí hay algo', () => {
    expect(optionalString('  pagó en la finca  ', 'nota')).toBe('pagó en la finca');
  });

  it('sigue rechazando lo que se pasa de largo', () => {
    // Opcional no significa «cualquier cosa»: el límite de la columna se
    // respeta igual.
    expect(() => optionalString('x'.repeat(201), 'nota', 200)).toThrow();
  });

  it('rechaza un tipo que no es texto', () => {
    // Un número o un objeto no son «vacío»: son un cliente mandando basura.
    expect(() => optionalString(42, 'nota')).toThrow();
    expect(() => optionalString({}, 'nota')).toThrow();
  });
});

describe('requireString · el contraste', () => {
  it('rechaza las tres formas de vacío, que es justo su trabajo', () => {
    // Se fija aquí para dejar clara la diferencia: un campo obligatorio SÍ
    // tiene que rechazar el blanco. El error era usarlo donde no tocaba.
    expect(() => requireString(undefined, 'nombre')).toThrow();
    expect(() => requireString(null, 'nombre')).toThrow();
    expect(() => requireString('', 'nombre')).toThrow();
    expect(() => requireString('   ', 'nombre')).toThrow();
  });

  it('acepta y recorta un valor real', () => {
    expect(requireString('  Panadería  ', 'nombre')).toBe('Panadería');
  });
});
