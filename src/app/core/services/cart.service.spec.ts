import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CartService } from './cart.service';
import { CatalogService } from './catalog.service';
import { KvStore } from './kv-store.service';
import { FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../models/cart.model';
import { Product } from '../models/product.model';

/**
 * Producto mínimo para las pruebas. Solo importan `stock` y `price`; el resto
 * son valores válidos para satisfacer el tipo.
 */
function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-test',
    slug: 'producto-de-prueba',
    name: 'Producto de prueba',
    tagline: '',
    categoryId: 'verduras',
    price: 10_000,
    costPrice: 6_000,
    unit: 'kg',
    quantity: 1,
    featured: false,
    origin: 'Finca QA',
    rating: 4.5,
    reviewCount: 10,
    stock: 5,
    safetyStock: 2,
    image: 'https://example.test/foto.jpg',
    imageAlt: 'Descripción de la foto',
    ...overrides,
  };
}

/**
 * `CartService` hidrata desde `KvStore` en cuanto el catálogo deja de cargar,
 * así que el doble expone `loading` en `false` y un `productById` que resuelve
 * contra lo que cada prueba haya registrado.
 */
class CatalogStub {
  readonly loading = signal(false);
  private readonly byId = new Map<string, Product>();

  register(product: Product): void {
    this.byId.set(product.id, product);
  }

  productById(id: string): Product | undefined {
    return this.byId.get(id);
  }
}

class KvStub {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): T | null {
    return (this.data.get(key) as T) ?? null;
  }

  put(key: string, value: unknown): void {
    this.data.set(key, value);
  }
}

describe('CartService', () => {
  let cart: CartService;
  let catalog: CatalogStub;

  beforeEach(() => {
    catalog = new CatalogStub();

    TestBed.configureTestingModule({
      providers: [
        CartService,
        { provide: CatalogService, useValue: catalog },
        { provide: KvStore, useClass: KvStub },
      ],
    });

    cart = TestBed.inject(CartService);
  });

  describe('tope de stock', () => {
    it('no añade más unidades de las que hay en bodega', () => {
      const producto = makeProduct({ stock: 6 });

      cart.add(producto, 50);

      expect(cart.quantityOf(producto.id)).toBe(6);
    });

    it('no pasa del tope sumando de uno en uno', () => {
      const producto = makeProduct({ stock: 2 });

      cart.add(producto);
      cart.add(producto);
      cart.add(producto);

      expect(cart.quantityOf(producto.id)).toBe(2);
    });

    it('ignora por completo un producto agotado', () => {
      const producto = makeProduct({ stock: 0 });

      cart.add(producto);

      expect(cart.isEmpty()).toBe(true);
    });

    it('recorta `setQuantity` al stock disponible', () => {
      const producto = makeProduct({ stock: 4 });
      cart.add(producto);

      cart.setQuantity(producto.id, 99);

      expect(cart.quantityOf(producto.id)).toBe(4);
    });

    it('elimina la línea cuando la cantidad baja a cero', () => {
      const producto = makeProduct({ stock: 4 });
      cart.add(producto);

      cart.setQuantity(producto.id, 0);

      expect(cart.isEmpty()).toBe(true);
    });

    it('marca la línea que ya está en el tope', () => {
      const producto = makeProduct({ stock: 3 });

      cart.add(producto, 3);

      expect(cart.atStockLimit(producto.id)).toBe(true);
    });

    it('no marca el tope cuando todavía queda stock', () => {
      const producto = makeProduct({ stock: 3 });

      cart.add(producto, 1);

      expect(cart.atStockLimit(producto.id)).toBe(false);
    });
  });

  describe('envío gratis', () => {
    /**
     * El umbral se lee de la constante en vez de escribirlo a mano: si alguien
     * lo cambia, estas pruebas siguen midiendo la regla y no un número viejo.
     * La única que fija el valor es la de abajo, y está puesta a propósito para
     * que un cambio de precio de envío sea una decisión y no un descuido.
     */
    it('el umbral vigente es de 70.000 COP', () => {
      expect(FREE_SHIPPING_THRESHOLD).toBe(70_000);
    });

    it('cobra el envío justo por debajo del umbral', () => {
      const producto = makeProduct({ price: FREE_SHIPPING_THRESHOLD - 1, stock: 10 });

      cart.add(producto);

      expect(cart.subtotal()).toBe(FREE_SHIPPING_THRESHOLD - 1);
      expect(cart.shipping()).toBe(SHIPPING_COST);
    });

    it('no cobra el envío justo al alcanzar el umbral', () => {
      const producto = makeProduct({ price: FREE_SHIPPING_THRESHOLD, stock: 10 });

      cart.add(producto);

      expect(cart.shipping()).toBe(0);
    });

    it('no cobra el envío por encima del umbral', () => {
      const producto = makeProduct({ price: FREE_SHIPPING_THRESHOLD + 5_000, stock: 10 });

      cart.add(producto);

      expect(cart.shipping()).toBe(0);
    });

    it('no cobra envío sobre un carrito vacío', () => {
      expect(cart.isEmpty()).toBe(true);
      expect(cart.shipping()).toBe(0);
      expect(cart.total()).toBe(0);
    });

    it('el total suma subtotal y envío', () => {
      const producto = makeProduct({ price: 10_000, stock: 10 });

      cart.add(producto, 2);

      expect(cart.subtotal()).toBe(20_000);
      expect(cart.total()).toBe(20_000 + SHIPPING_COST);
    });

    it('informa cuánto falta para el envío gratis', () => {
      const producto = makeProduct({ price: 40_000, stock: 10 });

      cart.add(producto);

      expect(cart.amountToFreeShipping()).toBe(FREE_SHIPPING_THRESHOLD - 40_000);
    });

    it('deja de faltar nada al superar el umbral', () => {
      const producto = makeProduct({ price: FREE_SHIPPING_THRESHOLD + 1, stock: 10 });

      cart.add(producto);

      expect(cart.amountToFreeShipping()).toBe(0);
      expect(cart.freeShippingProgress()).toBe(1);
    });
  });

  describe('cuentas del carrito', () => {
    it('suma las unidades de todas las líneas', () => {
      cart.add(makeProduct({ id: 'p-1', stock: 10 }), 2);
      cart.add(makeProduct({ id: 'p-2', stock: 10 }), 3);

      expect(cart.count()).toBe(5);
    });

    it('el dinero se mantiene en enteros de pesos', () => {
      const producto = makeProduct({ price: 8_900, stock: 10 });

      cart.add(producto, 3);

      expect(cart.subtotal()).toBe(26_700);
      expect(Number.isInteger(cart.subtotal())).toBe(true);
      expect(Number.isInteger(cart.total())).toBe(true);
    });

    it('quita una línea sin tocar las demás', () => {
      cart.add(makeProduct({ id: 'p-1', stock: 10 }), 2);
      cart.add(makeProduct({ id: 'p-2', stock: 10 }), 1);

      cart.remove('p-1');

      expect(cart.quantityOf('p-1')).toBe(0);
      expect(cart.quantityOf('p-2')).toBe(1);
    });

    it('vacía el carrito por completo', () => {
      cart.add(makeProduct({ stock: 10 }), 2);

      cart.clear();

      expect(cart.isEmpty()).toBe(true);
      expect(cart.count()).toBe(0);
    });
  });
});
