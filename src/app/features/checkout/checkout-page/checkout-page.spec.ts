import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { CheckoutPage } from './checkout-page';
import { CartService } from '../../../core/services/cart.service';
import { CheckoutService } from '../../../core/services/checkout.service';
import { CatalogService } from '../../../core/services/catalog.service';
import { KV_KEYS, KvStore } from '../../../core/services/kv-store.service';
import { Product } from '../../../core/models/product.model';

function makeProduct(): Product {
  return {
    id: 'p-test',
    slug: 'aguacate-hass',
    name: 'Aguacate Hass',
    tagline: '',
    categoryId: 'verduras',
    price: 4_900,
    costPrice: 3_800,
    unit: 'unidad',
    quantity: 1,
    featured: false,
    origin: 'Finca QA',
    rating: 4.8,
    reviewCount: 10,
    stock: 10,
    safetyStock: 2,
    image: 'https://example.test/foto.jpg',
    imageAlt: 'Un aguacate partido por la mitad',
  };
}

class CatalogStub {
  readonly loading = signal(false);
  productById(id: string): Product | undefined {
    return id === 'p-test' ? makeProduct() : undefined;
  }
}

/**
 * El carrito se siembra desde aquí, no llamando a `cart.add()` antes de crear
 * el componente: `CartService` hidrata desde `KvStore` en su primer efecto y
 * sobrescribiría cualquier línea añadida a mano. Sembrando el almacén se
 * ejercita además el camino real de rehidratación.
 */
class KvStub {
  get<T>(key: string): T | null {
    return key === KV_KEYS.cart ? ([{ productId: 'p-test', quantity: 2 }] as T) : null;
  }
  put(): void {
    /* sin persistencia en pruebas */
  }
}

/** Doble del checkout: solo hace falta que el carrito no esté vacío. */
class CheckoutStub {
  readonly step = signal<'datos' | 'exito'>('datos');
  readonly placedOrder = signal(null);
  readonly subtotal = signal(50_000);
  readonly shipping = signal(9_900);
  readonly total = signal(59_900);
  placeOrder = () => of({ id: 'o-1' });
  setProof = () => undefined;
}

/**
 * El proyecto es zoneless, así que `fakeAsync`/`tick` no están disponibles:
 * dependen de zone.js. El foco tras un envío fallido se mueve en un
 * `setTimeout`, y esperar un turno real del bucle de eventos es la forma de
 * darle tiempo sin simular relojes.
 */
const esperarTurno = () => new Promise<void>((resolver) => setTimeout(resolver));

describe('CheckoutPage · foco y accesibilidad', () => {
  let fixture: ComponentFixture<CheckoutPage>;
  let host: HTMLElement;
  let cart: CartService;

  const input = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CartService,
        { provide: CatalogService, useClass: CatalogStub },
        { provide: KvStore, useClass: KvStub },
        { provide: CheckoutService, useClass: CheckoutStub },
      ],
    });

    cart = TestBed.inject(CartService);

    fixture = TestBed.createComponent(CheckoutPage);
    host = fixture.nativeElement as HTMLElement;

    // El componente vive en el documento: sin esto `document.activeElement`
    // nunca apunta a sus campos y las pruebas de foco no medirían nada.
    document.body.appendChild(host);
    fixture.detectChanges();
  });

  afterEach(() => host.remove());

  describe('al llegar a la página', () => {
    it('lleva el foco al primer campo, no al pie', () => {
      expect(document.activeElement).toBe(input('nombre'));
    });
  });

  describe('atributos de accesibilidad', () => {
    it('marca los tres campos como obligatorios', () => {
      for (const id of ['nombre', 'telefono', 'direccion']) {
        expect(input(id).getAttribute('aria-required')).toBe('true');
      }
    });

    it('no marca nada como inválido antes de intentar enviar', () => {
      for (const id of ['nombre', 'telefono', 'direccion']) {
        expect(input(id).getAttribute('aria-invalid')).toBe('false');
      }
    });

    it('cada campo tiene su etiqueta asociada', () => {
      for (const id of ['nombre', 'telefono', 'direccion']) {
        const label = host.querySelector(`label[for="${id}"]`);
        expect(label).not.toBeNull();
        expect(label!.textContent!.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('al enviar con el formulario incompleto', () => {
    function enviar() {
      host.querySelector('form')!.dispatchEvent(new Event('submit'));
      fixture.detectChanges();
    }

    it('devuelve el foco al primer campo con error', async () => {
      input('telefono').focus();
      enviar();
      await esperarTurno();

      expect(document.activeElement).toBe(input('nombre'));
    });

    it('salta al primer campo que falta, no siempre al primero', async () => {
      const componente = fixture.componentInstance as unknown as {
        form: { patchValue: (v: Record<string, string>) => void };
      };
      componente.form.patchValue({ name: 'Marcela Ospina' });
      fixture.detectChanges();

      enviar();
      await esperarTurno();

      expect(document.activeElement).toBe(input('telefono'));
    });

    it('marca aria-invalid en los campos que fallan', () => {
      enviar();

      expect(input('nombre').getAttribute('aria-invalid')).toBe('true');
      expect(input('telefono').getAttribute('aria-invalid')).toBe('true');
    });

    /**
     * Sin `aria-describedby`, el lector de pantalla anuncia el campo como
     * inválido pero no dice por qué: el usuario sabe que algo está mal y no
     * qué corregir.
     */
    it('enlaza cada campo con el texto que explica su error', () => {
      enviar();

      const descrito = input('nombre').getAttribute('aria-describedby');
      expect(descrito).toBe('error-nombre');

      const mensaje = host.querySelector(`#${descrito}`);
      expect(mensaje).not.toBeNull();
      expect(mensaje!.textContent!.trim().length).toBeGreaterThan(0);
    });

    it('anuncia el resumen en una región viva', () => {
      enviar();

      const alerta = host.querySelector('[role="alert"]');
      expect(alerta).not.toBeNull();
      expect(alerta!.textContent).toContain('Faltan 3 datos');
    });

    it('lista los campos que faltan, con un atajo a cada uno', async () => {
      enviar();
      // Se espera a que el foco automático del envío se asiente antes de
      // pulsar el atajo: en uso real median segundos, y sin esta espera el
      // `setTimeout` pendiente se lo llevaría de vuelta al primer campo.
      await esperarTurno();

      const atajos = Array.from(
        host.querySelectorAll<HTMLButtonElement>('[role="alert"] button'),
      );
      expect(atajos.length).toBe(3);

      atajos[2].click();
      await esperarTurno();
      expect(document.activeElement).toBe(input('direccion'));
    });

    it('no envía el pedido si el formulario está incompleto', () => {
      const checkout = TestBed.inject(CheckoutService) as unknown as CheckoutStub;
      let llamado = false;
      checkout.placeOrder = () => {
        llamado = true;
        return of({ id: 'o-1' });
      };

      enviar();

      expect(llamado).toBe(false);
    });
  });

  describe('al completar los datos', () => {
    it('limpia el resumen de errores y envía', async () => {
      const form = host.querySelector('form')!;

      form.dispatchEvent(new Event('submit'));
      fixture.detectChanges();
      expect(host.querySelector('[role="alert"]')).not.toBeNull();

      const componente = fixture.componentInstance as unknown as {
        form: { patchValue: (v: Record<string, string>) => void };
      };
      componente.form.patchValue({
        name: 'Marcela Ospina',
        phone: '300 214 5588',
        address: 'Calle 127 # 15-40, Medellín',
      });
      fixture.detectChanges();

      form.dispatchEvent(new Event('submit'));
      await esperarTurno();
      fixture.detectChanges();

      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
