-- ============================================================================
--  Agricultores Orgánicos · esquema de Cloudflare D1 (SQLite)
--
--  Convenciones:
--  · El dinero se guarda como INTEGER en pesos colombianos. El COP no usa
--    decimales, así que enteros evitan por completo los errores de coma
--    flotante al sumar totales. Nunca uses REAL para dinero.
--  · Las fechas son TEXT en ISO-8601 UTC (formato de datetime('now')), que en
--    SQLite ordena y compara correctamente como cadena.
--  · Los CHECK no son decoración: son la última línea de defensa cuando dos
--    peticiones concurrentes pasan la validación de la aplicación a la vez.
-- ============================================================================

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS order_status_log;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cash_closings;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS products;

-- ────────────────────────────── Usuarios y roles ──────────────────────────────

CREATE TABLE users (
  id            TEXT    PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,
  nombre        TEXT    NOT NULL,
  -- Formato: pbkdf2$<iteraciones>$<salt b64url>$<hash b64url>.
  -- bcrypt/argon2 no están disponibles en el runtime de Workers sin WASM;
  -- PBKDF2-SHA256 sí lo está vía WebCrypto.
  password_hash TEXT    NOT NULL,
  activo        INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Tabla puente en vez de una columna con roles separados por comas: permite
-- indexar por rol y que la base rechace un rol inexistente.
CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN (
    'ADMIN_INVENTARIO', 'GESTOR_PEDIDOS', 'SUPER_ADMIN',
    'MAYORISTA_N1', 'MAYORISTA_N2', 'MAYORISTA_N3',
    'DOMICILIARIO'
  )),
  PRIMARY KEY (user_id, role)
);

-- Intentos de entrada fallidos, para frenar la fuerza bruta.
--
-- La clave es 'email:<correo>' o 'ip:<dirección>': se cuentan por separado
-- para que atacar una cuenta desde muchas IP y atacar muchas cuentas desde una
-- IP tropiecen las dos. Se borra la fila al entrar bien, así que la tabla solo
-- crece mientras alguien está fallando.
CREATE TABLE login_attempts (
  clave     TEXT    PRIMARY KEY,
  intentos  INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  ultimo_en TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ──────────────────────────────── Productos ────────────────────────────────

CREATE TABLE products (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  nombre          TEXT    NOT NULL,
  tagline         TEXT    NOT NULL DEFAULT '',
  categoria_id    TEXT    NOT NULL,
  -- Agrupación macro que usa el panel de compras.
  grupo_admin     TEXT    NOT NULL CHECK (grupo_admin IN ('frutas', 'verduras', 'agroindustriales')),

  precio          INTEGER NOT NULL CHECK (precio >= 0),
  -- Lo que se le paga a la finca. Nunca sale en la API pública.
  precio_costo    INTEGER NOT NULL DEFAULT 0 CHECK (precio_costo >= 0),
  precio_anterior INTEGER CHECK (precio_anterior IS NULL OR precio_anterior >= 0),

  unidad          TEXT    NOT NULL,
  -- Cuánto lleva la presentación que se vende: 500 con unidad 'gr', 5 con
  -- 'unidad'. `precio` es lo que se cobra por esa presentación entera.
  cantidad_unidad INTEGER NOT NULL DEFAULT 1 CHECK (cantidad_unidad > 0),
  origen          TEXT    NOT NULL,
  rating          REAL    NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  review_count    INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  badge           TEXT    CHECK (badge IS NULL OR badge IN ('nuevo', 'bestseller', 'temporada', 'ultimas-unidades')),
  -- "Más vendido" de la portada. Separado de `badge` porque `badge` es
  -- excluyente y un producto puede ser destacado *y* de temporada a la vez.
  -- Es una decisión comercial que se toma en el panel, no un reflejo del stock.
  --
  -- Llegó por la migración 0008 y llevaba desde entonces sin bajar aquí, así
  -- que `db:reset` dejaba una base sin esta columna y distinta de producción.
  -- Tras un reset nadie sale destacado: se marcan desde Inventario, o de golpe
  -- con `UPDATE products SET destacado = 1 WHERE badge = 'bestseller';`.
  destacado       INTEGER NOT NULL DEFAULT 0 CHECK (destacado IN (0, 1)),

  -- ¡Este CHECK es el que garantiza que nunca se venda de más!
  -- Si dos aprobaciones concurrentes intentan descontar el mismo stock, la
  -- segunda viola la restricción y D1 revierte toda su transacción.
  stock_actual    INTEGER NOT NULL DEFAULT 0 CHECK (stock_actual >= 0),
  -- Umbral de reposición: por debajo se alerta, pero se sigue vendiendo.
  stock_seguridad INTEGER NOT NULL DEFAULT 0 CHECK (stock_seguridad >= 0),

  -- Clasificación ABC materializada. Ojo: es una **caché**. La verdad se
  -- calcula en /api/reports/sales con una función de ventana sobre las ventas
  -- reales; esta columna la refresca POST /api/products/recalcular-abc.
  categoria_abc   TEXT    NOT NULL DEFAULT 'C' CHECK (categoria_abc IN ('A', 'B', 'C')),

  imagen          TEXT    NOT NULL,
  imagen_hover    TEXT,
  imagen_alt      TEXT    NOT NULL,
  activo          INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),

  -- Variantes (ver migración 0012). Cada presentación de la miel y cada sabor
  -- de la kambucha es una fila propia, porque cada una tiene su inventario
  -- físico y el CHECK de `stock_actual` protege una fila, no un JSON.
  -- `parent_id` apunta al producto sombrilla; NULL = producto normal o padre.
  -- ON DELETE SET NULL, no CASCADE: borrar un padre no puede llevarse el
  -- inventario de sus hijas, al que además apunta `order_items`.
  parent_id       TEXT    REFERENCES products(id) ON DELETE SET NULL
                          CHECK (parent_id IS NULL OR parent_id <> id),
  -- Qué distingue a las hijas, escrito en el padre: 'presentación', 'sabor'.
  variante_etiqueta TEXT,

  actualizado_en  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- El catálogo público filtra por activo y agrupa por categoría: un índice
-- parcial deja fuera las filas inactivas y mantiene el escaneo mínimo.
CREATE INDEX idx_products_categoria ON products (categoria_id) WHERE activo = 1;
CREATE INDEX idx_products_grupo     ON products (grupo_admin)  WHERE activo = 1;
-- Alertas de reposición: se resuelve leyendo solo el índice.
CREATE INDEX idx_products_stock     ON products (stock_actual, stock_seguridad) WHERE activo = 1;
-- "¿Quiénes son las hijas de este id?", una vez por padre. Parcial: las filas
-- sin madre —casi todo el catálogo— no ocupan sitio en él.
CREATE INDEX idx_products_parent    ON products (parent_id) WHERE parent_id IS NOT NULL;
-- La portada pide solo los destacados activos: se resuelve sin recorrer nada más.
CREATE INDEX idx_products_destacado ON products (destacado) WHERE activo = 1 AND destacado = 1;

-- ───────────────────────────── Cierres de caja ─────────────────────────────

CREATE TABLE cash_closings (
  id                 TEXT    PRIMARY KEY,
  referencia         TEXT    NOT NULL UNIQUE,
  cerrado_por        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cerrado_por_nombre TEXT    NOT NULL,
  cerrado_en         TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Estas cifras quedan congeladas y son la contabilidad de la jornada: si una
  -- se guarda en negativo por un error de cálculo, el descuadre queda grabado
  -- para siempre y no hay forma de recomputarlo (los pedidos ya se archivaron).
  -- El resto de tablas de dinero ya llevaban su CHECK; esta se quedó sin ellos.
  pedidos_count      INTEGER NOT NULL DEFAULT 0 CHECK (pedidos_count      >= 0),
  unidades_count     INTEGER NOT NULL DEFAULT 0 CHECK (unidades_count     >= 0),
  venta_producto     INTEGER NOT NULL DEFAULT 0 CHECK (venta_producto     >= 0),
  costo_producto     INTEGER NOT NULL DEFAULT 0 CHECK (costo_producto     >= 0),
  -- `ganancia` es la única que puede ser negativa a propósito: vender por
  -- debajo del costo es una decisión comercial posible, no un error de datos.
  ganancia           INTEGER NOT NULL DEFAULT 0,
  envios_cobrados    INTEGER NOT NULL DEFAULT 0 CHECK (envios_cobrados    >= 0),
  total_recaudado    INTEGER NOT NULL DEFAULT 0 CHECK (total_recaudado    >= 0)
);

CREATE INDEX idx_closings_fecha ON cash_closings (cerrado_en DESC);

-- ────────────────────────────────── Pedidos ──────────────────────────────────

CREATE TABLE orders (
  id                 TEXT    PRIMARY KEY,
  referencia         TEXT    NOT NULL UNIQUE,
  -- Cliente registrado. NULL cuando la compra fue de un invitado.
  user_id            TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cliente_nombre     TEXT    NOT NULL,
  cliente_telefono   TEXT    NOT NULL,
  cliente_direccion  TEXT    NOT NULL,

  estado             TEXT    NOT NULL DEFAULT 'pendiente'
                             CHECK (estado IN ('verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'pago')),

  -- 1 cuando el stock ya se descontó al crear el pedido (compras web).
  -- Es lo que impide el doble descuento al aprobarlo después.
  stock_reservado    INTEGER NOT NULL DEFAULT 0 CHECK (stock_reservado IN (0, 1)),

  subtotal           INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  envio              INTEGER NOT NULL DEFAULT 0 CHECK (envio >= 0),
  total              INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),

  comprobante_nombre TEXT,
  -- Imagen del comprobante de consignación, como data URL (JPEG recomprimido
  -- por el cliente a ~150–300 KB, ver shared/utils/image-file.ts).
  --
  -- Vive aquí y no en un almacén de objetos aparte: mantener una sola fuente
  -- de datos evita que un pedido y su comprobante puedan quedar
  -- desincronizados, y hace que borrar el pedido se lleve la imagen con él.
  -- El coste de tenerla en la fila se neutraliza no seleccionándola nunca en
  -- los listados: solo la lee GET /api/admin/orders/:id/comprobante.
  comprobante_url    TEXT,

  aprobado_por       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  aprobado_en        TEXT,
  -- Token de idempotencia de la aprobación. Ver el comentario largo en
  -- routes/orders.ts: es lo que hace que dos aprobaciones simultáneas del
  -- mismo pedido no descuenten el inventario dos veces.
  aprobacion_token   TEXT,

  -- Mismo papel que `aprobacion_token`, para la cancelación: sin él, dos
  -- cancelaciones simultáneas del mismo pedido devolverían el stock dos veces
  -- y el inventario acabaría inflado.
  cancelacion_token  TEXT,
  cancelado_por      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cancelado_en       TEXT,
  motivo_cancelacion TEXT,

  closing_id         TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,
  creado_en          TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Cómo se paga. 'transferencia' es el default: es la única forma que existió
  -- hasta que se agregó pago contra entrega.
  metodo_pago        TEXT    NOT NULL DEFAULT 'transferencia'
                             CHECK (metodo_pago IN ('transferencia', 'contraentrega')),

  -- Si el efectivo cobrado por el domiciliario ya está en la caja de la
  -- finca. Solo importa para 'contraentrega' — ver la migración 0015 para el
  -- porqué de que sea un paso separado de 'pago'.
  efectivo_liquidado INTEGER NOT NULL DEFAULT 0 CHECK (efectivo_liquidado IN (0, 1))
);

-- El panel lista por estado y por jornada abierta; ambos índices evitan
-- escanear la tabla completa cuando crezca.
CREATE INDEX idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX idx_orders_closing ON orders (closing_id);
CREATE INDEX idx_orders_user    ON orders (user_id);

CREATE TABLE order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- RESTRICT y no CASCADE: un producto que ya se vendió no se puede borrar sin
  -- romper el histórico de ventas. Se desactiva con activo = 0.
  product_id       TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Nombre y precios se copian, no se resuelven por JOIN al pintar: un pedido
  -- es un documento histórico y debe seguir mostrando lo que se cobró aunque
  -- el catálogo cambie después.
  producto_nombre  TEXT    NOT NULL,
  precio_unitario  INTEGER NOT NULL CHECK (precio_unitario >= 0),
  costo_unitario   INTEGER NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
  cantidad         INTEGER NOT NULL CHECK (cantidad > 0),

  -- Una sola línea por producto y pedido. Sin esto, dos líneas del mismo
  -- producto pasarían la validación de stock por separado y entre las dos se
  -- llevarían más unidades de las que hay.
  UNIQUE (order_id, product_id)
);

CREATE INDEX idx_items_order   ON order_items (order_id);
CREATE INDEX idx_items_product ON order_items (product_id);

-- ───────────────────────── Trazabilidad de pedidos ─────────────────────────
-- Cada cambio de estado queda registrado aquí, en la MISMA transacción que lo
-- produce (ver el batch() de create()/approve()/ship() en routes/orders.ts).
-- Sin eso, el log podría mostrar una transición que en realidad no llegó a
-- confirmarse, o callarse una que sí. Es lo que permite responder por
-- WhatsApp "¿en qué va mi pedido?" sin adivinar a partir de aprobado_en.
CREATE TABLE order_status_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  estado        TEXT    NOT NULL CHECK (estado IN (
    'verificacion', 'pendiente', 'aprobado', 'enviado', 'cancelado', 'editado',
    'pago', 'liquidado', 'rechazado'
  )),
  -- NULL en la creación del pedido: ese paso lo dispara el propio cliente,
  -- sin sesión de administrador detrás.
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_status_log_order ON order_status_log (order_id, creado_en);
