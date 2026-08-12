/**
 * Gestión de cuentas del panel: permisos, validación y protección contra
 * quedarse fuera del sistema.
 *
 *   npm run worker:dev
 *   node worker/tests/qa-usuarios.mjs [http://localhost:8788]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';

let fallos = 0;
const t = (ok, msg) => {
  console.log(`  ${ok ? '✔' : '✘'} ${msg}`);
  if (!ok) fallos++;
};
const seccion = (titulo) => console.log(`\n${titulo}`);

const login = async (email, password) => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

const call = async (path, token, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { headers: H(token), ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log(`== Usuarios del panel · ${BASE} ==`);

const admin = await login('admin@agricultores.co', 'demo1234');
const TOKEN = admin.body.token;
const SUPER_ID = admin.body.user.id;

const gestor = await login('pedidos@agricultores.co', 'demo1234');
const TOKEN_GESTOR = gestor.body.token;

// ────────────────────────────── Permisos ──────────────────────────────

seccion('1. Solo SUPER_ADMIN gestiona cuentas');

const listaSuper = await call('/api/admin/users', TOKEN);
t(listaSuper.status === 200, `SUPER_ADMIN lista cuentas → ${listaSuper.status}`);

const listaGestor = await call('/api/admin/users', TOKEN_GESTOR);
t(listaGestor.status === 403, `GESTOR_PEDIDOS lo intenta → ${listaGestor.status}`);

const sinSesion = await fetch(`${BASE}/api/admin/users`);
t(sinSesion.status === 401, `Sin sesión → ${sinSesion.status}`);

t(
  listaSuper.body.users.every((u) => !('password_hash' in u) && !('passwordHash' in u)),
  'La respuesta no incluye ningún hash de contraseña',
);

// ──────────────────────────── Alta de cuentas ────────────────────────────

seccion('2. Crear una cuenta');

const correo = `qa-${Date.now()}@agricultores.co`;
const CLAVE = 'claveDePrueba123';

const creada = await call('/api/admin/users', TOKEN, {
  method: 'POST',
  body: JSON.stringify({
    nombre: 'Cuenta QA',
    email: correo,
    password: CLAVE,
    roles: ['GESTOR_PEDIDOS'],
  }),
});
t(creada.status === 201, `Cuenta creada → ${creada.status}`);
const NUEVO_ID = creada.body?.user?.id;
t(creada.body?.user?.roles?.includes('GESTOR_PEDIDOS'), 'Se le asignó el rol pedido');

const entra = await login(correo, CLAVE);
t(entra.status === 200, `La cuenta nueva puede entrar → ${entra.status}`);

const duplicada = await call('/api/admin/users', TOKEN, {
  method: 'POST',
  body: JSON.stringify({ nombre: 'Otra', email: correo, password: CLAVE, roles: ['GESTOR_PEDIDOS'] }),
});
t(duplicada.status === 400 && duplicada.body?.error?.code === 'email-duplicado',
  `Correo repetido → ${duplicada.status} ${duplicada.body?.error?.code ?? ''}`);

seccion('3. Validación');

const corta = await call('/api/admin/users', TOKEN, {
  method: 'POST',
  body: JSON.stringify({ nombre: 'X', email: `c-${Date.now()}@x.co`, password: 'corta', roles: ['GESTOR_PEDIDOS'] }),
});
t(corta.status === 400, `Contraseña de 5 caracteres → ${corta.status}`);

const sinRoles = await call('/api/admin/users', TOKEN, {
  method: 'POST',
  body: JSON.stringify({ nombre: 'Sin roles', email: `s-${Date.now()}@x.co`, password: CLAVE, roles: [] }),
});
t(sinRoles.status === 400, `Sin ningún rol → ${sinRoles.status}`);

const rolInventado = await call('/api/admin/users', TOKEN, {
  method: 'POST',
  body: JSON.stringify({ nombre: 'Rol raro', email: `r-${Date.now()}@x.co`, password: CLAVE, roles: ['DIOS'] }),
});
t(rolInventado.status === 400, `Rol inexistente → ${rolInventado.status}`);

const emailMalo = await call('/api/admin/users', TOKEN, {
  method: 'POST',
  body: JSON.stringify({ nombre: 'Mal correo', email: 'no-es-correo', password: CLAVE, roles: ['GESTOR_PEDIDOS'] }),
});
t(emailMalo.status === 400, `Correo sin formato → ${emailMalo.status}`);

// ─────────────────── No poder dejarse fuera del sistema ───────────────────

seccion('4. Protección contra quedarse sin acceso');

const autoBaja = await call(`/api/admin/users/${SUPER_ID}`, TOKEN, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 0 }),
});
t(autoBaja.status === 400 && autoBaja.body?.error?.code === 'auto-desactivacion',
  `Desactivarse a uno mismo → ${autoBaja.status} ${autoBaja.body?.error?.code ?? ''}`);

const autoDegradar = await call(`/api/admin/users/${SUPER_ID}`, TOKEN, {
  method: 'PATCH',
  body: JSON.stringify({ roles: ['GESTOR_PEDIDOS'] }),
});
t(autoDegradar.status === 400 && autoDegradar.body?.error?.code === 'auto-degradacion',
  `Quitarse el rol de administración general → ${autoDegradar.status}`);

// ──────────────────────────── Contraseñas ────────────────────────────

seccion('5. Contraseñas');

const NUEVA = 'otraClaveSegura456';
const reset = await call(`/api/admin/users/${NUEVO_ID}`, TOKEN, {
  method: 'PATCH',
  body: JSON.stringify({ password: NUEVA }),
});
t(reset.status === 200, `SUPER_ADMIN asigna contraseña nueva → ${reset.status}`);

const conVieja = await login(correo, CLAVE);
t(conVieja.status === 401, `La contraseña vieja deja de servir → ${conVieja.status}`);

const conNueva = await login(correo, NUEVA);
t(conNueva.status === 200, `La nueva funciona → ${conNueva.status}`);
const TOKEN_NUEVO = conNueva.body.token;

// Cambio de la propia, que sí exige la actual.
const sinActual = await call('/api/auth/password', TOKEN_NUEVO, {
  method: 'POST',
  body: JSON.stringify({ actual: 'meLaInvento', nueva: 'terceraClave789' }),
});
t(sinActual.status === 401, `Cambiar la propia con la actual errónea → ${sinActual.status}`);

const propia = await call('/api/auth/password', TOKEN_NUEVO, {
  method: 'POST',
  body: JSON.stringify({ actual: NUEVA, nueva: 'terceraClave789' }),
});
t(propia.status === 200, `Con la actual correcta → ${propia.status}`);
t((await login(correo, 'terceraClave789')).status === 200, 'Entra con la que acaba de poner');

const propiaAjena = await call(`/api/admin/users/${SUPER_ID}`, TOKEN_NUEVO, {
  method: 'PATCH',
  body: JSON.stringify({ password: 'meCuelo123456' }),
});
t(propiaAjena.status === 403, `Un GESTOR cambiando la clave de otro → ${propiaAjena.status}`);

// ───────────────────────────── Dar de baja ─────────────────────────────

seccion('6. Quitar el acceso');

const baja = await call(`/api/admin/users/${NUEVO_ID}`, TOKEN, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 0 }),
});
t(baja.status === 200, `Cuenta desactivada → ${baja.status}`);

const intentaEntrar = await login(correo, 'terceraClave789');
t(intentaEntrar.status === 401, `Ya no puede entrar → ${intentaEntrar.status}`);

const sigueEnLista = await call('/api/admin/users', TOKEN);
t(
  sigueEnLista.body.users.some((u) => u.id === NUEVO_ID && u.activo === 0),
  'Sigue en la lista como inactiva (no se borra: el historial la nombra)',
);

const alta = await call(`/api/admin/users/${NUEVO_ID}`, TOKEN, {
  method: 'PATCH',
  body: JSON.stringify({ activo: 1 }),
});
t(alta.status === 200 && (await login(correo, 'terceraClave789')).status === 200,
  'Se le puede devolver el acceso');

console.log(fallos === 0 ? '\n✔ Todo en orden.' : `\n✘ ${fallos} comprobación(es) sin pasar.`);
if (fallos > 0) process.exitCode = 1;
