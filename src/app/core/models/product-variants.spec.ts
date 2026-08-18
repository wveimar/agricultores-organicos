import {
  Product,
  pluralizeVariantLabel,
  summarizeVariants,
} from './product.model';

function makeVariant(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-miel-500',
    slug: 'miel-500',
    name: 'Miel de Abejas · 500 gr',
    tagline: 'El tamaño que más sale',
    categoryId: 'mieles',
    price: 24_000,
    costPrice: 14_800,
    unit: 'gr',
    quantity: 500,
    featured: false,
    origin: 'Apiario Flor de Monte · Cauca',
    rating: 4.9,
    reviewCount: 96,
    stock: 18,
    safetyStock: 6,
    image: 'https://example.test/miel.jpg',
    imageAlt: 'Frasco de miel de abejas',
    parentId: 'p-miel-base',
    ...overrides,
  };
}

/** Las tres presentaciones de la miel: precios distintos, stock distinto. */
const presentaciones = [
  makeVariant({ id: 'p-300', price: 16_000, quantity: 300, stock: 24 }),
  makeVariant({ id: 'p-500', price: 24_000, quantity: 500, stock: 18 }),
  makeVariant({ id: 'p-1000', price: 45_000, quantity: 1000, stock: 9 }),
];

describe('summarizeVariants', () => {
  it('sin variantes devuelve null, y la tarjeta se comporta como siempre', () => {
    expect(summarizeVariants([])).toBeNull();
  });

  it('suma el inventario de todas: la madre no tiene stock propio', () => {
    expect(summarizeVariants(presentaciones)?.stock).toBe(51);
  });

  it('el precio de la ficha es el de la presentación más barata', () => {
    const resumen = summarizeVariants(presentaciones);

    expect(resumen?.fromPrice).toBe(16_000);
    expect(resumen?.toPrice).toBe(45_000);
    expect(resumen?.samePrice).toBe(false);
  });

  /**
   * Los tres sabores de kambucha valen lo mismo. Ahí un «Desde $12.000»
   * sugeriría que alguno cuesta más, así que `samePrice` le dice a la tarjeta
   * que se calle esa palabra.
   */
  it('con todas al mismo precio marca samePrice y no hay rango', () => {
    const sabores = [
      makeVariant({ id: 'k-1', name: 'Kambucha · Jamaica', price: 12_000 }),
      makeVariant({ id: 'k-2', name: 'Kambucha · Lulada', price: 12_000 }),
      makeVariant({ id: 'k-3', name: 'Kambucha · Mango', price: 12_000 }),
    ];

    const resumen = summarizeVariants(sabores);

    expect(resumen?.samePrice).toBe(true);
    expect(resumen?.fromPrice).toBe(12_000);
    expect(resumen?.toPrice).toBe(12_000);
  });

  /**
   * Lo importante de todo el archivo: con el tarro barato agotado, anunciar
   * «Desde $16.000» manda al cliente a un precio que no puede pagar.
   */
  it('el rango ignora lo agotado: anuncia el precio que sí se puede pagar', () => {
    const conAgotado = [
      makeVariant({ id: 'p-300', price: 16_000, stock: 0 }),
      makeVariant({ id: 'p-500', price: 24_000, stock: 18 }),
      makeVariant({ id: 'p-1000', price: 45_000, stock: 9 }),
    ];

    const resumen = summarizeVariants(conAgotado);

    expect(resumen?.fromPrice).toBe(24_000);
    expect(resumen?.stock).toBe(27);
  });

  /**
   * Sin ninguna disponible la ficha ya sale con el velo de "Agotado" encima;
   * la cifra se sigue calculando sobre todas para no dejarla en blanco debajo.
   */
  it('sin ninguna disponible usa todas, y el stock queda en 0', () => {
    const agotadas = presentaciones.map((variant) => ({ ...variant, stock: 0 }));

    const resumen = summarizeVariants(agotadas);

    expect(resumen?.stock).toBe(0);
    expect(resumen?.fromPrice).toBe(16_000);
    expect(resumen?.count).toBe(3);
  });
});

describe('pluralizeVariantLabel', () => {
  it('deja la palabra en singular cuando solo hay una', () => {
    expect(pluralizeVariantLabel('presentación', 1)).toBe('presentación');
  });

  it('«presentación» pierde la tilde al pluralizar', () => {
    expect(pluralizeVariantLabel('presentación', 3)).toBe('presentaciones');
  });

  it('las terminadas en consonante llevan -es', () => {
    expect(pluralizeVariantLabel('sabor', 3)).toBe('sabores');
  });

  it('las terminadas en vocal llevan -s', () => {
    expect(pluralizeVariantLabel('tamaño', 2)).toBe('tamaños');
    expect(pluralizeVariantLabel('corte', 2)).toBe('cortes');
  });

  it('lo que ya está en plural se queda como está', () => {
    expect(pluralizeVariantLabel('gramos', 3)).toBe('gramos');
  });
});
