import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, Subject, of } from 'rxjs';
import { CatalogService } from './catalog.service';
import { ApiClient, ApiProduct } from '../api/api-client';
import { TokenStore } from '../api/token-store';

/** Fila de la API con lo mínimo válido; cada prueba pisa lo que le importa. */
function makeApiProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id: 'p-test',
    slug: 'producto-de-prueba',
    nombre: 'Producto de prueba',
    tagline: '',
    categoriaId: 'verduras',
    grupoAdmin: 'verduras',
    precio: 10_000,
    precioAnterior: null,
    unidad: 'kg',
    cantidadUnidad: 1,
    origen: 'Finca QA',
    rating: 4.5,
    reviewCount: 10,
    badge: null,
    destacado: 0,
    stock: 5,
    imagen: 'https://example.test/foto.jpg',
    imagenHover: null,
    imagenAlt: 'Descripción de la foto',
    parentId: null,
    varianteEtiqueta: null,
    ...overrides,
  };
}

class ApiStub {
  /** Lo que devolverá la próxima llamada a `products()`. */
  respuesta: Observable<ApiProduct[]> = of([]);

  products(): Observable<ApiProduct[]> {
    return this.respuesta;
  }
}

/** El catálogo solo lee la sesión para el precio de mayorista y para recargar. */
class TokenStub {
  readonly roles = signal<readonly string[]>([]);
  readonly user = signal<{ id: string } | null>(null);
}

function build(productos: ApiProduct[]): CatalogService {
  const api = new ApiStub();
  api.respuesta = of(productos);

  TestBed.configureTestingModule({
    providers: [
      CatalogService,
      { provide: ApiClient, useValue: api },
      { provide: TokenStore, useValue: new TokenStub() },
    ],
  });

  return TestBed.inject(CatalogService);
}

const ids = (catalog: CatalogService) => catalog.visibleCategories().map((c) => c.id);

describe('CatalogService · chips de categoría', () => {
  it('esconde las categorías sin un solo producto', () => {
    const catalog = build([
      makeApiProduct({ id: 'p-1', categoriaId: 'verduras' }),
      makeApiProduct({ id: 'p-2', categoriaId: 'frutas' }),
    ]);

    expect(ids(catalog)).toEqual(['todos', 'verduras', 'frutas']);
    // Un pasillo anunciado y vacío es peor que no anunciarlo.
    expect(ids(catalog)).not.toContain('panaderia');
  });

  it('deja aparecer una categoría nueva en cuanto llega su primer producto', () => {
    // «Panadería» ya está declarada en el código sin ningún pan sembrado: es
    // el caso que permite preparar la sección antes que el producto.
    const catalog = build([makeApiProduct({ id: 'p-pan', categoriaId: 'panaderia' })]);

    expect(ids(catalog)).toContain('panaderia');
  });

  it('conserva la categoría activa aunque se quede sin productos', () => {
    const catalog = build([makeApiProduct({ id: 'p-1', categoriaId: 'verduras' })]);
    catalog.selectCategory('canastas');

    // Que el chip donde estás parado desaparezca bajo el dedo es peor que
    // verlo en 0: quedarías mirando una rejilla vacía sin saber por qué.
    expect(ids(catalog)).toContain('canastas');
  });

  it('las pinta todas mientras el catálogo está cargando', () => {
    const api = new ApiStub();
    const pendiente = new Subject<ApiProduct[]>();
    api.respuesta = pendiente;

    TestBed.configureTestingModule({
      providers: [
        CatalogService,
        { provide: ApiClient, useValue: api },
        { provide: TokenStore, useValue: new TokenStub() },
      ],
    });
    const catalog = TestBed.inject(CatalogService);

    // Sin contadores todavía: filtrar por ellos dejaría un solo chip.
    expect(catalog.loading()).toBe(true);
    expect(ids(catalog).length).toBe(catalog.categories.length);

    pendiente.next([makeApiProduct({ id: 'p-1', categoriaId: 'verduras' })]);
    pendiente.complete();

    expect(ids(catalog)).toEqual(['todos', 'verduras']);
  });

  it('cuenta tarjetas y no filas: las variantes no inflan el contador', () => {
    const catalog = build([
      makeApiProduct({ id: 'p-miel', categoriaId: 'mieles' }),
      makeApiProduct({ id: 'p-miel-300', categoriaId: 'mieles', parentId: 'p-miel' }),
      makeApiProduct({ id: 'p-miel-500', categoriaId: 'mieles', parentId: 'p-miel' }),
    ]);

    // Tres filas, una sola tarjeta en la vitrina.
    expect(catalog.counts()['mieles']).toBe(1);
  });
});

describe('CatalogService · isFiltering', () => {
  it('es falso con la vitrina entera a la vista', () => {
    const catalog = build([makeApiProduct()]);

    expect(catalog.isFiltering()).toBe(false);
  });

  it('es cierto con una categoría elegida', () => {
    const catalog = build([makeApiProduct()]);
    catalog.selectCategory('verduras');

    expect(catalog.isFiltering()).toBe(true);
  });

  it('es cierto con algo escrito en el buscador', () => {
    const catalog = build([makeApiProduct()]);
    catalog.setQuery('mango');

    expect(catalog.isFiltering()).toBe(true);
  });

  it('no se activa con espacios sueltos', () => {
    const catalog = build([makeApiProduct()]);
    catalog.setQuery('   ');

    // `visible` también los ignora: si esto contara como filtro, los más
    // vendidos desaparecerían sin que nadie hubiera buscado nada.
    expect(catalog.isFiltering()).toBe(false);
  });
});
