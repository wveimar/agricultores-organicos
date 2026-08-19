import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { CreateProduct } from './create-product';
import { AdminApiService } from '../../../core/services/admin-api.service';

/**
 * El formulario de crear producto es más largo que la pantalla y su botón vive
 * al final. Un campo obligatorio que falla sin decirlo deja el botón mudo: se
 * pulsa, no pasa nada, y no hay nada en pantalla que explique por qué.
 *
 * Es lo que pasaba al añadir una variante — `precioCosto` era obligatorio y no
 * pintaba ningún mensaje.
 */

class AdminApiStub {
  readonly categories = signal([]);
  readonly selectableCategories = signal([]);
  readonly products = signal([]);

  loadProducts = () => {};
  loadCategories = () => {};
  possibleParents = () => [];
  variantsOf = () => [];
  productById = () => undefined;
  categoryById = () => undefined;
  createProduct = () => of({});
}

// jsdom no trae `scrollIntoView`. El componente lo usa para llevar el cursor
// al campo que falta, así que sin esto la prueba fallaría por el entorno y no
// por lo que mide.
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

function build(): CreateProduct {
  // Se levanta un componente por caso, y hay casos que recorren varios campos
  // en un bucle: sin reiniciar, el segundo choca con el módulo ya instanciado.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: AdminApiService, useClass: AdminApiStub }],
  });
  return TestBed.createComponent(CreateProduct).componentInstance;
}

/** Todo relleno y válido; cada prueba estropea justo lo que le interesa. */
function rellenar(c: CreateProduct): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).form.patchValue({
    nombre: 'Banano de Vereda · 500 gr',
    categoriaId: 'frutas',
    grupoAdmin: 'frutas',
    precio: 6000,
    precioCosto: 3000,
    unidad: 'gramo',
    cantidadUnidad: 500,
    origen: 'Vereda El Salado',
    imagen: 'https://example.test/banano.jpg',
    imagenAlt: 'Racimo de bananos amarillos',
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const form = (c: CreateProduct) => (c as any).form;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enviar = (c: CreateProduct) => (c as any).createProduct();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const faltante = (c: CreateProduct) => (c as any).faltante;

describe('CreateProduct · el botón nunca queda mudo', () => {
  it('con todo relleno, envía', () => {
    const c = build();
    rellenar(c);

    expect(form(c).valid).toBe(true);
    enviar(c);
    expect(faltante(c)).toBeNull();
  });

  it('nombra el precio de costo cuando se deja vacío', () => {
    const c = build();
    rellenar(c);
    // Vaciar un <input type="number"> deja el control en null, no en 0.
    form(c).controls.precioCosto.setValue(null);

    enviar(c);

    // El fallo original: inválido y sin una palabra en pantalla.
    expect(form(c).invalid).toBe(true);
    expect(faltante(c)).toContain('costo');
  });

  it('nombra cada campo obligatorio que falte, no solo los que pintan error', () => {
    const obligatorios: readonly [string, string][] = [
      ['nombre', 'nombre'],
      ['categoriaId', 'categoría'],
      ['precio', 'precio de venta'],
      ['precioCosto', 'precio de costo'],
      ['cantidadUnidad', 'cantidad'],
      ['origen', 'origen'],
      ['imagen', 'imagen principal'],
      ['imagenAlt', 'texto alternativo'],
    ];

    for (const [control, esperado] of obligatorios) {
      const c = build();
      rellenar(c);
      form(c).controls[control].setValue(null);

      enviar(c);

      expect(form(c).invalid).toBe(true);
      // Que ninguno pueda bloquear el envío sin decir su nombre.
      expect(faltante(c)).toContain(esperado);
    }
  });

  it('reclama el primero que se lee, no uno cualquiera del medio', () => {
    const c = build();
    rellenar(c);
    form(c).controls.nombre.setValue('');
    form(c).controls.origen.setValue('');

    enviar(c);

    // Mandar a alguien al final del formulario cuando lo que falta está
    // arriba lo obliga a recorrerlo dos veces.
    expect(faltante(c)).toContain('nombre');
  });

  it('deja de reclamar en cuanto se arregla', () => {
    const c = build();
    rellenar(c);
    form(c).controls.precioCosto.setValue(null);
    enviar(c);
    expect(faltante(c)).not.toBeNull();

    form(c).controls.precioCosto.setValue(0);
    enviar(c);

    // Un costo de 0 es legítimo: hay producto que no lleva costo cargado.
    expect(faltante(c)).toBeNull();
  });
});
