-- ───────────────────────────── Tesorería (0035) ─────────────────────────────
--
-- Responde dos preguntas que hoy nadie puede contestar sin sumar a mano:
-- «¿cuánto hay en el cajón?» y «¿cuánto hay en el banco?».
--
-- ── Por qué no se crea un libro de movimientos que lo lleve todo ──
--
-- La tentación es una tabla `movimientos` donde cada cobro, gasto y pago
-- escriba su fila. Sería una SEGUNDA verdad sobre el mismo hecho: el cobro ya
-- existe en `payments`, y mantener las dos sincronizadas es el tipo de cosa que
-- se rompe el día que alguien escriba un pago por otro camino. Este proyecto ya
-- rechazó esa idea antes — ver el comentario de `stockDeCanastas()` sobre por
-- qué el stock de una canasta no se guarda en una columna.
--
-- Lo que se hace en su lugar:
--   · a las tablas que YA mueven plata se les dice en qué cuenta la movieron
--     (`cuenta_id` en payments, expenses y provider_purchases);
--   · se crea `treasury_movements` SOLO para lo que hoy no tiene dónde vivir:
--     traslados entre cuentas, y los ingresos y egresos sueltos;
--   · «Movimientos» y el saldo de cada cuenta son la UNIÓN de esas cuatro
--     fuentes, calculada al leer. Un saldo calculado no puede desincronizarse.
--
-- ── Por qué los turnos no reemplazan el cierre de jornada ──
--
-- Son dos preguntas distintas. El turno responde «¿cuadró el cajón de este
-- cajero?» (arqueo, diferencia, entrega). El cierre de jornada responde
-- «¿cuánto se ganó hoy?» (ventas, costo, gastos, merma). Conviven: dentro de
-- una jornada puede haber varios turnos, y el cierre no se toca.

-- ─────────────────────────────── Las cuentas ───────────────────────────────
-- Dónde está la plata. Son pocas y las crea el administrador; no hay pantalla
-- de alta masiva porque una tienda tiene dos o tres, no doscientas.
CREATE TABLE treasury_accounts (
  id          TEXT    PRIMARY KEY,
  nombre      TEXT    NOT NULL,
  -- 'efectivo' es el cajón físico —el único que se cuenta a mano en un arqueo—
  -- y 'banco' es todo lo que llega por transferencia o datáfono.
  tipo        TEXT    NOT NULL CHECK (tipo IN ('efectivo', 'banco')),
  descripcion TEXT,
  -- Con cuánto arrancó la cuenta antes de que el sistema registrara nada. Sin
  -- esto, una caja que ya tenía plata el día que se instaló el sistema
  -- aparecería en cero hasta el primer cobro.
  saldo_inicial INTEGER NOT NULL DEFAULT 0,
  activo      INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  orden       INTEGER NOT NULL DEFAULT 0,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_treasury_accounts_activo ON treasury_accounts (activo, orden);

-- Las dos de siempre. Ids fijos y legibles: el Worker los usa como destino por
-- defecto según el método de pago, así que tienen que ser los mismos en
-- cualquier instalación.
INSERT INTO treasury_accounts (id, nombre, tipo, descripcion, orden) VALUES
  ('caja-efectivo',  'Caja (efectivo)', 'efectivo', 'El cajón del mostrador',      1),
  ('cuenta-bancaria','Cuenta bancaria', 'banco',    'Tarjeta y transferencias',    2);

-- ──────────────── En qué cuenta entró o salió lo que ya existe ────────────────
-- Nullable porque las filas viejas no lo sabían. Se rellenan enseguida, abajo,
-- y de ahí en adelante lo escribe el Worker.
ALTER TABLE payments            ADD COLUMN cuenta_id TEXT REFERENCES treasury_accounts(id);
ALTER TABLE expenses            ADD COLUMN cuenta_id TEXT REFERENCES treasury_accounts(id);
ALTER TABLE provider_purchases  ADD COLUMN cuenta_id TEXT REFERENCES treasury_accounts(id);

-- El histórico, repartido por el método con que se cobró: es la única pista
-- que existe hoy sobre dónde quedó esa plata, y es una pista buena.
UPDATE payments
   SET cuenta_id = CASE WHEN metodo = 'efectivo' THEN 'caja-efectivo'
                        ELSE 'cuenta-bancaria' END
 WHERE cuenta_id IS NULL;

-- Los gastos no guardan método. Se asumen del cajón, que es de donde sale un
-- gasto de tienda salvo aviso; el que fuera del banco se corrige a mano.
UPDATE expenses           SET cuenta_id = 'caja-efectivo'   WHERE cuenta_id IS NULL;
-- A las fincas se les gira, no se les paga del cajón.
UPDATE provider_purchases SET cuenta_id = 'cuenta-bancaria' WHERE cuenta_id IS NULL;

CREATE INDEX idx_payments_cuenta  ON payments           (cuenta_id, recibido_en DESC);
CREATE INDEX idx_expenses_cuenta  ON expenses           (cuenta_id, creado_en DESC);
CREATE INDEX idx_purchases_cuenta ON provider_purchases (cuenta_id, pagado_en DESC);

-- ──────────────── Lo que hoy no tiene dónde vivir: movimientos ────────────────
-- Traslados entre cuentas, y la plata que entra o sale sin ser un cobro, un
-- gasto ni una compra: un préstamo del dueño, una consignación, un retiro.
CREATE TABLE treasury_movements (
  id          TEXT    PRIMARY KEY,
  tipo        TEXT    NOT NULL CHECK (tipo IN ('ingreso', 'egreso', 'traslado')),
  -- En un traslado esta es la cuenta de DONDE sale; en un ingreso, a donde
  -- entra; en un egreso, de donde sale.
  cuenta_id   TEXT    NOT NULL REFERENCES treasury_accounts(id),
  -- Solo en los traslados: a dónde llega. Un traslado sin destino sería un
  -- egreso disfrazado, y el CHECK de abajo lo impide.
  cuenta_destino_id TEXT REFERENCES treasury_accounts(id),
  monto       INTEGER NOT NULL CHECK (monto > 0),
  concepto    TEXT    NOT NULL,
  -- Con quién fue, cuando aplica. Texto libre y no una FK a `contacts`: un
  -- ingreso puede venir del dueño, que no es cliente ni proveedor.
  tercero     TEXT,
  referencia  TEXT,
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Un traslado tiene destino y no puede ser a la misma cuenta; lo que no es
  -- traslado no puede tenerlo. Así no hay filas a medio significar.
  CHECK (
    (tipo = 'traslado' AND cuenta_destino_id IS NOT NULL AND cuenta_destino_id <> cuenta_id)
    OR (tipo <> 'traslado' AND cuenta_destino_id IS NULL)
  )
);

CREATE INDEX idx_treasury_movements_fecha  ON treasury_movements (creado_en DESC);
CREATE INDEX idx_treasury_movements_cuenta ON treasury_movements (cuenta_id, creado_en DESC);

-- ─────────────────────────── Turnos de cajero ───────────────────────────
-- El arqueo: con cuánto abrió, cuánto contó al cerrar y en cuánto falló.
--
-- Los cobros del turno NO se marcan con una columna en `payments`: se sacan por
-- rango de horas (`abierto_en` .. `cerrado_en`). Es lo mismo que hace un arqueo
-- de verdad —«lo que pasó por el cajón mientras yo estuve»— y evita otra
-- columna que habría que acordarse de escribir en cada camino que cobra.
CREATE TABLE cashier_shifts (
  id             TEXT    PRIMARY KEY,
  -- TRN-AAAAMMDD-N, con N reiniciando cada día. Lo arma el Worker.
  referencia     TEXT    NOT NULL UNIQUE,
  cuenta_id      TEXT    NOT NULL REFERENCES treasury_accounts(id),
  cajero_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cajero_nombre  TEXT    NOT NULL,
  abierto_en     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Con cuánta plata quedó el cajón para dar vueltas.
  fondo_apertura INTEGER NOT NULL DEFAULT 0 CHECK (fondo_apertura >= 0),

  -- Todo lo de abajo es NULL hasta que se cierra.
  cerrado_en     TEXT,
  -- Lo que el cajero contó de verdad, billete por billete.
  efectivo_contado  INTEGER CHECK (efectivo_contado IS NULL OR efectivo_contado >= 0),
  vouchers_contados INTEGER CHECK (vouchers_contados IS NULL OR vouchers_contados >= 0),
  -- Lo que el sistema decía que debía haber, congelado al cerrar: recalcularlo
  -- después daría otra cifra en cuanto alguien registre un cobro atrasado, y
  -- entonces la diferencia firmada dejaría de cuadrar con nada.
  efectivo_esperado INTEGER,
  -- Contado menos esperado. Negativa es faltante. Se guarda calculada para no
  -- tener que repetir la resta en cada pantalla que la muestre.
  diferencia     INTEGER,
  notas          TEXT,
  -- Quién recibe el turno. Se confirma con su usuario y su clave: es lo que
  -- convierte la entrega en algo que dos personas firmaron.
  recibido_por        TEXT REFERENCES users(id) ON DELETE SET NULL,
  recibido_por_nombre TEXT,
  CHECK (cerrado_en IS NULL OR efectivo_contado IS NOT NULL)
);

CREATE INDEX idx_shifts_abierto ON cashier_shifts (cuenta_id, cerrado_en);
CREATE INDEX idx_shifts_fecha   ON cashier_shifts (abierto_en DESC);
