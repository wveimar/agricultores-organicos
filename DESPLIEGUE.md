# Puesta en producción

Procedimiento para llevar el sistema desde esta máquina hasta
`agricultores-organicos.wveimar-mamian.workers.dev`.

Cada paso dice **qué** hace, **por qué está en ese orden** y **cómo comprobar**
que salió bien. El orden no es decorativo: hay dos sitios donde invertirlo
rompe producción, y están marcados.

---

## Lo que hay hoy en producción (verificado el 2026-09-22)

| | Producción | Local |
|---|---|---|
| Esquema | hasta la migración **0034** | hasta la **0038** |
| Faltan allá | `treasury_accounts`, `treasury_movements`, `cashier_shifts`, `provider_payments`, `invoice_refunds` | — |
| Productos | 25 | 25 |
| Contactos | 29 (mezcla de demo) | 22 (21 fincas + consumidor final) |
| Usuarios | 3, todos con `demo1234` | 1, el definitivo |
| Pedidos / facturas / cobros | 9 / 5 / 4 (demo) | 0 |
| Secretos | solo `JWT_SECRET` | `JWT_SECRET` en `.dev.vars` |

Es decir: **producción se quedó cuatro migraciones atrás** — todo el módulo de
Tesorería, los abonos a fincas y las devoluciones no existen allá todavía. Si
se despliega el código nuevo sin migrar primero, la aplicación arranca y el
panel de Tesorería responde error 500 en cuanto alguien lo abra.

---

## Paso 0 — Respaldo

Antes de nada, una copia de la base de producción tal como está.

```bash
npx wrangler d1 export DB --remote --output=respaldo-produccion.sql
```

Guárdala fuera del repositorio. Es el único camino de vuelta: los pasos 4 y 5
borran datos y D1 no tiene papelera.

Comprobar: el archivo pesa algo (unos 500 KB) y su última línea no está cortada.

---

## Paso 1 — Poner el esquema al día

```bash
npx wrangler d1 migrations apply DB --remote
```

Aplica 0035, 0036, 0037 y 0038 en orden. Producción lleva la cuenta en su
tabla `d1_migrations`, así que wrangler sabe exactamente dónde quedó y no
reaplica nada.

Las cuatro son **aditivas** — crean tablas nuevas y añaden columnas con valor
por defecto, no modifican ni borran lo que ya existe. Por eso este paso es
seguro aunque el código desplegado todavía sea el viejo: el Worker actual
sigue funcionando igual, simplemente ignora lo que no conoce.

> ⚠️ **No corras esto en local.** La base local se construyó con `schema.sql`
> de una sola vez y no tiene tabla `d1_migrations`; wrangler creería que está
> en cero e intentaría aplicar las 38 migraciones sobre un esquema que ya las
> tiene. Local ya está al día por otro camino.

Comprobar:

```bash
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'treasury%'"
```

Tienen que aparecer `treasury_accounts` y `treasury_movements`.

---

## Paso 2 — Desplegar la aplicación

```bash
npm run deploy          # ng build + wrangler deploy
```

**Va antes de vaciar la base, no después.** Dos razones: si el despliegue
falla, producción sigue en pie con sus datos; y el paso 3 necesita que el
código nuevo esté arriba para poder probarlo de verdad.

Comprobar:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://agricultores-organicos.wveimar-mamian.workers.dev/
curl -s https://agricultores-organicos.wveimar-mamian.workers.dev/api/config
```

Ambas 200, y `/api/config` devuelve los cuatro módulos en `true`.

---

## Paso 3 — Probar contra producción, con los datos de demo todavía puestos

Este es el momento exacto para correr la batería completa: el esquema ya está
al día, el código nuevo ya está arriba, y lo que ensucie la prueba lo va a
barrer el paso 4 de todas formas.

```bash
node worker/tests/qa-integral.mjs https://agricultores-organicos.wveimar-mamian.workers.dev admin@agricultores.co demo1234
```

Tiene que terminar en `TODO OK — los números cuadran de punta a punta`
(33 comprobaciones). Si algo falla aquí, **para**: todavía se puede volver
atrás desplegando el commit anterior y nadie ha perdido nada.

> Después de este paso no vuelvas a correr esta batería contra producción:
> escribe pedidos, facturas y cobros reales en la base.

---

## Paso 4 — Vaciar producción

```bash
npm run db:limpiar:remote
```

Borra todo el historial de movimiento y los usuarios. Conserva productos,
categorías, grupos, las cuentas de tesorería, los ajustes y los contactos
proveedores. Es el mismo archivo que ya se corrió en local
(`worker/tools/reset-produccion.sql`), así que hace exactamente lo mismo.

Comprobar que pedidos, facturas, pagos y usuarios quedan en cero:

```bash
npx wrangler d1 execute DB --remote --command "SELECT (SELECT COUNT(*) FROM orders) pedidos, (SELECT COUNT(*) FROM invoices) facturas, (SELECT COUNT(*) FROM users) usuarios"
```

---

## Paso 5 — Subir el catálogo definitivo

Desde esta máquina, **después** de haber terminado de ajustar los productos
en el panel local:

```bash
npm run db:exportar-catalogo     # lee la base local -> worker/tools/catalogo.sql
npm run db:catalogo:remote       # lo carga en producción
```

El archivo lleva productos, categorías, grupos, recetas de canasta,
descuentos de mayorista, las cuentas de tesorería, los ajustes y las fichas de
las fincas. **No lleva** pedidos, facturas, cobros, clientes ni usuarios.

Cada tabla se vacía antes de reinsertarse, así que se puede volver a subir
tantas veces como haga falta: el resultado siempre es el mismo. Es el camino
para publicar cambios de catálogo más adelante sin tocar nada más.

Comprobar: el conteo de productos en remoto coincide con el de local.

---

## Paso 6 — Crear el superusuario

```bash
node worker/tools/crear-superusuario.mjs wveimar.mamian@gmail.com "<la clave>" "Wveimar Mamián"
npx wrangler d1 execute DB --remote --file=worker/tools/.superusuario.sql
```

El archivo `.superusuario.sql` está en `.gitignore` y lleva el hash, nunca la
clave. Si ya lo generaste para local, sirve el mismo — es el mismo hash.

Comprobar que la cuenta nueva entra y devuelve `"roles":["SUPER_ADMIN"]`:

```bash
curl -s -X POST https://agricultores-organicos.wveimar-mamian.workers.dev/api/auth/login -H "content-type: application/json" -d "{\"email\":\"wveimar.mamian@gmail.com\",\"password\":\"<la clave>\"}"
```

Y que la cuenta vieja ya no entra — tiene que responder 401:

```bash
curl -s -X POST https://agricultores-organicos.wveimar-mamian.workers.dev/api/auth/login -H "content-type: application/json" -d "{\"email\":\"admin@agricultores.co\",\"password\":\"demo1234\"}"
```

---

## Paso 7 — Verificación final (sin escribir nada)

| Qué | Cómo |
|---|---|
| La tienda carga y muestra el catálogo | abrir `/` en el navegador |
| El panel deja entrar | abrir `/admin/login` con la cuenta nueva |
| Inventario muestra los 25 productos | pestaña Inventario |
| Tesorería abre en ceros | pestaña Tesorería — disponible $0, sin movimientos |
| Cartera vacía | Por cobrar y Por pagar sin filas |
| Contactos trae solo las fincas | pestaña Contactos |

La primera operación real es abrir el turno de caja con el efectivo que haya
en el cajón, y registrar la primera entrada de mercancía.

---

## Pendientes que no bloquean el despliegue

- **Turnstile no está configurado en producción.** El Worker lo detecta y deja
  pasar el login sin verificación anti-bots (lo registra en el log cada vez).
  Para activarlo hacen falta las dos claves del widget:

  ```bash
  npx wrangler secret put TURNSTILE_SECRET
  npx wrangler secret put TURNSTILE_SITE_KEY
  ```

- **La landing (`landing/`) se publica aparte.** No entra en `npm run deploy`;
  ese comando solo sube la aplicación Angular y el Worker.
- **Correo de contacto de la landing:** sigue el marcador
  `hola@agricultoresorganicos.co`, que no existe.

---

## Si algo sale mal

| Síntoma | Causa más probable | Salida |
|---|---|---|
| Tesorería responde 500 tras desplegar | el paso 1 no se corrió o falló a medias | correr el paso 1 y comprobar que aparecen las tablas `treasury_*` |
| El login devuelve 500 en producción pero funciona en local | `JWT_SECRET` no está puesto | `npx wrangler secret put JWT_SECRET` |
| La tienda carga pero sale vacía | el catálogo no se subió | repetir el paso 5 |
| Se borró algo que no tocaba | — | restaurar desde el respaldo del paso 0 |

Volver atrás en el código es desplegar el commit anterior. Volver atrás en los
datos solo es posible con el respaldo del paso 0.

---

## Las herramientas, en corto

| Comando | Qué hace |
|---|---|
| `npm run db:limpiar` | vacía la base **local**: borra el historial, deja catálogo y fincas |
| `npm run db:limpiar:remote` | lo mismo contra **producción** |
| `npm run db:superusuario <correo> <clave> "<nombre>"` | genera `worker/tools/.superusuario.sql` con el hash |
| `npm run db:exportar-catalogo` | vuelca el catálogo local a `worker/tools/catalogo.sql` |
| `npm run db:catalogo:remote` | carga ese catálogo en producción |
| `npm run deploy` | compila Angular y sube el Worker |
