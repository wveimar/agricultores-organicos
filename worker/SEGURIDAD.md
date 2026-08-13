# Puesta en marcha de la seguridad

Tres cosas que viven fuera del repositorio, porque son secretos o configuración
del entorno. Sin ellas el proyecto funciona, pero con menos defensas.

## 1. `JWT_SECRET` — obligatorio

Firma las sesiones. Sin él, el login responde 500.

```bash
npx wrangler secret put JWT_SECRET     # producción
```

En local va en `.dev.vars`, que está en `.gitignore`. Usa un valor **distinto**
al de producción: si son el mismo, un token emitido en tu máquina sirve contra
la tienda real.

Generarlo:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Turnstile — opcional, pero es la única barrera anti-bots

El widget del login **no protege nada por sí solo**: vive entero en el
navegador y un `curl` lo salta. Lo que protege es la verificación en el
servidor contra `siteverify`, y esa necesita la clave secreta.

Se saca un par de claves en el panel de Cloudflare → Turnstile:

```bash
# La secreta, que solo conoce el Worker
npx wrangler secret put TURNSTILE_SECRET
```

La **sitekey es pública** (va en el HTML del widget), así que se declara como
variable normal en `wrangler.jsonc`:

```jsonc
"vars": {
  "TURNSTILE_SITE_KEY": "0x4AAAAAAA..."
}
```

El frontend la recoge de `GET /api/config`, así que activarla **no obliga a
recompilar** la aplicación.

### Cómo se comporta

| `TURNSTILE_SECRET` | Login |
|---|---|
| sin configurar | Se omite la verificación. Queda una advertencia en los logs. |
| configurado | Obligatoria. Sin token válido → **403**. |

Se omite cuando falta a propósito: exigirla siempre dejaría el panel
inaccesible en cuanto alguien despliegue antes de poner el secreto, incluido el
desarrollo local. Pero en cuanto existe, no hay término medio.

Para probar en local sin cuenta de Turnstile, Cloudflare publica claves de
prueba que siempre aprueban:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

## 3. Correo de recuperación — opcional, pero sin él no llega nada

Un Worker no habla SMTP: solo hace peticiones HTTP. Enviar correo pasa
obligatoriamente por la API de un proveedor, y eso significa una cuenta externa.

Con [Resend](https://resend.com) (3.000 correos al mes, 100 al día en el plan
gratuito):

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM        # "Agricultores Orgánicos <hola@tudominio.co>"
```

**Hace falta un dominio verificado.** El remitente no puede ser un Gmail ni el
subdominio de `workers.dev`: sin SPF y DKIM sobre un dominio propio, el correo
llega a spam o lo rechazan directamente. Es el trámite que hay que hacer en el
panel del proveedor, no algo que se resuelva en el código.

### Mientras no esté configurado

La recuperación **sigue funcionando**, pero el enlace no se envía: se escribe
en los logs del Worker.

```bash
npx wrangler tail        # buscar la línea "[recuperacion] ... Enlace para ..."
```

Solo lo ve quien tiene la cuenta de Cloudflare, así que sirve de salida de
emergencia — que es justamente el caso que importa: si el único SUPER_ADMIN
olvida su contraseña, sin esto se queda fuera para siempre.

No se falla la petición a propósito: responder distinto según haya proveedor o
no le diría a quien la hace si el correo existe, que es lo que el endpoint
evita con cuidado.

### Cómo está construido

- El token son 32 bytes aleatorios; en la base **solo se guarda su SHA-256**.
  Quien lea la tabla no obtiene una llave utilizable.
- Caduca en 60 minutos y es de **un solo uso**: un correo se reenvía, se queda
  en la papelera y se sincroniza en varios dispositivos.
- Pedir un enlace nuevo invalida el anterior.
- `POST /api/auth/recuperar` responde 200 exista o no la cuenta, para que no
  sirva de censo de correos registrados.
- Máximo 5 peticiones por hora y por IP: sin eso, cualquiera puede llenar de
  correos la bandeja de un administrador y quemar la cuota del proveedor.

## 4. Límite de intentos — ya activo, sin configuración

Vive en la tabla `login_attempts` y no necesita nada externo. Ocho fallos en 15
minutos bloquean la combinación de correo e IP, y también la IP suelta.

Detalles que importan y no se ven en el código a primera vista:

- **El bloqueo se comprueba antes del PBKDF2.** Medido: un intento bloqueado
  cuesta 9 ms frente a los 98 ms de uno normal. Si se comprobara después, el
  atacante seguiría gastando la CPU del Worker en cada intento.
- **No se cuenta por correo suelto**, a propósito. Sería la opción obvia y
  abre un agujero peor: cualquiera que sepa tu correo de administrador puede
  fallar ocho veces y dejarte fuera de tu propio panel cuando quiera.
- **Entrar bien borra el contador**, así que quien acierta al quinto intento no
  arrastra el historial.

Comprobarlo:

```bash
npm run worker:dev
node worker/tests/qa-fuerza-bruta.mjs
```

## Lo que sigue sin resolver

- **Revocación inmediata de sesiones.** Si se retira un rol, su token sigue
  siendo válido hasta que expire (8 h). Para revocar al instante haría falta
  una lista de sesiones consultada en cada petición, que es un viaje extra a la
  base en todas las rutas protegidas.
- **Segundo factor.** No hay. Para tres cuentas con contraseñas largas y el
  límite de intentos, es una decisión razonable; conviene revisarla si el panel
  crece.
