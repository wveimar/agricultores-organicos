# Agricultores Orgánicos

Tienda en línea de producto agrícola orgánico. Angular 22 con **standalone
components**, **signals** y **zoneless change detection**, estilada con
**Tailwind CSS v4** y preparada para **Cloudflare Pages**.

El plan de diseño (paleta, tipografías, arquitectura, interacciones y criterios
de accesibilidad) está en **[doc/plan.md](doc/plan.md)**.

> Entrega enfocada al 100 % en la capa visual y la UX. No hay backend, base de
> datos ni pasarela de pago: el catálogo es un mock tipado y el carrito vive en
> memoria.

---

## 1. Puesta en marcha

```bash
npm install
npm start           # http://localhost:4200
```

Otros comandos:

```bash
npm run build       # build de producción -> dist/agricultores-organicos/browser
npm run watch       # build incremental en modo desarrollo
npm test            # vitest
```

Requiere Node `^22.22.3 || ^24.15.0 || >=26` (fijado en `.nvmrc`).

### Cómo se generó el proyecto

```bash
npx @angular/cli@latest new agricultores-organicos \
  --directory . --style=css --ssr=false --routing \
  --package-manager=npm --skip-git --defaults

npm install -D tailwindcss @tailwindcss/postcss postcss
```

Tailwind v4 se activa con dos piezas, sin `tailwind.config.js`:

- **`.postcssrc.json`** registra el plugin `@tailwindcss/postcss`.
- **`src/styles.css`** hace `@import 'tailwindcss'` y declara los design tokens
  dentro de `@theme`. Cada token pasa a ser una utilidad automáticamente
  (`--color-moss` → `bg-moss`, `text-moss`, `border-moss`…).

---

## 2. Estructura

```
src/app/
├─ core/
│  ├─ models/        Product, Category, CartItem, SortOption…
│  ├─ data/          catalog-images.ts (fotos verificadas) + mock-catalog.ts
│  └─ services/      catalog.service.ts · cart.service.ts   (estado en signals)
├─ layout/           header/ (transparente → sólido al scroll) · footer/
├─ features/shop/    shop-page/ · hero/ · category-filter/ · product-grid/ · product-card/
└─ shared/           cart-drawer/ · pipes/cop.pipe.ts · directives/reveal.directive.ts
```

Todo el estado son signals. `CatalogService.visible` es un `computed` que aplica
categoría, búsqueda y orden: cambiar de filtro **no navega ni recarga**, solo
recalcula la señal y Angular repinta la rejilla.

### Conectar un backend más adelante

Toda la app depende únicamente de la interfaz `Product`. Basta con sustituir la
constante `PRODUCTS` de `core/data/mock-catalog.ts` por la respuesta de la API
(por ejemplo con `httpResource`) y ningún componente necesita cambios.

### Sobre las imágenes

Las fotos vienen de Unsplash sin API key. Los IDs están centralizados en
`core/data/catalog-images.ts` con **nombres que describen lo que la foto muestra
de verdad** — se verificaron uno a uno antes de asignarlos, porque el `imageAlt`
de cada producto depende de ello. Si cambias un ID, mira la imagen primero y
actualiza también el `alt`.

---

## 3. Despliegue en Cloudflare Pages

El build es **estático**: se sirve desde el edge sin runtime, que es lo que mejor
encaja con Pages para una tienda sin backend.

### Opción A — conectando el repositorio (recomendada)

En el panel de Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**,
y usa esta configuración:

| Campo | Valor |
|---|---|
| Framework preset | `Angular` (o `None`) |
| Build command | `npm run build` |
| Build output directory | `dist/agricultores-organicos/browser` |
| Root directory | `/` |
| Variable de entorno | `NODE_VERSION` = `22.22.3` |

Cada push a la rama de producción despliega automáticamente, y las demás ramas
generan preview deployments.

### Opción B — subida directa con Wrangler

```bash
npx wrangler login
npm run deploy        # build + wrangler pages deploy
```

Para probar en local exactamente lo que servirá Cloudflare (incluidos
`_redirects` y `_headers`):

```bash
npm run build
npm run preview
```

### Ficheros que hacen que el despliegue funcione

Ambos viven en `public/`, así que el builder de Angular los copia tal cual a la
raíz de la salida.

- **`public/_redirects`** — `/*  /index.html  200`.
  Es **imprescindible**: Angular resuelve las rutas en el navegador, así que sin
  esta regla cualquier entrada directa a una URL profunda (o un F5 sobre ella)
  devolvería 404 porque Cloudflare buscaría un fichero con ese nombre. El `200`
  reescribe sin redirigir, conservando la URL en la barra.

- **`public/_headers`** — caché inmutable de un año para los assets con hash
  (`main-A1B2C3.js`) y `must-revalidate` para `index.html`, que no lleva hash y
  si se cacheara dejaría a los usuarios pidiendo bundles viejos tras cada
  despliegue. Incluye además `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options` y `Permissions-Policy`.

### Si algún día hiciera falta SSR

`ng add @angular/ssr` y desplegar sobre Cloudflare Workers con el adaptador
correspondiente. Hoy no aporta nada: sin backend y con un catálogo estático, el
build estático es más rápido y más barato.

---

## 4. Estado de la entrega

**Hecho** — header adaptativo, hero compacto, filtros client-side con contadores,
rejilla responsive 1→2→3→4 columnas, tarjeta con cross-fade e "Añadir" emergente,
carrito lateral con envío gratis progresivo, banda editorial, newsletter, footer,
accesibilidad (foco visible, `role="dialog"`, `aria-live`, `alt` reales,
`prefers-reduced-motion`) y despliegue configurado.

**Verificado** en navegador a 1440×900 y 390×844: build de producción sin errores
de consola, precios alineados en la rejilla, hover, filtrado y totales del
carrito correctos (57.800 + 9.900 = 67.700).

**Pendiente** (siguiente iteración) — checkout y pagos, autenticación, página de
detalle de producto, buscador con backend, i18n y analítica.
