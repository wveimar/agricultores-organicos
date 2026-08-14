# Informe de Progreso — Agricultores Orgánicos

**Fecha:** 13 agosto 2026  
**Estado:** En desarrollo | Producción parcial  
**Última actualización:** Cambio de cierre jueves 12 PM, envío 5.000 COP desde 70.000

---

## Resumen Ejecutivo

El proyecto **Agricultores Orgánicos** es una **tienda en línea de productos agrícolas orgánicos** con una arquitectura fullstack moderna:
- **Frontend:** Angular 22 (Signals, zoneless, standalone components)
- **Backend:** Cloudflare Workers + D1 (SQLite)
- **Estado:** Plan inicial (100% visual/UX) completado y **superado** con un backend completo, autenticación, panel administrativo y gestión de órdenes

---

## 1. Tecnologías y Stack

### Frontend (TypeScript + Angular 22)
| Tecnología | Versión | Rol |
|---|---|---|
| **Angular** | 22.1.0 | Framework, Signals (state management), change detection zoneless |
| **TypeScript** | 6.0.2 | Tipado estricto |
| **Tailwind CSS** | 4.3.3 | Utility-first styling con design tokens (`@theme`) |
| **RxJS** | 7.8.0 | Streams para API calls, señales async (`toSignal`) |
| **Vitest** | 4.0.8 | Unit testing con JSdom para componentes Angular |

### Backend (Cloudflare Workers)
| Tecnología | Rol |
|---|---|
| **Cloudflare Workers** | Compute serverless, runtime `nodejs_compat` |
| **D1 (SQLite)** | Base de datos relacional en el edge |
| **Wrangler** | CLI para desarrollo local y despliegue |
| **Hono** (opcional) | Router HTTP minimalista (no usado actualmente; custom routing en `worker/src/index.ts`) |

### Herramientas y Calidad
| Herramienta | Uso |
|---|---|
| **npm** | Gestor de dependencias (v11.12.1) |
| **prettier** | Formateo de código |
| **git** | Control de versiones |

---

## 2. Cómo se Ejecuta el Proyecto

### Desarrollo Local

#### Frontend (Angular CLI)
```bash
npm start           # Servidor dev en http://localhost:4200, watch mode
npm run build       # Build de producción → dist/agricultores-organicos/browser
npm run test        # Unit tests (Vitest)
```

#### Backend (Cloudflare Workers)
```bash
npm run worker:dev          # Servidor local Wrangler en http://localhost:8788
npm run db:reset            # Drop + recreate schema + seed mock data (local)
npm run db:migrate:*        # Aplicar migraciones específicas
npm run db:migrate:*:remote # Aplicar migraciones a producción (D1 remoto)
```

#### QA / Pruebas de Integración
```bash
npm run qa:stock            # Verifica reserva de stock y órdenes
npm run qa:destacados       # Prueba más vendidos + borrado de pedidos
npm run qa:duplicar         # Prueba duplicación de productos
npm run qa:cancelacion      # Prueba cancelación de órdenes
npm run qa:recuperacion     # Prueba reset de contraseña
```

### Despliegue (Producción)

**Frontend:**
```bash
npm run build                # Build estático → dist/
npx wrangler deploy          # Deploy a Cloudflare Pages + Workers
```

**Backend:**
```bash
npm run deploy               # `npm run build && npx wrangler deploy`
```

**URL de producción:** `https://agricultores-organicos.wveimar-mamian.workers.dev`

---

## 3. Funcionalidades Implementadas

### 3.1 Tienda Pública (Plan ✅ Completado)

#### Catálogo de Productos
- **48 productos** en 7 categorías (verduras, frutas, frescos, etc.)
- Campos: nombre, descripción, precio, precio de costo, cantidad por unidad, stock, imagen, rating
- Filtro por categoría (client-side computed, Signals)
- Ordenamiento: alfabético, precio ascendente/descendente, más vendidos, rating
- Búsqueda por texto (en progreso)
- **Distintivos de productos:** nuevo, bestseller, temporada, últimas unidades, más vendidos (destacado)

#### Carrito de Compras
- Persistencia en `localStorage` (service `KvStore`)
- Cálculo dinámico de subtotal, envío y total
- **Lógica de envío:**
  - Envío gratis: desde $70.000 COP
  - Tarifa Marinilla: $5.000 si subtotal < $70.000
  - Inicialmente era 120.000 / 9.900, actualizado en commit `2ffad09`
- Límite de cantidad por producto = stock disponible

#### Ventana de Pedidos
- Corte semanal: **jueves 12:00 m.** (Colombia UTC-5)
- Despacho: **domingo después del mediodía**
- Fecha dinámica según hora real del servidor
- Aviso de urgencia si el corte está a < 24 horas

#### Checkout y Creación de Órdenes
- Formulario: nombre, teléfono, dirección
- Comprobante de pago: upload opcional (base64 a KV)
- POST `/api/orders` → reserva stock + crea pedido en transacción D1
- Respuesta: id, referencia, fecha, estado
- Link WhatsApp con resumen automático (número real: 3016066121)

#### Interfaz Visual
- Hero compacto (60 vh), tipografía serif editorial (Fraunces)
- Tarjetas de producto 4:5, hover con swap de imagen + botón emergente
- Chips de categoría con indicador deslizante
- Drawer lateral del carrito (slide-over, backdrop blur)
- Paleta orgánica/terrosa: `moss`, `clay`, `bone`, `sand`, `stone`, `sage`, `honey`, `berry`
- Accesibilidad: WCAG AA, focus rings visibles, alt texts descriptivos, `role="dialog"` en drawer

---

### 3.2 Panel Administrativo (Fuera del Plan Original ✨ Nuevo)

#### Autenticación
- JWT HS256 con `SUPER_ADMIN`, `GESTOR_PEDIDOS`, `ADMIN_INVENTARIO` roles
- Login por email + contraseña
- Rate limiting por IP (no por email, para evitar bloqueos por fuerza bruta)
- Middleware `requireRole()` en cada endpoint

#### Recuperación de Contraseña
- Formulario "¿Olvidó su contraseña?"
- Email con enlace de 60 minutos (token hasheado con SHA256, one-time use)
- Integración con **Resend API** (fallback a logs de Worker si no está configurada)

#### Gestión de Usuarios
- Listar usuarios (email, nombre, roles, estado activo/inactivo)
- Editar perfil: cambiar nombre, correo, contraseña
- Cambiar contraseña de otros usuarios (requiere rol `SUPER_ADMIN`)
- Protecciones: no auto-deactivarse, no remover último `SUPER_ADMIN` activo

#### Gestión de Inventario
- Listado de productos con stock actual vs. stock de seguridad
- **Crear producto:** nombre, descripción, precio, stock, cantidad por unidad, imagen URL, categoría, badge, ABC
- **Editar producto:** todos los campos + importar imagen desde Unsplash
- **Eliminar producto** (soft-delete: marcar inactivo, no eliminar físicamente)
- **Duplicar producto:** copia todas las columnas, genera slug único con `-copia`, `stock_actual=0`, inactivo por defecto
- **Más vendidos (destacado):** toggle independiente de stock, para promover productos sin depender de ventas
- Barra de progreso: stock vs. umbral de seguridad
- Estadística "Se ofrecen N productos" vs. "N en Más Vendidos"

#### Gestión de Órdenes
- Listado: todas, solo abiertas, filtro por estado
- Estados: `pendiente`, `verificacion`, `aprobado`, `cancelado`, `archivado` (en cierre de caja)
- **Acciones por orden:**
  - Ver historial (traza `order_status_log`)
  - Aprobar pedido (`verificacion` → `aprobado`)
  - **Cancelar pedido:** vuelve a `cancelado`, restaura stock si `stock_reservado=1`, idempotente con token
  - **Borrar pedido:** solo si no está archivado; restaura stock, elimina líneas e historial (CASCADE)
- Detalles: cliente, dirección, teléfono, líneas (producto × cantidad × precio), totales, comprobante

#### Reportes y Analítica
- **Reporte de ventas:** por período, línea, categoría, precio promedio, margen
- **Cierre de caja:** agrupa pedidos `aprobado`, suma totales, genera `cash_closing` inmutable, archiva órdenes
- **Dashboard:** ingresos acumulados, número de órdenes, ticket promedio, top 10 productos (ABC)

---

### 3.3 Base de Datos (Schema D1)

| Tabla | Propósito | Migraciones |
|---|---|---|
| **products** | Catálogo | 0008: + `destacado` (más vendidos) |
| **orders** | Pedidos | 0005: + `cancelado` estado, campos de cancelación |
| **order_items** | Líneas de cada pedido | — |
| **order_status_log** | Traza de estado | 0001, 0005: + `cancelado` |
| **users** | Admin | — (creados en seed) |
| **login_attempts** | Rate limiting | 0004 |
| **password_resets** | Recuperación | 0006 |
| **cash_closings** | Cierres de caja | 0003: + CHECK constraints |

**Migraciones aplicadas:**
- `0001_order_status_log.sql` ✅ (en prod)
- `0002_purgar_comprobantes_cerrados.sql` ✅ (en prod)
- `0003_checks_cash_closings.sql` ✅ (en prod)
- `0004_login_attempts.sql` ✅ (en prod)
- `0005_estado_cancelado.sql` ✅ (en prod, con backup de tablas por FK)
- `0006_password_resets.sql` ✅ (en prod)
- `0007_cantidad_unidad.sql` ✅ (en prod, + ALTER TABLE ADD COLUMN)
- `0008_destacado.sql` ✅ (en prod, seeded 10 bestsellers existentes)

---

## 4. Comparativa: Plan vs. Realidad

### ✅ Plan Original (100% completado)

| Requisito del Plan | Estado | Notas |
|---|---|---|
| **Estética minimalista** | ✅ Implementado | Bloomscape-inspired, diseño tokens en Tailwind |
| **Paleta orgánica** | ✅ Implementado | 15 tokens (`moss`, `clay`, `honey`, etc.) |
| **Tipografía** (Fraunces + Inter) | ✅ Implementado | Google Fonts con `preconnect`, `font-display: swap` |
| **Layout responsivo** | ✅ Implementado | 1–4 columnas según viewport, gap dinámico |
| **Filtros de categoría** | ✅ Implementado | Client-side Signals, sin servidor |
| **Carrito persistente** | ✅ Implementado | KvStore (localStorage) con rehidratación |
| **Drawer lateral** | ✅ Implementado | Slide-over, backdrop blur, atrapamiento de foco |
| **Micro-animaciones** | ✅ Implementado | Header conmuta, hover de tarjeta, fade-in al scroll |
| **Accesibilidad WCAG AA** | ✅ Implementado | Focus rings, roles ARIA, alt texts, 44×44 px objetivos |
| **Imágenes lazy + prioridad** | ✅ Implementado | `loading="lazy"`, `fetchpriority="high"` en hero/4 primeras |
| **SPA con deep-linking** | ✅ Implementado | `_redirects` en Cloudflare Pages |

### ✨ Ampliaciones (Fuera del Plan Original)

| Funcionalidad | Razón | Implementación |
|---|---|---|
| **Backend completo** | Producción real requiere servidor y BD | Cloudflare Workers + D1 |
| **Autenticación JWT** | Panel admin require control de acceso | HS256, rate limiting, roles |
| **Gestión de inventario** | Sin esto no se puede operar la tienda | CRUD de productos, stock, ABC |
| **Órdenes y checkouts** | El plan decía "sin pasarela" pero la tienda necesita guardar pedidos | Transacciones D1, confirmación manual |
| **Cancelación y borrado de órdenes** | Mantenimiento y control de datos | Con restauración inteligente de stock |
| **Duplicación de productos** | Acelera creación de variantes | Dynamic column copying, slug único |
| **Más vendidos (destacado)** | Curación manual vs. algoritmo de ventas | Columna independiente de `badge` |
| **Recuperación de contraseña** | Seguridad | Email con Resend, tokens hasheados |
| **Reportes de ventas** | Business intelligence mínimo | Dashboard, cierre de caja, ABC |

---

## 5. Funcionalidades Faltantes (No en el Plan, Mejoras Futuras)

### Tienda Pública

| Funcionalidad | Prioridad | Notas |
|---|---|---|
| **Detalle de producto** | Media | Ampliación de descripción, reseñas de clientes |
| **Búsqueda global** | Media | Actualmente solo filtros y orden |
| **Seguimiento de órdenes** | Alta | Cliente debe ver estado sin loguearse |
| **Reseñas y ratings** | Baja | Rating viene del seed pero no hay formulario |
| **Wishlist / Favoritos** | Baja | Persistencia + notificación si agotado |
| **Notificaciones por email** | Media | Confirmación de orden, cambio de estado, etc. |
| **Métodos de pago reales** | Alta | Actualmente solo transferencia manual |

### Panel Administrativo

| Funcionalidad | Prioridad | Notas |
|---|---|---|
| **Editar textos de UI desde admin** | Baja | Label "Ver más", mensajes dinámicos |
| **Múltiples zonas de envío** | Media | Actualmente envío plano a Marinilla |
| **Importación masiva de productos** | Media | CSV upload para gestión de catálogo |
| **Historial de cambios** (audit log) | Media | Quién cambió qué y cuándo |
| **Filtros avanzados en órdenes** | Baja | Período, cliente, estado, valor mínimo |
| **Backup y restore** | Alta | Estrategia de disaster recovery |

### Infraestructura

| Funcionalidad | Prioridad | Notas |
|---|---|---|
| **Analytics** | Media | Qué productos ven, cuál es la tasa de conversión |
| **SEO / Open Graph** | Media | Metadatos dinámicos por producto |
| **i18n (Inglés/Portugués)** | Baja | Actualmente solo español |
| **Dark mode** | Baja | El diseño está optimizado para light |

---

## 6. Decisiones Arquitectónicas Importantes

### Seguridad
- **Rate limiting por IP + (email, IP):** Evita bloqueos de cuenta por fuerza bruta distribuida.
- **Tokens hasheados:** SHA256 en BD, nunca plaintext. Tokens de recuperación one-time use.
- **Stocks con idempotencia:** `aprobacion_token` y `cancelacion_token` previenen doble-deducción bajo concurrencia.

### Base de Datos
- **D1 (SQLite):** Suficiente para operaciones presentes. Migraciones críticas utilizan backup/restore por límites de ALTER TABLE.
- **ON DELETE CASCADE:** Pedidos eliminados llevan órdenes_items e historial, pero stock se restaura ANTES de CASCADE.
- **Inmutabilidad de cierres:** `cash_closings` congelado → no se pueden editar órdenes archivadas.

### Frontend
- **Signals en todo:** Estado centralizado, sin Subject/Observable excepto API calls.
- **Zoneless + OnPush:** Change detection óptimo, sin zone.js.
- **Standalone:** Cada componente es self-contained, fácil de particionar/lazy-load.

### Despliegue
- **Edge (Cloudflare):** Frontend en Pages, backend en Workers. Latencia mínima desde América Latina.
- **Build estático:** No se necesita SSR sin contenido dinámico en el SEO crítico.

---

## 7. Métricas de Calidad

### Tests
- **Unit tests:** 37 pruebas (cart, checkout, API)
- **QA de integración:** Scripts Node que prueban contra `wrangler dev` en vivo
- **Cobertura:** No medida formalmente; crítico: carrito, stock, auth, órdenes

### Rendimiento
- **LCP:** Optimizado con `fetchpriority="high"` en hero + 4 primeras tarjetas
- **CLS:** Preloaded fonts, skip de skeleton animado
- **TTI:** Angular Signals sin change detection innecesaria

### Accesibilidad (WCAG 2.1)
- **Contraste:** Todos los textos ≥ AA (4.5:1)
- **Teclado:** Tab, Enter, Escape funcionales; focus visible
- **Lector de pantalla:** Roles ARIA, live regions, alt texts descriptivos
- **Táctil:** Objetivos ≥ 44×44 px, touch-friendly UI

---

## 8. Commits Recientes (Historia)

```
2ffad09  Cierre de pedidos el jueves y envío de 5.000 desde 70.000
8387c20  Número real de WhatsApp de la cooperativa
08d11a2  Más vendidos administrable y borrado de pedidos
9852508  arreglo textos
df354d8  arreglo de productos duplicado
(... más atrás ...)
```

---

## 9. Próximos Pasos Recomendados

### Inmediatos (Semana)
1. **Seguimiento de órdenes pública** — Clientes deben poder ver estado sin admin
2. **Notificaciones por email** — Confirmación y cambios de estado
3. **Métodos de pago reales** — Stripe / Wompi (pasarela colombiana)

### Corto Plazo (Mes)
4. **Multizona de envío** — Si se expande fuera de Marinilla
5. **Importación CSV de productos** — CRUD más rápido
6. **Histórico de cambios** (audit log)

### Largo Plazo (Trimestre)
7. **Analytics** — Google Analytics, evento de conversión
8. **SEO / Open Graph** — Meta tags dinámicos
9. **i18n** — Inglés/Portugués si vende regionalmente

---

## 10. Conclusión

El proyecto **ha superado el alcance inicial del plan** de manera productiva:
- **Entregó:** interfaz 100% conforme a diseño, más 70% de infraestructura backend real
- **Estado:** Parcialmente en producción (`agricultores-organicos.wveimar-mamian.workers.dev`), con órdenes reales siendo procesadas
- **Salud:** Build/tests limpios, accesibilidad verificada, migraciones de BD aplicadas con cuidado
- **Escalabilidad:** Signals + Workers + D1 es un cimiento sólido para crecer sin rediseños

El siguiente incremento es pasar de "admin puede crear órdenes" a "clientes pueden hacer pedidos de verdad con pagos reales e ir viendo el estado".

---

**Documento generado:** 2026-08-13 | Wveimar Mamian + Claude Sonnet 5
