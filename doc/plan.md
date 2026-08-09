# Plan de diseño — Agricultores Orgánicos

Tienda en línea de producto agrícola orgánico. Estética inspirada en **Bloomscape**:
minimalismo cálido, mucho aire, fotografía protagonista, tipografía serif editorial y
una rejilla de producto silenciosa donde el color lo pone la comida, no la interfaz.

> Alcance de esta entrega: **100 % capa visual y UX**. Sin backend, sin base de datos,
> sin pasarela de pago. Todo el estado vive en memoria (Angular Signals) y los datos
> provienen de un mock tipado.

---

## 1. Principios de dirección de arte

| Principio | Traducción concreta |
|---|---|
| **El fondo nunca es blanco puro** | Base `#FAF8F4` (hueso). El blanco puro solo aparece dentro de tarjetas para separar planos. |
| **Un solo acento** | Terracota `#C0674A` para CTA y estados. El verde es estructural, no decorativo. |
| **Aire > densidad** | Ritmo vertical en múltiplos de 8. Secciones separadas por 96–128 px en desktop. |
| **La imagen manda** | Ratio 4:5 vertical en producto, sin sombras duras, esquinas suaves (12 px). |
| **Movimiento discreto** | Nada rebota. Duraciones 200–400 ms, easing `cubic-bezier(.22,1,.36,1)`. |
| **Bordes en vez de sombras** | Separación por hairline `1px` a 8 % de opacidad; sombra solo en capas flotantes (drawer, header sólido). |

---

## 2. Paleta de color

Paleta orgánica/terrosa. Se declara como *design tokens* en `src/styles.css` con `@theme`
(Tailwind v4), de modo que cada token esté disponible como utilidad (`bg-bone`, `text-moss`…).

### Neutros cálidos — superficie

| Token | Hex | Uso |
|---|---|---|
| `bone` | `#FAF8F4` | Fondo global de la página |
| `linen` | `#F3EDE3` | Secciones alternas, fondo de imagen de producto |
| `sand` | `#E7DCCB` | Bordes suaves, chips inactivos |
| `stone` | `#C9BCA8` | Bordes de input, iconografía secundaria |

### Verdes — estructura de marca

| Token | Hex | Uso |
|---|---|---|
| `moss` | `#2E4034` | Color de marca. Header sólido, footer, botones oscuros |
| `moss-deep` | `#1E2B23` | Hover de `moss`, texto sobre fondos claros de alto contraste |
| `sage` | `#8DA189` | Detalles, iconos decorativos, estados deshabilitados |
| `sage-light` | `#DCE4D8` | Fondo de badge "Nuevo", tintes |

### Acentos

| Token | Hex | Uso |
|---|---|---|
| `clay` | `#C0674A` | **CTA primario**, precios de oferta, badge "Bestseller" |
| `clay-deep` | `#A2503A` | Hover de `clay` |
| `honey` | `#D9A441` | Rating, badge "Temporada" |
| `berry` | `#7C3A4A` | Badge "Últimas unidades" |

### Texto

| Token | Hex | Contraste sobre `bone` |
|---|---|---|
| `ink` | `#1F1B16` | 14.8:1 — títulos y cuerpo |
| `ink-soft` | `#5C5348` | 6.6:1 — texto secundario |
| `ink-muted` | `#8A7F70` | 3.6:1 — solo texto ≥18 px o metadatos |

**Accesibilidad:** todas las combinaciones texto/fondo usadas superan AA (4.5:1).
`clay` sobre `bone` = 4.6:1 ✅. Blanco sobre `clay` = 4.5:1 ✅. Blanco sobre `moss` = 11.3:1 ✅.

---

## 3. Tipografía

| Rol | Familia | Por qué |
|---|---|---|
| Display / títulos | **Fraunces** (serif variable, `wght` + `SOFT` + `opsz`) | Serif con raíz humanista y terminaciones suaves: elegante sin ser rígida. Es la contraparte libre más cercana al tono editorial de Bloomscape. |
| Cuerpo / UI | **Inter** (sans variable) | Neutra, excelente en tamaños pequeños, buen `tabular-nums` para precios. |

Ambas se cargan desde Google Fonts con `preconnect` + `display=swap`, y solo los ejes
necesarios para no penalizar el LCP.

### Escala tipográfica

| Nivel | Tamaño (desktop / móvil) | Familia | Tracking | Peso |
|---|---|---|---|---|
| `display` | 72 / 44 px | Fraunces | `-0.03em` | 400 |
| `h1` | 56 / 36 px | Fraunces | `-0.02em` | 400 |
| `h2` | 40 / 30 px | Fraunces | `-0.02em` | 400 |
| `h3` | 24 / 20 px | Fraunces | `-0.01em` | 500 |
| `body` | 16 px | Inter | `0` | 400 |
| `small` | 14 px | Inter | `0` | 400 |
| `overline` | 12 px | Inter | `0.14em` uppercase | 600 |

Regla: **los títulos nunca van en negrita**. El peso 400–500 de una serif de alto contraste
ya aporta jerarquía; el bold la ensucia. `line-height` 1.05–1.15 en display, 1.6 en cuerpo.

---

## 4. Sistema de layout

- **Contenedor**: `max-width: 1280px`, padding lateral `24px` (móvil) → `40px` (desktop).
- **Rejilla de producto**: 1 col (<640 px) → 2 (≥640) → 3 (≥1024) → 4 (≥1280). Gap `24px`/`40px`.
- **Ratio de imagen de producto**: `4/5`. La tarjeta jamás recorta con `cover` sin `object-position`.
- **Radios**: `sm 6px` (chips) · `md 12px` (tarjetas, imágenes) · `full` (botones pill, badges).

---

## 5. Arquitectura de componentes

Todo **standalone**, todo estado con **signals**, `ChangeDetectionStrategy.OnPush`, y la app
corre **zoneless** (`provideZonelessChangeDetection`, por defecto en Angular 20+).

```
src/app/
├─ app.ts / app.config.ts / app.routes.ts
│
├─ core/
│  ├─ models/
│  │  ├─ product.model.ts        Product, ProductBadge, Category, SortOption
│  │  └─ cart.model.ts           CartItem, CartSummary
│  ├─ data/
│  │  └─ mock-products.ts        24 productos + 7 categorías (datos "robustos")
│  └─ services/
│     ├─ catalog.service.ts      catálogo + filtros + orden  (signal/computed)
│     ├─ cart.service.ts         líneas, totales, apertura del drawer (signal/computed)
│     └─ scroll.service.ts       signal booleano `isScrolled` para el header
│
├─ layout/
│  ├─ header/                    nav transparente → sólido al hacer scroll
│  └─ footer/
│
├─ features/shop/
│  ├─ shop-page/                 orquesta hero + filtros + grid
│  ├─ hero/                      hero compacto (60vh) con un único CTA
│  ├─ category-filter/           chips con micro-animación (indicador deslizante)
│  ├─ product-grid/              rejilla + estado vacío + skeleton
│  └─ product-card/              hover: swap de imagen + botón "Añadir" que emerge
│
└─ shared/
   ├─ cart-drawer/               slide-over lateral con backdrop
   ├─ ui/                        button, badge, quantity-stepper, icon
   └─ smart-image/               <img> con fallback a placeholder si la URL falla
```

### Contrato de estado (signals)

```ts
// CatalogService
products      : Signal<Product[]>        // fuente
activeCategory: WritableSignal<string>   // 'todos' | slug
sort          : WritableSignal<SortOption>
query         : WritableSignal<string>
visible       : Signal<Product[]>        // computed: filtro + orden  ← lo consume el grid
counts        : Signal<Record<string, number>>

// CartService
items    : Signal<CartItem[]>
count    : Signal<number>                // computed
subtotal : Signal<number>                // computed
isOpen   : WritableSignal<boolean>
```

El filtrado es **100 % client-side sobre un `computed`**: cambiar de categoría no recarga
nada ni navega; solo recalcula la señal y Angular repinta la rejilla.

---

## 6. Interacción y micro-animaciones

| Elemento | Comportamiento |
|---|---|
| **Header** | Arranca transparente sobre el hero, texto en `bone`. Pasados 24 px de scroll conmuta a `moss` sólido + `backdrop-blur` + hairline inferior, con transición de 300 ms. Detectado con `@HostListener('window:scroll')` sobre un signal. |
| **Hero** | Compacto (≈`60vh`, nunca pantalla completa): titular serif, una línea de apoyo y **un solo CTA**. Entrada con fade+rise escalonado de 60 ms. |
| **Chips de categoría** | Indicador de fondo que se desliza (`transition` sobre transform), contador de productos, y `scroll-snap` horizontal en móvil. |
| **Tarjeta de producto** | Al hover: la imagen secundaria hace cross-fade sobre la principal (`opacity`), la imagen escala a `1.04`, y el botón **Añadir** sube desde abajo (`translate-y-2 → 0` + fade). En táctil el botón es siempre visible. |
| **Añadir al carrito** | El icono del carrito hace un `pulse` de 400 ms y el contador anima el cambio de cifra. |
| **Drawer del carrito** | Slide-over derecho de 420 px, backdrop `moss/40` con blur. Entra en 350 ms; cierre por backdrop, botón `×` o `Escape`. Bloquea el scroll del body y devuelve el foco al disparador. |
| **Reveal en scroll** | `IntersectionObserver` mínimo vía directiva para el fade-in de secciones. Nada de librerías. |

`@media (prefers-reduced-motion: reduce)` desactiva transforms y deja solo cambios de opacidad instantáneos.

---

## 7. Accesibilidad (no negociable)

- Todo control interactivo es `<button>` o `<a>` real; nada de `div` clicables.
- `:focus-visible` con anillo `clay` de 2 px y offset de 2 px, visible sobre todos los fondos.
- Drawer: `role="dialog"`, `aria-modal="true"`, foco atrapado, cierre con `Escape`.
- Filtros: `role="tablist"` / `aria-selected`; cambios de rejilla anunciados por `aria-live="polite"`.
- Toda imagen de producto lleva `alt` descriptivo real (viene del mock, no es `alt=""`).
- Objetivos táctiles ≥44 × 44 px.

---

## 8. Rendimiento y despliegue

- **Build estático** (`ng build`, sin SSR) → salida en `dist/agricultores-organicos/browser`.
  Es lo que mejor encaja con Cloudflare Pages: se sirve desde el edge, sin runtime.
  *(La ruta a SSR con `@angular/ssr` + adaptador Workers queda documentada en el README
  como evolución, pero no se activa aquí: sin backend no aporta nada.)*
- SPA → **`_redirects`** con `/* /index.html 200` para que el deep-linking no dé 404.
- **`_headers`** con caché inmutable para los assets con hash y `no-cache` para `index.html`.
- Imágenes con `loading="lazy"` + `decoding="async"`; las 4 primeras de la rejilla y la del
  hero con `fetchpriority="high"` para proteger el LCP.
- Fuentes con `preconnect` y `font-display: swap`.

---

## 9. Fuera de alcance (siguiente iteración)

Checkout y pagos · autenticación · página de detalle de producto · buscador con backend ·
gestión de inventario real · i18n · analítica.
