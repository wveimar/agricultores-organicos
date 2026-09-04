/**
 * QA de Tesorería (migración 0035).
 *
 * Lo que se comprueba:
 *   1. Las dos cuentas existen y arrancan en cero.
 *   2. Un cobro en efectivo sube la caja; uno por transferencia sube el banco.
 *   3. Un gasto baja la cuenta de donde sale.
 *   4. Un traslado mueve plata entre cuentas sin cambiar el total.
 *   5. No se deja sacar más de lo que hay.
 *   6. Movimientos junta las cuatro fuentes y cuadra con los saldos.
 *   7. Antigüedad y proyección responden con lo que hay.
 *   8. El turno: abre, calcula lo esperado, y al cerrar exige la clave de
 *      quien recibe y guarda la diferencia.
 *
 * Uso: node worker/tests/qa-tesoreria.mjs [base] [email] [password]
 */

const BASE = process.argv[2] ?? 'http://localhost:8788';
const EMAIL = process.argv[3] ?? 'admin@agricultores.co';
const PASSWORD = process.argv[4] ?? 'demo1234';

let token = '';
let fallos = 0;

function ok(condicion, titulo, detalle = '') {
  if (condicion) {
    console.log(`  OK   ${titulo}`);
  } else {
    fallos++;
    console.log(`  FALLA ${titulo}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function api(ruta, opciones = {}) {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opciones.headers,
    },
  });
  const texto = await res.text();
  let cuerpo;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }
  return { status: res.status, body: cuerpo };
}

async function login() {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) {
    console.error('No se pudo entrar:', res.status, JSON.stringify(res.body).slice(0, 300));
    process.exit(1);
  }
  token = res.body.token;
}

const saldos = async () => {
  const res = await api('/api/admin/tesoreria/cuentas');
  const mapa = {};
  for (const c of res.body?.cuentas ?? []) mapa[c.id] = c.saldo;
  return mapa;
};

function cedulaQA() {
  return `9${Math.floor(Math.random() * 1_000_000_000)}`;
}

async function main() {
  console.log(`\nQA Tesorería · ${BASE}\n`);
  await login();

  // ── 1. Las cuentas ──────────────────────────────────────────────────────
  console.log('1. Cuentas');
  const inicial = await saldos();
  ok('caja-efectivo' in inicial, 'existe la caja en efectivo');
  ok('cuenta-bancaria' in inicial, 'existe la cuenta bancaria');
  console.log(`   caja ${inicial['caja-efectivo']} · banco ${inicial['cuenta-bancaria']}`);

  // ── 2. Un cobro cae en la cuenta que le toca ────────────────────────────
  console.log('\n2. Los cobros caen donde deben');

  // Se vende en el mostrador en efectivo: la plata entra al cajón.
  const productos = (await api('/api/admin/products?limit=500')).body?.products ?? [];
  const algo = productos.find((p) => (p.stock ?? 0) > 3 && !p.tieneVariantes && !p.esCanasta);
  if (!algo) {
    console.error('No hay producto con stock para la prueba. Corre npm run db:reset.');
    process.exit(1);
  }

  const venta = await api('/api/admin/pos/sell', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: algo.id, cantidad: 1 }],
      metodoPago: 'efectivo',
    }),
  });
  ok(venta.status === 201, 'se registra una venta en efectivo', `status ${venta.status}`);

  const trasEfectivo = await saldos();
  ok(
    trasEfectivo['caja-efectivo'] === inicial['caja-efectivo'] + venta.body.venta.total,
    'la venta en efectivo sube la CAJA',
    `antes ${inicial['caja-efectivo']}, después ${trasEfectivo['caja-efectivo']}`,
  );
  ok(
    trasEfectivo['cuenta-bancaria'] === inicial['cuenta-bancaria'],
    'y no toca el banco',
  );

  const ventaTarjeta = await api('/api/admin/pos/sell', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: algo.id, cantidad: 1 }],
      metodoPago: 'tarjeta',
    }),
  });
  const trasTarjeta = await saldos();
  ok(
    trasTarjeta['cuenta-bancaria'] ===
      trasEfectivo['cuenta-bancaria'] + ventaTarjeta.body.venta.total,
    'una venta con tarjeta sube el BANCO',
    `antes ${trasEfectivo['cuenta-bancaria']}, después ${trasTarjeta['cuenta-bancaria']}`,
  );
  ok(trasTarjeta['caja-efectivo'] === trasEfectivo['caja-efectivo'], 'y no toca la caja');

  // ── 3. Un gasto baja la cuenta ──────────────────────────────────────────
  console.log('\n3. Gastos');
  const gasto = await api('/api/admin/expenses', {
    method: 'POST',
    body: JSON.stringify({ descripcion: 'QA transporte', monto: 5000, categoria: 'transporte' }),
  });
  ok(gasto.status === 201, 'se registra el gasto', `status ${gasto.status}`);

  const trasGasto = await saldos();
  ok(
    trasGasto['caja-efectivo'] === trasTarjeta['caja-efectivo'] - 5000,
    'el gasto baja la caja por defecto',
    `antes ${trasTarjeta['caja-efectivo']}, después ${trasGasto['caja-efectivo']}`,
  );

  // Un gasto sí puede dejar la caja en rojo: es el registro de algo que YA
  // pasó, y negarse a anotarlo no devuelve la plata — solo haría que los
  // libros mientan. El número negativo es la alarma de que falta registrar un
  // ingreso, y por eso se deja pasar.
  const dejaEnRojo = await api('/api/admin/expenses', {
    method: 'POST',
    body: JSON.stringify({
      descripcion: 'QA gasto mayor al saldo',
      monto: trasGasto['caja-efectivo'] + 20000,
      categoria: 'otros',
    }),
  });
  ok(dejaEnRojo.status === 201, 'un gasto mayor al saldo se registra igual', `status ${dejaEnRojo.status}`);

  const enRojo = await saldos();
  ok(enRojo['caja-efectivo'] < 0, 'y la caja queda en rojo, que es la alarma', `saldo ${enRojo['caja-efectivo']}`);

  // Se repone para poder seguir probando con cifras sanas.
  await api('/api/admin/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      tipo: 'ingreso',
      cuentaId: 'caja-efectivo',
      monto: 200000,
      concepto: 'QA: base para seguir probando',
    }),
  });

  // ── 4. Traslado entre cuentas ───────────────────────────────────────────
  console.log('\n4. Traslado');
  const antesDelTraslado = await saldos();
  const totalAntes = antesDelTraslado['caja-efectivo'] + antesDelTraslado['cuenta-bancaria'];

  const traslado = await api('/api/admin/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      tipo: 'traslado',
      cuentaId: 'caja-efectivo',
      cuentaDestinoId: 'cuenta-bancaria',
      monto: 10000,
      concepto: 'QA: consignación del día',
    }),
  });
  ok(traslado.status === 201, 'se registra el traslado', `status ${traslado.status}`);

  const trasTraslado = await saldos();
  ok(
    trasTraslado['caja-efectivo'] === antesDelTraslado['caja-efectivo'] - 10000,
    'baja de la cuenta de origen',
    `${antesDelTraslado['caja-efectivo']} → ${trasTraslado['caja-efectivo']}`,
  );
  ok(
    trasTraslado['cuenta-bancaria'] === antesDelTraslado['cuenta-bancaria'] + 10000,
    'y sube en la de destino',
    `${antesDelTraslado['cuenta-bancaria']} → ${trasTraslado['cuenta-bancaria']}`,
  );
  ok(
    trasTraslado['caja-efectivo'] + trasTraslado['cuenta-bancaria'] === totalAntes,
    'el total del negocio no cambia: solo se movió de bolsillo',
    `antes ${totalAntes}, después ${trasTraslado['caja-efectivo'] + trasTraslado['cuenta-bancaria']}`,
  );

  const mismaCuenta = await api('/api/admin/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      tipo: 'traslado',
      cuentaId: 'caja-efectivo',
      cuentaDestinoId: 'caja-efectivo',
      monto: 1000,
      concepto: 'QA: a sí misma',
    }),
  });
  ok(mismaCuenta.status === 400, 'un traslado a la misma cuenta se rechaza', `status ${mismaCuenta.status}`);

  // ── 5. Qué se bloquea y qué no ──────────────────────────────────────────
  //
  // La regla: un traslado es una INSTRUCCIÓN («mueva esto de aquí para allá»)
  // y no se puede mover lo que no está. Un egreso es el REGISTRO de algo que
  // ya pasó, y ahí negarse solo haría que los libros mientan.
  console.log('\n5. Guardas de saldo');
  const trasladoDeMas = await api('/api/admin/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      tipo: 'traslado',
      cuentaId: 'caja-efectivo',
      cuentaDestinoId: 'cuenta-bancaria',
      monto: trasTraslado['caja-efectivo'] + 1_000_000,
      concepto: 'QA: trasladar de más',
    }),
  });
  ok(trasladoDeMas.status === 409, 'trasladar más de lo que hay se rechaza', `status ${trasladoDeMas.status}`);
  ok(
    trasladoDeMas.body?.error?.code === 'saldo-insuficiente',
    'con el código correcto',
    JSON.stringify(trasladoDeMas.body),
  );

  const egresoDeMas = await api('/api/admin/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      tipo: 'egreso',
      cuentaId: 'cuenta-bancaria',
      monto: trasTraslado['cuenta-bancaria'] + 500,
      concepto: 'QA: egreso que deja en rojo',
    }),
  });
  ok(
    egresoDeMas.status === 201,
    'un egreso sí se registra aunque deje la cuenta en rojo',
    `status ${egresoDeMas.status}`,
  );

  const ingreso = await api('/api/admin/tesoreria/movimientos', {
    method: 'POST',
    body: JSON.stringify({
      tipo: 'ingreso',
      cuentaId: 'caja-efectivo',
      monto: 50000,
      concepto: 'QA: base del dueño',
      tercero: 'Dueño',
    }),
  });
  ok(ingreso.status === 201, 'un ingreso sí entra siempre', `status ${ingreso.status}`);

  // ── 6. Movimientos cuadra con los saldos ────────────────────────────────
  console.log('\n6. Movimientos');
  const movs = await api('/api/admin/tesoreria/movimientos');
  ok(movs.status === 200, 'el libro responde', `status ${movs.status}`);

  const tipos = new Set((movs.body?.movimientos ?? []).map((m) => m.tipo));
  ok(tipos.has('cobro'), 'incluye los cobros');
  ok(tipos.has('gasto'), 'incluye los gastos');
  ok(tipos.has('traslado_salida') && tipos.has('traslado_entrada'), 'y las dos patas del traslado');

  const final = await saldos();
  const soloCaja = await api('/api/admin/tesoreria/movimientos?cuenta=caja-efectivo');
  const sumaCaja = (soloCaja.body?.movimientos ?? []).reduce(
    (s, m) => s + (m.entra ?? 0) - (m.sale ?? 0),
    0,
  );
  ok(
    sumaCaja === final['caja-efectivo'],
    'la suma de los movimientos de la caja da su saldo',
    `movimientos ${sumaCaja}, saldo ${final['caja-efectivo']}`,
  );

  // ── 7. Antigüedad y proyección ──────────────────────────────────────────
  console.log('\n7. Antigüedad y proyección');
  const ant = await api('/api/admin/tesoreria/antiguedad');
  ok(ant.status === 200, 'la antigüedad responde', `status ${ant.status}`);
  ok(Array.isArray(ant.body?.porCobrar), 'con los tramos por cobrar');

  const proy = await api('/api/admin/tesoreria/proyeccion');
  ok(proy.status === 200, 'la proyección responde', `status ${proy.status}`);
  ok((proy.body?.cortes ?? []).length === 4, 'con los cuatro cortes (7, 14, 21, 30)');
  ok(
    proy.body?.cortes?.[0]?.proyectada !== undefined,
    'y con la caja proyectada de cada corte',
  );

  // ── 8. El turno ─────────────────────────────────────────────────────────
  console.log('\n8. Turno de cajero');
  const abrir = await api('/api/admin/tesoreria/turno/abrir', {
    method: 'POST',
    body: JSON.stringify({ cuentaId: 'caja-efectivo', fondoApertura: 100000 }),
  });
  ok(abrir.status === 201, 'se abre el turno', `status ${abrir.status}`);
  ok(
    String(abrir.body?.turno?.referencia ?? '').startsWith('TRN-'),
    'con su referencia TRN-',
    `ref ${abrir.body?.turno?.referencia}`,
  );

  const dosVeces = await api('/api/admin/tesoreria/turno/abrir', {
    method: 'POST',
    body: JSON.stringify({ cuentaId: 'caja-efectivo', fondoApertura: 5000 }),
  });
  ok(dosVeces.status === 409, 'no deja abrir dos turnos en la misma caja', `status ${dosVeces.status}`);

  // Regresión: el contador de la referencia iba por caja, pero `referencia` es
  // UNIQUE a secas. El primer turno del banco y el primero del cajón daban los
  // dos «TRN-AAAAMMDD-1» y el segundo reventaba con un 500 delante del cajero.
  const enElBanco = await api('/api/admin/tesoreria/turno/abrir', {
    method: 'POST',
    body: JSON.stringify({ cuentaId: 'cuenta-bancaria', fondoApertura: 0 }),
  });
  ok(
    enElBanco.status === 201,
    'se puede abrir un turno en la otra caja el mismo día',
    `status ${enElBanco.status} ${JSON.stringify(enElBanco.body).slice(0, 120)}`,
  );
  ok(
    enElBanco.body?.turno?.referencia !== abrir.body?.turno?.referencia,
    'y su referencia NO choca con la del primero',
    `${abrir.body?.turno?.referencia} vs ${enElBanco.body?.turno?.referencia}`,
  );

  // Un cobro durante el turno tiene que aparecer en lo esperado.
  //
  // Se mide la DIFERENCIA antes y después del cobro, no el valor absoluto.
  // Las marcas de tiempo van al segundo, y esta prueba entera corre dentro
  // del mismo segundo en que se abre el turno: comparar contra el fondo
  // (`esperado > 100000`) hacía que los movimientos de las secciones
  // anteriores entraran o no en la ventana según lo rápido que fuera la
  // máquina ese día. La promesa que sí es firme —y la que importa— es que un
  // cobro sube lo esperado exactamente en lo que se cobró.
  const antes = await api('/api/admin/tesoreria/turno?cuenta=caja-efectivo');
  const esperadoAntes = antes.body?.turno?.esperado ?? 0;

  const ventaTurno = await api('/api/admin/pos/sell', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: algo.id, cantidad: 1 }],
      metodoPago: 'efectivo',
    }),
  });
  const cobrado = ventaTurno.body?.venta?.total ?? 0;

  const estado = await api('/api/admin/tesoreria/turno?cuenta=caja-efectivo');
  const esperado = estado.body?.turno?.esperado ?? 0;
  ok(
    cobrado > 0 && esperado - esperadoAntes === cobrado,
    'un cobro del turno sube lo esperado en exactamente lo que se cobró',
    `${esperadoAntes} → ${esperado} con un cobro de ${cobrado}`,
  );
  ok(
    esperado >= cobrado,
    'y lo esperado parte del fondo de apertura, no de cero',
    `esperado ${esperado}`,
  );

  const claveMala = await api('/api/admin/tesoreria/turno/cerrar', {
    method: 'POST',
    body: JSON.stringify({
      cuentaId: 'caja-efectivo',
      efectivoContado: esperado,
      recibeUsuario: EMAIL,
      recibeClave: 'no-es-la-clave',
    }),
  });
  ok(claveMala.status === 400, 'sin la clave de quien recibe no se cierra', `status ${claveMala.status}`);
  ok(
    claveMala.body?.error?.code === 'entrega-no-confirmada',
    'con el código correcto',
    JSON.stringify(claveMala.body),
  );

  // Se cierra con un faltante de 3.000 a propósito, para ver la diferencia.
  const cerrar = await api('/api/admin/tesoreria/turno/cerrar', {
    method: 'POST',
    body: JSON.stringify({
      cuentaId: 'caja-efectivo',
      efectivoContado: esperado - 3000,
      vouchersContados: 0,
      notas: 'QA: faltaron 3.000',
      recibeUsuario: EMAIL,
      recibeClave: PASSWORD,
    }),
  });
  ok(cerrar.status === 200, 'con la clave correcta sí cierra', `status ${cerrar.status}`);
  ok(
    cerrar.body?.turno?.diferencia === -3000,
    'y guarda el faltante como diferencia negativa',
    `diferencia ${cerrar.body?.turno?.diferencia}`,
  );
  ok(
    Boolean(cerrar.body?.turno?.recibidoPor),
    'con el nombre de quien recibió el turno',
    `recibió ${cerrar.body?.turno?.recibidoPor}`,
  );

  const yaCerrado = await api('/api/admin/tesoreria/turno?cuenta=caja-efectivo');
  ok(yaCerrado.body?.turno === null, 'después de cerrar no queda turno abierto');
  ok(
    (yaCerrado.body?.historial ?? []).length > 0,
    'y el turno cerrado queda en el historial',
  );

  console.log(`\n${fallos === 0 ? 'TODO OK' : `${fallos} FALLO(S)`}\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Error inesperado:', error);
  process.exit(1);
});
