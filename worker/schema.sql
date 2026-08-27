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

-- Hijas antes que madres. Con foreign_keys = ON, soltar una tabla que todavía
-- tiene filas apuntándole revienta con FOREIGN KEY constraint failed y deja el
-- fichero a medio aplicar.
--
-- Esta lista tiene que nombrarlas TODAS. Durante varias migraciones se quedó
-- corta —le faltaban las cinco que llegaron después de la 0006— y el efecto
-- era que `npm run db:reset` fallaba en seco al llegar a `DROP TABLE products`,
-- porque `product_components` seguía referenciándolo. Si mañana se agrega una
-- tabla nueva, va aquí arriba y en su sitio más abajo, o el reset vuelve a
-- romperse.
DROP TABLE IF EXISTS provider_purchase_items;
DROP TABLE IF EXISTS provider_purchases;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS order_item_components;
DROP TABLE IF EXISTS order_status_log;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cash_closings;
DROP TABLE IF EXISTS product_components;
DROP TABLE IF EXISTS product_wholesale_discounts;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS login_attempts;

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
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Crédito a mayoristas (migración 0017). 0 = esta cuenta no compra fiado,
  -- que es lo que le toca a todo el mundo salvo a quien se le abra cupo
  -- expresamente desde el panel.
  cupo_credito  INTEGER NOT NULL DEFAULT 0 CHECK (cupo_credito >= 0),
  -- A cuántos días vence lo que se le fía. De aquí sale `orders.vence_en`.
  dias_credito  INTEGER NOT NULL DEFAULT 0 CHECK (dias_credito >= 0)
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

-- Enlaces de recuperación de contraseña (migración 0006).
--
-- Se guarda el HASH del token, no el token: quien lea la base no puede
-- suplantar a nadie con lo que hay aquí. `usado_en` lo invalida tras el primer
-- uso, para que un enlace reenviado por correo no sirva dos veces.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now')),
  expira_en  TEXT NOT NULL,
  usado_en   TEXT
);

CREATE INDEX idx_resets_user ON password_resets (user_id);

-- ─────────────────────────────── Categorías ───────────────────────────────
-- Las secciones de la vitrina (migración 0013). `products.categoria_id` apunta
-- aquí por convención, sin FK: la restricción se añadiría recreando `products`
-- entera y no compensa — el panel es el único que escribe esa columna.

CREATE TABLE categories (
  id             TEXT    PRIMARY KEY,
  nombre         TEXT    NOT NULL,
  descripcion    TEXT    NOT NULL DEFAULT '',
  grupo_admin    TEXT    NOT NULL DEFAULT 'agroindustriales'
                         CHECK (grupo_admin IN ('frutas', 'verduras', 'agroindustriales')),
  -- Posición del chip en la vitrina. Menor va antes.
  orden          INTEGER NOT NULL DEFAULT 100,
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  -- Silueta del chip: 'hoja', 'panal', 'espiga'… Vacío = la de por defecto.
  -- Llegó en la 0016.
  icono          TEXT    NOT NULL DEFAULT '',
  actualizado_en TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_categories_orden ON categories (activo, orden);

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

-- ─────────────── Canastas: qué lleva dentro cada una (0014) ───────────────
-- La receta VIGENTE. Es lo que se descuenta del inventario al vender una
-- canasta, y lo que el cierre de caja usa para saber a qué finca pagarle por
-- lo que iba dentro (ver `calcularPagosAFincas()` en routes/reports.ts).

CREATE TABLE product_components (
  -- La canasta. Al borrarla se lleva su receta: sin canasta, la lista de lo
  -- que llevaba dentro no significa nada.
  parent_product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  -- El producto que la llena. RESTRICT y no CASCADE: borrar la papa mientras
  -- tres canastas la incluyen las dejaría prometiendo algo que ya no existe.
  child_product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- Cuánto entra de ese producto en UNA canasta, en sus propias
  -- presentaciones: 2 si lleva dos bolsas de 500 gr de las que ya se venden
  -- sueltas. No son gramos — es "cuántas de esas" — para que el descuento sea
  -- la misma resta que hace una venta normal, sin convertir unidades.
  cantidad_requerida INTEGER NOT NULL CHECK (cantidad_requerida > 0),

  PRIMARY KEY (parent_product_id, child_product_id),

  -- Una canasta no se contiene a sí misma.
  CHECK (parent_product_id <> child_product_id)
);

CREATE INDEX idx_components_child ON product_components (child_product_id);

-- ──────────────── Tarifas de mayorista por producto (0011) ────────────────

CREATE TABLE product_wholesale_discounts (
  product_id            TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  role                  TEXT    NOT NULL CHECK (role IN ('MAYORISTA_N1', 'MAYORISTA_N2', 'MAYORISTA_N3')),
  porcentaje_descuento  INTEGER NOT NULL CHECK (porcentaje_descuento > 0 AND porcentaje_descuento <= 100),
  actualizado_en        TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Un solo trato por producto y nivel.
  PRIMARY KEY (product_id, role)
);

CREATE INDEX idx_wholesale_role ON product_wholesale_discounts (role);

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
  -- Cuánto se cobró de domicilio en la jornada. Dato operativo para cuadrar
  -- con quien repartió: NO suma a `total_recaudado` ni a ninguna otra cifra
  -- de venta. Ese dinero pasa por la finca pero no se queda. Ver 0019.
  envios_cobrados    INTEGER NOT NULL DEFAULT 0 CHECK (envios_cobrados    >= 0),
  -- Solo venta de producto: es igual a `venta_producto`. Se conserva como
  -- columna propia porque es lo que lee el recibo y la lista de cierres, y
  -- porque un día podría volver a divergir (un descuento, un ajuste).
  total_recaudado    INTEGER NOT NULL DEFAULT 0 CHECK (total_recaudado    >= 0),

  -- Gastos operativos de la jornada (transporte, empaque, servicios). Se
  -- restan de `ganancia` junto con el costo de mercancía: es la diferencia
  -- entre "cuánto margen dejó la fruta" y "cuánto quedó de verdad". Ver 0020.
  total_gastos       INTEGER NOT NULL DEFAULT 0 CHECK (total_gastos       >= 0)
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
  --
  -- 'credito' vive aquí y no en `estado` a propósito: fiar no es una fase del
  -- pedido, es de dónde sale el dinero. Un pedido fiado sigue recorriendo
  -- aprobado → enviado como cualquier otro. Ver la migración 0017.
  metodo_pago        TEXT    NOT NULL DEFAULT 'transferencia'
                             CHECK (metodo_pago IN ('transferencia', 'contraentrega', 'credito')),

  -- Cuándo vence la deuda. NULL en todo lo que no sea 'credito': no hay nada
  -- que vencer donde el dinero ya entró o se cobra en la puerta.
  vence_en           TEXT,

  -- Si el efectivo cobrado por el domiciliario ya está en la caja de la
  -- finca. Solo importa para 'contraentrega' — ver la migración 0015 para el
  -- porqué de que sea un paso separado de 'pago'.
  efectivo_liquidado INTEGER NOT NULL DEFAULT 0 CHECK (efectivo_liquidado IN (0, 1)),

  -- Cuándo el domiciliario confirmó que tocó la puerta, para lo que NO es
  -- contra entrega. Un pedido por transferencia también sale a la calle y
  -- también hay que saber si sigue en camino, pero ahí no hay nada que cobrar
  -- — por eso es una marca aparte y no un estado nuevo: 'enviado' no cambia,
  -- solo se anota que ya llegó. En contra entrega no se usa: ahí `pagar()`
  -- confirma cobro y entrega en el mismo paso. Ver la migración 0018.
  entregado_en       TEXT
);

-- El panel lista por estado y por jornada abierta; ambos índices evitan
-- escanear la tabla completa cuando crezca.
CREATE INDEX idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX idx_orders_closing ON orders (closing_id);
CREATE INDEX idx_orders_user    ON orders (user_id);
-- La cartera pregunta siempre lo mismo: fiados, sin pagar, ordenados por
-- vencimiento. Los tres campos en el índice la resuelven sin tocar la tabla.
CREATE INDEX idx_orders_credito ON orders (metodo_pago, estado, vence_en);

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

-- La receta CONGELADA de las canastas de un pedido (migración 0014).
--
-- Copia de `product_components` en el momento de comprar, por lo mismo que
-- `order_items` copia `producto_nombre` y `precio_unitario`: el pedido es el
-- documento de lo que pasó, no una vista de lo que hay ahora. Si mañana se le
-- quita el tomate a la canasta, la devolución de stock de un pedido viejo
-- tiene que devolver el tomate que de verdad salió.
--
-- Es también lo que permite pagarle a la finca correcta: sin esto, el costo de
-- una canasta se le acreditaría entero a su propio `origen` —un texto como
-- "38 fincas asociadas"— en vez de repartirse entre quienes pusieron la fruta.
CREATE TABLE order_item_components (
  order_id           TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  parent_product_id  TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  child_product_id   TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Por canasta, no el total: multiplicado por las canastas de la línea da lo
  -- que se descontó. Guardar el total obligaría a rehacer la cuenta al editar
  -- la cantidad del pedido.
  cantidad_requerida INTEGER NOT NULL CHECK (cantidad_requerida > 0),

  PRIMARY KEY (order_id, parent_product_id, child_product_id)
);

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
    'pago', 'liquidado', 'rechazado', 'entregado'
  )),
  -- NULL en la creación del pedido: ese paso lo dispara el propio cliente,
  -- sin sesión de administrador detrás.
  actor_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  actor_nombre  TEXT,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_status_log_order ON order_status_log (order_id, creado_en);

-- ─────────────────── Gastos operativos y pago a las fincas ───────────────────
-- Lo que hace que `ganancia` sea la de verdad y no solo el margen de la fruta.
-- Ver la migración 0020 para el porqué de cada decisión.

CREATE TABLE expenses (
  id          TEXT    PRIMARY KEY,
  descripcion TEXT    NOT NULL,
  -- Estrictamente positivo: un gasto de cero es ruido en el informe. Para
  -- corregirse se borra, mientras la jornada siga abierta.
  monto       INTEGER NOT NULL CHECK (monto > 0),
  categoria   TEXT    NOT NULL CHECK (categoria IN ('transporte', 'empaque', 'servicios', 'otros')),
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL mientras la jornada sigue abierta; el cierre lo adopta, igual que a
  -- los pedidos. Con cierre puesto ya no se puede borrar: es cuenta congelada.
  closing_id  TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL
);

CREATE INDEX idx_expenses_closing ON expenses (closing_id, creado_en DESC);

-- ──────────────────────── Compras a las fincas (0021) ────────────────────────
--
-- Lo que se le compró a cada agricultor. Al registrarse sube el inventario y
-- se actualiza `products.precio_costo`; ese costo se congela en
-- `order_items.costo_unitario` al vender y de ahí sale el `costo_producto` del
-- cierre. Por eso la compra NO se resta de `ganancia`: ya está contada al
-- venderse. Restarla otra vez convertiría el inventario en bodega en pérdida.

CREATE TABLE provider_purchases (
  id          TEXT    PRIMARY KEY,
  -- Copia del `products.origen` al comprar, no una referencia: si renombran la
  -- finca en el catálogo, esta compra debe seguir diciendo a quién se le compró.
  origen      TEXT    NOT NULL,
  -- Suma del detalle, verificada por el servidor antes de escribirla.
  total_pago  INTEGER NOT NULL CHECK (total_pago >= 0),
  -- 'pendiente': la mercancía ya entró pero no se ha girado al agricultor.
  estado      TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado')),
  notas       TEXT,
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  pagado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  pagado_en   TEXT
);

CREATE INDEX idx_purchases_origen ON provider_purchases (origen, creado_en DESC);
CREATE INDEX idx_purchases_estado ON provider_purchases (estado, creado_en DESC);

CREATE TABLE provider_purchase_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE: borrar la compra se lleva su detalle. El stock que sumó se
  -- devuelve antes, en la misma transacción (ver remove() en purchases.ts).
  purchase_id    TEXT    NOT NULL REFERENCES provider_purchases(id) ON DELETE CASCADE,
  -- RESTRICT como en `order_items`: lo que alguna vez se compró no se borra
  -- del catálogo mientras esta línea lo nombre.
  product_id     TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  cantidad       INTEGER NOT NULL CHECK (cantidad > 0),
  -- El costo negociado ese día, congelado: una compra posterior a otro precio
  -- actualiza el catálogo, pero no reescribe esta línea.
  costo_unitario INTEGER NOT NULL CHECK (costo_unitario >= 0),
  subtotal       INTEGER NOT NULL CHECK (subtotal >= 0)
);

CREATE INDEX idx_purchase_items_purchase ON provider_purchase_items (purchase_id);
CREATE INDEX idx_purchase_items_product  ON provider_purchase_items (product_id);
