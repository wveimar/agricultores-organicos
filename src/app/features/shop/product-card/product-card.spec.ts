import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ProductCard } from './product-card';
import { CartService } from '../../../core/services/cart.service';
import { CatalogService } from '../../../core/services/catalog.service';
import { KvStore } from '../../../core/services/kv-store.service';
import { Product } from '../../../core/models/product.model';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-test',
    slug: 'aguacate-hass',
    name: 'Aguacate Hass',
    tagline: 'Te llega en su punto exacto',
    categoryId: 'verduras',
    price: 4_900,
    costPrice: 3_800,
    unit: 'unidad',
    quantity: 1,
    featured: false,
    origin: 'Finca Los Nogales · Antioquia',
    rating: 4.8,
    reviewCount: 312,
    stock: 6,
    safetyStock: 2,
    image: 'https://example.test/aguacate.jpg',
    imageHover: 'https://example.test/aguacate-2.jpg',
    imageAlt: 'Mitad de aguacate con su hueso, sobre un fondo rosa liso',
    ...overrides,
  };
}

class CatalogStub {
  readonly loading = signal(false);
  /** La observa `CartService` al recargarse el catálogo. Ver el stub gemelo en checkout-page.spec. */
  readonly all = signal<readonly Product[]>([]);
  productById(): Product | undefined {
    return undefined;
  }
  /** Sin variantes: estas pruebas miran la tarjeta de un producto suelto. */
  getProductVariants(): readonly Product[] {
    return [];
  }
}

class KvStub {
  get<T>(): T | null {
    return null;
  }
  put(): void {
    /* no persiste en pruebas */
  }
}

describe('ProductCard · accesibilidad de la imagen', () => {
  let fixture: ComponentFixture<ProductCard>;

  function render(product: Product): HTMLElement {
    fixture = TestBed.createComponent(ProductCard);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CartService,
        { provide: CatalogService, useClass: CatalogStub },
        { provide: KvStore, useClass: KvStub },
      ],
    });
  });

  it('pinta el texto alternativo del producto en la imagen principal', () => {
    const product = makeProduct();

    const host = render(product);
    const principal = host.querySelector('img');

    expect(principal?.getAttribute('alt')).toBe(product.imageAlt);
  });

  it('nunca deja la imagen principal sin texto alternativo', () => {
    const host = render(makeProduct());
    const alt = host.querySelector('img')?.getAttribute('alt') ?? '';

    expect(alt.trim().length).toBeGreaterThan(0);
  });

  /**
   * La segunda imagen es puramente decorativa: aparece al pasar el ratón y
   * muestra el mismo producto. Debe llevar `alt=""` para que el lector de
   * pantalla la ignore; con un alt repetido, cada tarjeta se anunciaría dos
   * veces y navegar la vitrina sería insoportable.
   */
  it('deja la imagen de hover como decorativa, con alt vacío', () => {
    const host = render(makeProduct());
    const imagenes = Array.from(host.querySelectorAll('img'));

    expect(imagenes.length).toBe(2);
    expect(imagenes[1].getAttribute('alt')).toBe('');
  });

  it('no anuncia dos veces el mismo producto', () => {
    const host = render(makeProduct());
    const altsConTexto = Array.from(host.querySelectorAll('img'))
      .map((img) => img.getAttribute('alt') ?? '')
      .filter((alt) => alt.trim().length > 0);

    expect(altsConTexto.length).toBe(1);
  });

  it('respeta un texto alternativo distinto sin reescribirlo', () => {
    const product = makeProduct({ imageAlt: 'Racimo de bananos sobre fondo amarillo' });

    const host = render(product);

    expect(host.querySelector('img')?.getAttribute('alt')).toBe(
      'Racimo de bananos sobre fondo amarillo',
    );
  });

  /**
   * El tipo `Product` ya obliga a `imageAlt`, pero el dato llega de la API en
   * tiempo de ejecución y ahí TypeScript no protege. Esta prueba fija qué pasa
   * hoy si llega vacío —se pinta vacío— para que quede documentado que la
   * garantía real tiene que estar en el servidor y en el formulario del panel,
   * no en el componente.
   */
  it('con un alt vacío la imagen queda sin describir (la validación va antes)', () => {
    const host = render(makeProduct({ imageAlt: '' }));

    expect(host.querySelector('img')?.getAttribute('alt')).toBe('');
  });
});
