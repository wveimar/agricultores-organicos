import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, Subject, of } from 'rxjs';
import { CatalogService } from './catalog.service';
import { ApiCategory, ApiClient, ApiProduct } from '../api/api-client';
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

function makeApiCategory(id: string, overrides: Partial<ApiCategory> = {}): ApiCategory {
  return {
    id,
    nombre: id,
    descripcion: '',
    icono: '',
    grupoAdmin: 'agroindustriales',
    orden: 100,
    activo: 1,
    actualizadoEn: '2026-01-01 00:00:00',
    ...overrides,
  };
}

/** Las diez que siembra la migración 0013, por nombre. */
const SEMBRADAS = [
  'verduras',
  'frutas',
  'lacteos',
  'mieles',
  'listos',
  'fermentos',
  'panaderia',
  'granos',
  'despensa',
  'canastas',
];

class ApiStub {
  productos: Observable<ApiProduct[]> = of([]);
  categorias: Observable<ApiCategory[]> = of([]);

  products(): Observable<ApiProduct[]> {
    return this.productos;
  }

  categories(): Observable<ApiCategory[]> {
    return this.categorias;
  }
}

/** El catálogo solo lee la sesión para el precio de mayorista y para recargar. */
class TokenStub {
  readonly roles = signal<readonly string[]>([]);
  readonly user = signal<{ id: string } | null>(null);
}

function inject_(api: ApiStub): CatalogService {
  TestBed.configureTestingModule({
    providers: [
      CatalogService,
      { provide: ApiClient, useValue: api },
      { provide: TokenStore, useValue: new TokenStub() },
    ],
  });
  return TestBed.inject(CatalogService);
}

/** Catálogo ya cargado, con las categorías que se le pasen (o las sembradas). */
function build(productos: ApiProduct[], categorias = SEMBRADAS): CatalogService {
  const api = new ApiStub();
  api.productos = of(productos);
  api.categorias = of(categorias.map((id) => makeApiCategory(id)));
  return inject_(api);
}

const ids = (catalog: CatalogService) => catalog.visibleCategories().map((c) => c.id);

describe('CatalogService · chips de categoría', () => {
  it('pone «Todo el huerto» delante, sin que sea una fila de la tabla', () => {
    const catalog = build([makeApiProduct({ categoriaId: 'verduras' })], ['verduras']);

    // 'todos' no se archiva ni se borra: es el filtro que significa "no filtres".
    expect(ids(catalog)).toEqual(['todos', 'verduras']);
  });

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
    // El caso que hace útil la tabla: se crea la sección desde el panel y la
    // vitrina la ofrece sola al archivar el primer producto, sin recompilar.
    const catalog = build([makeApiProduct({ id: 'p-pan', categoriaId: 'panaderia' })]);

    expect(ids(catalog)).toContain('panaderia');
  });

  it('respeta el orden que trae la tabla, no el alfabético', () => {
    const api = new ApiStub();
    api.productos = of([
      makeApiProduct({ id: 'p-1', categoriaId: 'zanahorias' }),
      makeApiProduct({ id: 'p-2', categoriaId: 'aguacates' }),
    ]);
    // Llegan como las manda el Worker: ya ordenadas por `orden`.
    api.categorias = of([
      makeApiCategory('zanahorias', { orden: 10 }),
      makeApiCategory('aguacates', { orden: 20 }),
    ]);

    expect(ids(inject_(api))).toEqual(['todos', 'zanahorias', 'aguacates']);
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
    api.productos = pendiente;
    api.categorias = of(SEMBRADAS.map((id) => makeApiCategory(id)));

    const catalog = inject_(api);

    // Sin contadores todavía: filtrar por ellos dejaría un solo chip.
    expect(catalog.loading()).toBe(true);
    expect(ids(catalog).length).toBe(SEMBRADAS.length + 1);

    pendiente.next([makeApiProduct({ id: 'p-1', categoriaId: 'verduras' })]);
    pendiente.complete();

    expect(ids(catalog)).toEqual(['todos', 'verduras']);
  });

  it('si la tabla de categorías falla, la tienda sigue en pie', () => {
    const api = new ApiStub();
    api.productos = of([makeApiProduct()]);
    api.categorias = new Observable((s) => s.error(new Error('500')));

    const catalog = inject_(api);

    // Sin chips se compra peor; sin productos no hay tienda. El fallo de una
    // no puede llevarse la otra por delante.
    expect(ids(catalog)).toEqual(['todos']);
    expect(catalog.visible().length).toBe(1);
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
