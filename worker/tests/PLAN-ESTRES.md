# Plan de pruebas de estrés · login y checkout

Escala real del proyecto: **~60 productos activos y hasta 100 clientes**. Ese
dato cambia el plan por completo, así que conviene decirlo antes que nada.

## Lo que no hay que probar

El **número de peticiones no es el cuello de botella**. Solo `/api/*` llega al
Worker: `wrangler.jsonc` tiene `run_worker_first: ["/api/*"]` y Cloudflare no
cobra ni limita las peticiones a archivos estáticos. Con 100 clientes salen
unas 100 llamadas diarias al Worker, contra las 100.000 del plan gratuito: el
**0,1 %**. Montar k6 para demostrar que 100 personas no tumban Cloudflare es
gastar tiempo en la pregunta equivocada.

## Lo que sí hay que probar

Dos cosas, y ninguna es el volumen.

### 1. El login es 16 veces más caro que cualquier otra cosa

Medido con `qa-carga.mjs`, 10 en paralelo contra el Worker local:

| endpoint | rendimiento | p50 | p90 |
|---|---|---|---|
| `GET /api/products` | 144,5/s | 62 ms | 86 ms |
| `POST /api/auth/login` | **8,8/s** | 1.099 ms | 1.426 ms |

La causa es deliberada: PBKDF2 con 100.000 iteraciones por intento. Eso es lo
que hace cara la fuerza bruta, y por eso **no se debe bajar**. Pero implica que
el login tiene un techo de ~9/s por instancia y que es CPU real del Worker, no
una petición barata.

Contra producción la diferencia se disimula porque la latencia de red
Colombia→Miami (unos 330 ms) domina el total: login 354 ms de mediana frente a
331 ms del catálogo. Ese parecido es engañoso — el coste sigue ahí, solo que
escondido bajo la red.

**Qué comprobar:** que a 10–20 conexiones simultáneas el login no supere los
2 s en p90 ni empiece a devolver errores.

**Qué haría saltar la alarma:** que aparezcan 5xx (se agotó la CPU) o que el
p90 se dispare. A 100 clientes eso no debería pasar ni con todos entrando a la
vez, porque nadie inicia sesión en la tienda: el login es solo del panel, tres
cuentas.

### 2. El checkout bajo concurrencia real

Lo cubre `qa-seguridad.mjs`, sección 3: dos pedidos simultáneos por la última
unidad. Comprueba que prospera exactamente uno, que el stock queda en 0 y que
no queda ninguna reserva huérfana. Esa es la prueba de estrés que importa —
no cuántos pedidos por segundo aguanta, sino que **ninguna carrera venda de
más**.

La garantía no es del código, es del `CHECK (stock_actual >= 0)` de D1: la
segunda transacción lo viola y se revierte entera. Por eso la prueba va contra
el Worker y su base de verdad, no contra dobles.

## Cómo ejecutarlo

```bash
npm run worker:dev                       # en otra terminal

node worker/tests/qa-carga.mjs http://localhost:8788 10 20
npm run qa:seguridad
```

Contra producción, con cabeza:

```bash
node worker/tests/qa-carga.mjs https://agricultores-organicos.wveimar-mamian.workers.dev 5 10
```

Cinco conexiones y diez segundos bastan para ver la forma de la curva. Subirlo
mucho más solo sirve para gastar cuota y CPU propia: **cada login fallido de la
prueba cuesta el mismo PBKDF2 que uno real**.

## El riesgo que ninguna prueba de carga arregla

`/api/auth/login` **no tiene límite de intentos**. La única defensa contra
fuerza bruta es que cada intento cuesta 100.000 iteraciones de PBKDF2 — cara
para el atacante, pero también para el Worker, que es quien la paga.

Turnstile está en el formulario, pero:

- la sitekey está vacía (`admin-login.ts`), así que el widget corre en modo demo;
- y el Worker **no valida el token contra `siteverify`**, así que enviar el
  formulario por `curl` lo salta entero.

Antes de abrir esto a producción de verdad hacen falta dos cosas, por orden:

1. **Cambiar la contraseña de las tres cuentas sembradas.** Hoy son públicas:
   la pantalla de login las lista con su contraseña.
2. **Limitar los intentos** por IP o por cuenta, con Cloudflare Rate Limiting
   sobre la ruta o con un contador en D1.

Con eso, el estrés del login deja de ser un problema de capacidad y pasa a ser
lo que debe ser: un endpoint que casi nadie usa.
