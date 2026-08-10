# Agricultores Orgánicos

Tienda en línea de producto agrícola orgánico. Angular 22 con **standalone
components**, **signals** y **zoneless change detection**, estilada con
**Tailwind CSS v4** y preparada para **Cloudflare Pages**.

El plan de diseño (paleta, tipografías, arquitectura, interacciones y criterios
de accesibilidad) está en **[doc/plan.md](doc/plan.md)**.

> **Alcance real, para no llevarte a engaño:** el **panel administrativo**
> (`/admin`) habla con un backend de verdad — Cloudflare Worker + D1, JWT
> firmado por el servidor, RBAC exigido en cada endpoint. La **tienda pública,
> el carrito y el checkout** siguen siendo una demo funcional sobre
> `localStorage`, sin pasarela de pago. El porqué de esta frontera y cómo
> levantar el backend están en la **[sección 3](#3-backend-worker--d1)**.

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

### Conectar la tienda pública al backend

El panel admin ya habla con la API real (ver sección 3). La tienda pública
todavía no: `CatalogService` sigue leyendo de `AdminStoreService`, que vive en
`localStorage`. Toda la app depende únicamente de la interfaz `Product`, así
que conectarla es sustituir esa lectura por `ApiClient.products()` — el mismo
cliente HTTP que ya usa el panel — sin tocar ningún componente de la vitrina.
No se hizo en esta entrega porque el checkout (subida de comprobante, enlace de
WhatsApp) está diseñado sobre ese mismo estado local y migrarlo es un cambio
de alcance aparte.

### Sobre las imágenes

Las fotos vienen de Unsplash sin API key. Los IDs están centralizados en
`core/data/catalog-images.ts` con **nombres que describen lo que la foto muestra
de verdad** — se verificaron uno a uno antes de asignarlos, porque el `imageAlt`
de cada producto depende de ello. Si cambias un ID, mira la imagen primero y
actualiza también el `alt`.

---

## 3. Backend: Worker + D1

`worker/` es un Cloudflare Worker en TypeScript que corre en el **mismo**
proyecto que sirve la SPA (ver `run_worker_first: ["/api/*"]` en
`wrangler.jsonc`): en producción no hay CORS ni un segundo dominio que
mantener, solo rutas `/api/*` atendidas por el Worker y todo lo demás servido
como asset estático.

```
worker/
├─ schema.sql              Esquema D1: products, users, orders, order_items, cash_closings
├─ seed.sql                Generado — no editar a mano (ver más abajo)
├─ tools/
│  ├─ generate-seed.mjs    Reconstruye seed.sql desde el catálogo/pedidos del frontend
│  └─ resolve-ts.mjs       Hook de Node para poder importar los .ts de Angular tal cual
└─ src/
   ├─ index.ts             Router: switch método+ruta, sin framework
   ├─ types.ts             Env, JwtPayload, tipos compartidos
   ├─ http.ts               ApiError, json(), readJson(), validadores
   ├─ auth/
   │  ├─ crypto.ts          JWT HS256 + PBKDF2-SHA256 (WebCrypto, sin dependencias)
   │  └─ middleware.ts      requireAuth() / requireRole()
   └─ routes/
      ├─ auth.ts            POST /api/auth/login · GET /api/auth/me
      ├─ products.ts        Catálogo público + inventario admin + recálculo ABC
      ├─ orders.ts          Alta de pedido y aprobación transaccional
      └─ reports.ts         Ventas por producto (ABC en SQL) + cierre de caja
```

### Arrancar el backend en local

```bash
npm run db:schema     # crea las tablas en D1 local (SQLite embebido de Wrangler)
npm run db:seed       # siembra 3 usuarios, 25 productos y 6 pedidos de ejemplo
# o ambos de una vez:
npm run db:reset

npm run worker:dev     # wrangler dev --local --port 8788 → sirve API + build ya hecho
```

`worker:dev` sirve **el build que ya exista** en `dist/`, no lo genera. Corre
`npm run build` (o dejarlo en watch con `npm run watch`) en otra terminal si
vas a tocar el frontend a la vez.

Para desarrollar el frontend con recarga en caliente contra este backend:

```bash
npm start              # ng serve en :4200
```

`proxy.conf.json` reenvía `/api/*` de `:4200` a `:8788`, así que
`ApiClient` (que usa URLs relativas) funciona igual en los dos modos.

### Cuentas de la semilla

| Correo | Rol | Contraseña |
|---|---|---|
| `inventario@agricultores.co` | `ADMIN_INVENTARIO` | `demo1234` |
| `pedidos@agricultores.co` | `GESTOR_PEDIDOS` | `demo1234` |
| `admin@agricultores.co` | `SUPER_ADMIN` (abre todo) | `demo1234` |

`worker/tools/generate-seed.mjs` importa `PRODUCTS` y `ORDERS` directamente de
`src/app/core/data/mock-*.ts` — los mismos datos que ve la demo local — para
que backend y frontend nunca diverjan por transcribirlos dos veces. Si cambias
el catálogo o los pedidos de ejemplo, regenera con `npm run db:seed:build` y
vuelve a sembrar con `npm run db:seed` (o `db:reset` para partir de cero).

### Qué hace que la aprobación de un pedido sea segura de verdad

Esto es lo que más cuidado pidió del backend, así que vale explicarlo:

1. **El `CHECK (stock_actual >= 0)` de la tabla `products` es la garantía
   real**, no la validación en TypeScript. Dos aprobaciones concurrentes que
   pasen la validación de la aplicación a la vez chocan aquí: la segunda
   sentencia `UPDATE` viola la restricción y D1 revierte **todo su batch**, no
   solo esa fila.
2. **`env.DB.batch([...])` es la transacción.** D1 no soporta transacciones
   interactivas (`BEGIN` con `await` en medio); `batch()` es el primitivo
   correcto — todas las sentencias se aplican o ninguna.
3. **Idempotencia con `aprobacion_token`.** La primera sentencia del batch
   marca el pedido como aprobado *solo si* `aprobacion_token IS NULL`; cada
   descuento de stock exige que el token guardado sea el que se acaba de
   generar. Si dos aprobaciones del mismo pedido llegan a la vez, la segunda
   encuentra el token ya puesto por la primera: su `UPDATE` inicial no toca
   ninguna fila y sus descuentos tampoco casan — sin ese token, la segunda
   restaría el inventario por partida doble.
4. **Los pedidos web reservan stock al crearse**, no al aprobarse
   (`stock_reservado = 1`). `approve()` comprueba ese flag y **salta** el
   descuento si ya estaba reservado — si no, un pedido de la tienda pagaría el
   inventario dos veces: una al confirmar la compra y otra al verificar el
   pago.

Verificado con `curl` contra D1 local: vender de más devuelve 400 con los
faltantes exactos y el stock intacto; aprobar dos veces el mismo pedido
devuelve 409 en el segundo intento sin duplicar el descuento; y un rol sin
permiso recibe 403 tanto en inventario como en pedidos.

### Desplegar el backend

```bash
npx wrangler d1 create agricultores-organicos
# copia el database_id que imprime a wrangler.jsonc (ahí hay un placeholder)

npx wrangler secret put JWT_SECRET
# pega una cadena aleatoria larga — nunca la del ejemplo de .dev.vars

npm run db:schema:remote
npm run db:seed:remote     # opcional: solo si quieres los datos de ejemplo en producción

npm run deploy
```

`JWT_SECRET` **nunca** va en `wrangler.jsonc` (ese fichero se versiona). En
local se lee de `.dev.vars`, que está en `.gitignore`.

---

## 4. Despliegue en Cloudflare

El build es **estático**: se sirve desde el edge sin runtime. Se despliega como
**Worker con static assets** (la vía actual del dashboard unificado "Workers &
Pages" al conectar un repo), configurado en **`wrangler.jsonc`**:

```jsonc
{
  "name": "agricultores-organicos",
  "compatibility_date": "2024-09-23",
  "assets": {
    "directory": "./dist/agricultores-organicos/browser",
    "not_found_handling": "single-page-application"
  }
}
```

`not_found_handling: "single-page-application"` es lo que hace que las rutas
internas de Angular no den 404: cualquier petición que no coincida con un
archivo real cae a `index.html`, y el router de Angular la resuelve en el
navegador. Sin este campo (o con un `wrangler.jsonc` ausente), Cloudflare no
sabe qué carpeta servir y **todo** — incluida la raíz — devuelve 404 con el
cuerpo vacío, no un error de Angular.

> **Nota:** este proyecto probó antes `public/_redirects` con la regla de
> Pages clásico (`/* /index.html 200`). En un Worker con static assets **no
> se puede usar a la vez** que `not_found_handling`: ambos intentan resolver
> el mismo comodín y Cloudflare rechaza el deploy con `Infinite loop detected
> in this rule [code: 100324]`. Por eso `_redirects` no está en `public/` —
> solo aplícalo si el proyecto es Pages clásico (dominio `*.pages.dev`), y en
> ese caso no crees `wrangler.jsonc`.

### Opción A — conectando el repositorio (recomendada)

En el panel de Cloudflare: **Workers & Pages → Create → Import a repository**,
y usa esta configuración:

| Campo | Valor |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Variable de entorno | `NODE_VERSION` = `22.22.3` |

Cloudflare lee `wrangler.jsonc` para saber qué carpeta subir, así que no hace
falta indicar un "output directory" aparte. Cada push a la rama de producción
despliega automáticamente.

### Opción B — subida directa con Wrangler

```bash
npx wrangler login
npm run deploy        # build + wrangler deploy
```

Para probar en local exactamente lo que servirá Cloudflare (assets y fallback
de SPA incluidos):

```bash
npm run preview        # build + wrangler dev
```

### Ficheros que hacen que el despliegue funcione

- **`wrangler.jsonc`** — le dice a Cloudflare dónde están los assets
  compilados y activa el fallback de SPA. Es el fichero que faltaba cuando el
  primer despliegue devolvió 404 en toda la app.

- **`public/_headers`** — caché inmutable de un año para los assets con hash
  (`main-A1B2C3.js`) y `must-revalidate` para `index.html`, que no lleva hash y
  si se cacheara dejaría a los usuarios pidiendo bundles viejos tras cada
  despliegue. Incluye además `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options` y `Permissions-Policy`.

- **`public/_redirects`** — **no debe existir en este proyecto.** Se probó con
  la regla de Pages clásico y Cloudflare rechazó el deploy (`Infinite loop
  detected in this rule [code: 100324]`): coexistir con `not_found_handling`
  no es opcional, es un error de validación. Solo tiene sentido si el proyecto
  se desplegara como Pages clásico — y en ese caso, sin `wrangler.jsonc`.

### Si algún día hiciera falta SSR

`ng add @angular/ssr` y desplegar sobre el mismo Worker con el adaptador de
Cloudflare. Hoy no aporta nada: la tienda pública sigue siendo un catálogo
estático del lado del cliente, y el build estático es más rápido y más barato
que renderizar en el servidor algo que no cambia por request.

---

## 5. Estado de la entrega

**Tienda pública** — header adaptativo, hero compacto, filtros client-side con
contadores, rejilla responsive 1→2→3→4 columnas, tarjeta con cross-fade e
"Añadir" emergente, carrito lateral con envío gratis progresivo, checkout con
comprobante opcional y enlace de WhatsApp, banda editorial, newsletter, footer,
accesibilidad (foco visible, `role="dialog"`, `aria-live`, `alt` reales,
`prefers-reduced-motion`). Todo sobre `localStorage`, sin backend.

**Panel administrativo** — login contra JWT firmado por el servidor, RBAC real
por endpoint (no solo en el frontend), inventario con precio/costo/margen
editable, pedidos con aprobación transaccional (ver §3), reportes de ventas
con clasificación ABC calculada en SQL y cierre de caja. Todo leído y escrito
en Cloudflare D1 a través del Worker.

**Verificado** ejecutando la app, no solo compilando: build de producción sin
errores de consola; en el backend, `curl` contra D1 local confirmó que vender
de más devuelve 400 con los faltantes exactos sin tocar stock, que aprobar dos
veces el mismo pedido devuelve 409 sin duplicar el descuento, y que cada rol
recibe 403 fuera de su módulo; en el navegador, login real, edición de
inventario persistida en D1, aprobación de pedido con descuento visible, y
cierre de caja con aritmética exacta contra los pedidos aprobados.

**Pendiente** (siguiente iteración) — checkout y pagos, autenticación, página de
detalle de producto, buscador con backend, i18n y analítica.
