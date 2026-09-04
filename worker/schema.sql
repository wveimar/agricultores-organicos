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
-- Antes que `orders`: la FK de la factura al pedido es ON DELETE RESTRICT.
-- Y las asignaciones antes que las facturas, por su propio RESTRICT.
DROP TABLE IF EXISTS payment_allocations;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS invoice_items;
-- Antes que `invoices`: referencia una nota crédito, y por ella —aunque sea
-- de forma indirecta— a `treasury_accounts`, que también se suelta más abajo.
DROP TABLE IF EXISTS invoice_refunds;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS provider_payments;
DROP TABLE IF EXISTS provider_purchase_items;
DROP TABLE IF EXISTS provider_purchases;
-- Mermas antes que `products` y `cash_closings`: `merma_items` referencia el
-- producto con ON DELETE RESTRICT y la cabecera al cierre que la adoptó.
DROP TABLE IF EXISTS merma_items;
DROP TABLE IF EXISTS mermas;
DROP TABLE IF EXISTS expenses;
-- Tesorería: los hijos antes que las cuentas. `treasury_accounts` además la
-- referencian `payments`, `expenses` y `provider_purchases`, que ya se
-- soltaron arriba — por eso va después de ellas y no antes.
DROP TABLE IF EXISTS treasury_movements;
DROP TABLE IF EXISTS cashier_shifts;
DROP TABLE IF EXISTS treasury_accounts;
DROP TABLE IF EXISTS order_item_components;
DROP TABLE IF EXISTS order_status_log;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cash_closings;
DROP TABLE IF EXISTS product_components;
DROP TABLE IF EXISTS product_wholesale_discounts;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS user_roles;
-- Antes que `contacts`: desde la 0024, `users.contact_id` le apunta.
DROP TABLE IF EXISTS users;
-- Después de `orders`, `provider_purchases` y `users`, que le apuntan.
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
-- Después de `products` y `categories`, que le apuntan desde la 0025.
DROP TABLE IF EXISTS admin_groups;
DROP TABLE IF EXISTS login_attempts;
-- Sin FK en ninguna dirección: da igual dónde vaya, pero tiene que estar.
DROP TABLE IF EXISTS app_settings;

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

  -- ⚠ SIN USO desde la migración 0023. El crédito se mudó a
  -- `contacts.cupo_credito` porque la deuda la tiene una persona, no un login:
  -- la tienda se compra sin cuenta y no se le va a pedir contraseña al
  -- restaurante al que se le fía. Nada las lee ya, y el panel no las ofrece.
  --
  -- Siguen aquí porque quitarlas obligaría a recrear `users` entera, y media
  -- docena de tablas la referencian por FK. No las uses: pon el cupo en la
  -- ficha del contacto.
  cupo_credito  INTEGER NOT NULL DEFAULT 0 CHECK (cupo_credito >= 0),
  dias_credito  INTEGER NOT NULL DEFAULT 0 CHECK (dias_credito >= 0),

  -- Enlace manual a la ficha de la agenda (migración 0024). Lo pone un
  -- SUPER_ADMIN desde el panel de Usuarios. Desde que existe, el checkout de
  -- esta cuenta usa SIEMPRE esta ficha —sin importar qué teléfono teclee ese
  -- día— así que el cupo que se le abrió no se pierde entre una compra y otra.
  -- `contacts` se declara más abajo; SQLite no exige que exista todavía para
  -- aceptar esta referencia.
  contact_id    TEXT    REFERENCES contacts(id) ON DELETE SET NULL
);

-- Una ficha, como mucho, una cuenta enlazada. Parcial: sin enlazar es el
-- estado normal de casi todo el mundo.
CREATE UNIQUE INDEX idx_users_contact ON users (contact_id) WHERE contact_id IS NOT NULL;

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

-- ──────────────────── Contactos: proveedores y clientes (0022) ────────────────────
--
-- Una sola tabla para los dos porque son la misma clase de cosa y porque la
-- misma persona puede ser ambas: a una vereda se le compra lechuga y esa misma
-- vereda compra huevos. `es_proveedor` y `es_cliente` son banderas
-- independientes, no un tipo excluyente.
--
-- `products.origen` NO apunta aquí a propósito: el mismo producto se le puede
-- comprar a varias fincas, y una columna en el producto no puede decir eso.
-- Quién puso la mercancía se responde por compra (`provider_purchases`).

CREATE TABLE contacts (
  id             TEXT    PRIMARY KEY,
  nombre         TEXT    NOT NULL,

  es_proveedor   INTEGER NOT NULL DEFAULT 0 CHECK (es_proveedor IN (0, 1)),
  es_cliente     INTEGER NOT NULL DEFAULT 0 CHECK (es_cliente   IN (0, 1)),

  telefono       TEXT,
  direccion      TEXT,
  notas          TEXT,

  -- Para girarle a un proveedor. Opcionales: a un vecino se le paga en efectivo.
  banco          TEXT,
  tipo_cuenta    TEXT    CHECK (tipo_cuenta IS NULL OR tipo_cuenta IN ('ahorros', 'corriente', 'nequi', 'daviplata')),
  numero_cuenta  TEXT,
  titular        TEXT,

  -- La cédula (o NIT). Es la LLAVE DE NEGOCIO de la ficha: lo que el cajero
  -- teclea cuando el cliente se la dicta en el mostrador, y el campo que la
  -- DIAN exige para reportar una venta el día que haya factura electrónica.
  --
  -- NOT NULL y UNIQUE: una persona es una ficha. Sin la restricción, el mismo
  -- cliente acaba con tres fichas —una por cada vez que alguien lo dio de alta
  -- de prisa— y su deuda queda repartida entre las tres, que es justo el error
  -- que vuelve impagable una cartera.
  --
  -- La venta anónima del mostrador no deja la columna vacía: tiene su propia
  -- ficha, «Consumidor final», con el documento genérico 222222222222 que la
  -- DIAN reserva para eso. Así "sin identificar" es un cliente concreto y no
  -- un hueco en la tabla, y sigue habiendo una sola fila por documento.
  documento      TEXT    NOT NULL,

  -- Crédito (migración 0023). Vive aquí y no en `users` porque la deuda la
  -- tiene una persona, no un login: la tienda se compra sin cuenta y al
  -- restaurante al que se le fía cada semana no se le va a pedir contraseña.
  -- Todo pedido tiene `contact_id`, así que la ficha siempre está.
  --
  -- 0 = no se le fía, que es lo que le toca a todo el mundo salvo a quien se
  -- le abra cupo expresamente desde el panel.
  cupo_credito   INTEGER NOT NULL DEFAULT 0 CHECK (cupo_credito >= 0),
  -- A cuántos días vence lo fiado. De aquí sale `orders.vence_en`.
  dias_credito   INTEGER NOT NULL DEFAULT 0 CHECK (dias_credito >= 0),

  -- Desactivar en vez de borrar: compras y pedidos lo siguen nombrando.
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),

  creado_en      TEXT    NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Al final, no junto a las banderas: SQLite no admite volver a definir
  -- columnas después de una restricción de tabla. Un contacto que no es ni
  -- proveedor ni cliente no tendría pantalla donde aparecer.
  CHECK (es_proveedor = 1 OR es_cliente = 1)
);

-- El teléfono es la llave del cliente: el checkout de invitado no pide cuenta,
-- así que es lo único estable entre dos compras de la misma persona. Parcial
-- porque un proveedor puede no tener teléfono y varios NULL no chocan.
CREATE UNIQUE INDEX idx_contacts_telefono
  ON contacts (telefono) WHERE telefono IS NOT NULL AND telefono <> '';

-- La búsqueda del mostrador entra por aquí: el cajero teclea la cédula que le
-- dictan y tiene que resolver en un salto, no escaneando la tabla. El UNIQUE
-- es además lo que impide dos fichas para la misma persona.
CREATE UNIQUE INDEX idx_contacts_documento ON contacts (documento);

CREATE INDEX idx_contacts_proveedor ON contacts (es_proveedor, activo, nombre);
CREATE INDEX idx_contacts_cliente   ON contacts (es_cliente,   activo, nombre);
-- "¿A quién le tengo cupo abierto?", la pregunta de la cartera. Parcial: casi
-- nadie tiene crédito, y los que no lo tienen no ocupan sitio en el índice.
CREATE INDEX idx_contacts_credito   ON contacts (cupo_credito) WHERE cupo_credito > 0;

-- ────────────────────── Grupos del panel de compras (0025) ──────────────────────
-- "Frutas" / "Verduras" / "Agroindustriales" vivían fijos en un CHECK de
-- `products`, otro de `categories` y un tipo de TypeScript. Ahora son filas,
-- igual que las categorías desde la 0013.

CREATE TABLE admin_groups (
  id                  TEXT    PRIMARY KEY,
  nombre              TEXT    NOT NULL,
  -- Casilla "mostrar filtro adicional" de Inventario. Reemplaza comparar el
  -- nombre del grupo contra el literal 'agroindustriales': ahora el filtro
  -- fino se activa por esta bandera, así que renombrar o crear un grupo con
  -- el mismo comportamiento no depende de acertarle al texto exacto.
  mostrar_filtro_fino INTEGER NOT NULL DEFAULT 0 CHECK (mostrar_filtro_fino IN (0, 1)),
  orden               INTEGER NOT NULL DEFAULT 100,
  activo              INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  -- Silueta del avatar en la lista: 'hoja', 'panal', 'canasta'… Mismo
  -- repertorio que las categorías (`CategoryIcon`, migración 0016). Sin
  -- CHECK: una clave desconocida cae en la silueta por defecto. Vacío = «la
  -- que sea» (migración 0026).
  icono               TEXT    NOT NULL DEFAULT '',
  creado_en           TEXT    NOT NULL DEFAULT (datetime('now')),
  actualizado_en      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_admin_groups_orden ON admin_groups (activo, orden);

-- ─────────────────────────────── Categorías ───────────────────────────────
-- Las secciones de la vitrina (migración 0013). `products.categoria_id` apunta
-- aquí por convención, sin FK: la restricción se añadiría recreando `products`
-- entera y no compensa — el panel es el único que escribe esa columna.

CREATE TABLE categories (
  id             TEXT    PRIMARY KEY,
  nombre         TEXT    NOT NULL,
  descripcion    TEXT    NOT NULL DEFAULT '',
  -- ⚠ SIN USO desde la migración 0025. El grupo se mudó a `grupo_admin_id`
  -- (más abajo), que referencia la tabla `admin_groups` en vez de un CHECK con
  -- tres literales fijos. Sigue aquí porque quitarla no compensa, pero el
  -- panel ya no la lee ni la escribe.
  grupo_admin    TEXT    NOT NULL DEFAULT 'agroindustriales'
                         CHECK (grupo_admin IN ('frutas', 'verduras', 'agroindustriales')),
  -- El grupo de verdad. Sin CHECK: la validez la exige la aplicación contra
  -- `admin_groups`, igual que ya hace `categoria_id` en `products` — así un
  -- grupo nuevo no exige tocar el esquema.
  grupo_admin_id TEXT    REFERENCES admin_groups(id) ON DELETE SET NULL,
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
  -- ⚠ SIN USO desde la migración 0025 — ver el mismo aviso en `categories`.
  grupo_admin     TEXT    NOT NULL CHECK (grupo_admin IN ('frutas', 'verduras', 'agroindustriales')),
  -- El grupo de verdad, sin CHECK. `products` tiene FK con ON DELETE RESTRICT
  -- desde `order_items`/`order_item_components`/`provider_purchase_items`, así
  -- que quitar el CHECK de la columna vieja exigiría recrearla arrastrando el
  -- histórico de ventas y compras — de ahí la columna nueva en vez de tocar la
  -- de siempre. Mismo motivo que documenta la migración 0012 para no recrear
  -- esta tabla al añadir las variantes.
  grupo_admin_id  TEXT    REFERENCES admin_groups(id) ON DELETE SET NULL,

  precio          INTEGER NOT NULL CHECK (precio >= 0),
  -- Lo que se le paga a la finca. Nunca sale en la API pública.
  precio_costo    INTEGER NOT NULL DEFAULT 0 CHECK (precio_costo >= 0),
  precio_anterior INTEGER CHECK (precio_anterior IS NULL OR precio_anterior >= 0),

  unidad          TEXT    NOT NULL,
  -- Cuánto lleva la presentación que se vende: 500 con unidad 'gr', 5 con
  -- 'unidad'. `precio` es lo que se cobra por esa presentación entera.
  cantidad_unidad INTEGER NOT NULL DEFAULT 1 CHECK (cantidad_unidad > 0),
  -- 1 = se vende a granel, pesado en el mostrador (migración 0033): el
  -- cajero teclea un peso decimal en vez de un conteo de unidades. Decide
  -- si `order_items.cantidad` puede llegar fraccionaria para este producto
  -- — la validación vive en el Worker (`rejectFractional()` en orders.ts),
  -- no en un CHECK: uno que cruzara esta columna con `cantidad` exigiría
  -- recrear la tabla, y las demás columnas de cantidad/stock ya aceptan
  -- decimales tal cual gracias a la afinidad de tipos de SQLite.
  vendido_por_peso INTEGER NOT NULL DEFAULT 0 CHECK (vendido_por_peso IN (0, 1)),
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

  -- Lo que teclea el lector del mostrador (migración 0032). Nullable porque
  -- casi nada del catálogo de una finca trae código impreso: la fruta a granel
  -- no lo tiene, así que la búsqueda por nombre sigue siendo el camino
  -- principal de la caja y el escaneo es el atajo cuando lo hay.
  codigo_barras   TEXT,

  actualizado_en  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Único pero parcial, mismo patrón que `idx_contacts_telefono`: dos productos
-- no pueden compartir código, pero los muchos que no tienen ninguno no chocan
-- entre sí ni ocupan sitio en el índice.
CREATE UNIQUE INDEX idx_products_codigo_barras
  ON products (codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- El catálogo público filtra por activo y agrupa por categoría: un índice
-- parcial deja fuera las filas inactivas y mantiene el escaneo mínimo.
CREATE INDEX idx_products_categoria ON products (categoria_id) WHERE activo = 1;
CREATE INDEX idx_products_grupo     ON products (grupo_admin_id)  WHERE activo = 1;
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
  total_gastos       INTEGER NOT NULL DEFAULT 0 CHECK (total_gastos       >= 0),

  -- Lo que se dio de baja por merma en la jornada, valorado al COSTO
  -- (migración 0034). También se resta de `ganancia`: a diferencia de la
  -- compra a la finca —que se recupera al vender y por eso no se resta—, lo
  -- que se bota nunca pasa por una venta, así que su costo no lo descuenta
  -- nadie más. Sin esta columna la jornada mostraría un margen que no existe.
  total_merma        INTEGER NOT NULL DEFAULT 0 CHECK (total_merma        >= 0),

  -- Cuánto se COBRÓ en la jornada, frente a `total_recaudado`, que es cuánto
  -- se VENDIÓ (migración 0028). Las dos conviven porque responden preguntas
  -- distintas: esta cuadra con el dinero del cajón —incluidos abonos de
  -- facturas viejas—, la otra con el informe de ventas del día.
  total_cobrado      INTEGER NOT NULL DEFAULT 0 CHECK (total_cobrado      >= 0),

  -- Qué caja se cerró (migración 0032): la tienda web o el mostrador. El
  -- consolidado agrupa por esta columna para sumar las dos.
  --
  -- Sin CHECK a propósito, al contrario que `orders.canal`. Esta tabla es
  -- padre de `orders`, `payments` y `expenses`, y añadirle un CHECK habría
  -- exigido recrearla: en SQLite eso pasa por un DROP TABLE que, con las FK
  -- activas, dispara los borrados en cascada de sus hijas. No vale la pena
  -- arriesgar el histórico contable por una restricción declarativa cuando el
  -- único escritor de la columna es el Worker.
  canal              TEXT    NOT NULL DEFAULT 'ecommerce'
);

CREATE INDEX idx_closings_fecha ON cash_closings (cerrado_en DESC);
-- "Los cierres de esta caja", que es lo que agrupa el consolidado.
CREATE INDEX idx_closings_canal ON cash_closings (canal, cerrado_en DESC);

-- ────────────────────────────────── Pedidos ──────────────────────────────────

CREATE TABLE orders (
  id                 TEXT    PRIMARY KEY,
  referencia         TEXT    NOT NULL UNIQUE,
  -- Cliente registrado. NULL cuando la compra fue de un invitado.
  user_id            TEXT    REFERENCES users(id) ON DELETE SET NULL,
  -- Ficha del cliente en la agenda, encontrada o creada por teléfono al
  -- comprar (ver 0022). SET NULL: borrar un contacto nunca puede llevarse un
  -- pedido por delante.
  --
  -- Las tres columnas de abajo NO son redundantes con ella: son la copia de lo
  -- que el cliente escribió ESE día. Si mañana se muda, el pedido viejo tiene
  -- que seguir diciendo a dónde se llevó. Mismo criterio que
  -- `order_items.producto_nombre`.
  contact_id         TEXT    REFERENCES contacts(id) ON DELETE SET NULL,
  cliente_nombre     TEXT    NOT NULL,
  -- La cédula CON LA QUE SE VENDIÓ, copiada igual que el nombre y por el
  -- mismo motivo: el pedido es el documento de lo que pasó ese día. Si mañana
  -- se corrige una cédula mal tecleada en la ficha, esta venta tiene que
  -- seguir diciendo a nombre de quién se hizo — es lo que se reportó.
  --
  -- Copia y no FK a `contacts(documento)`: una llave natural en la relación
  -- obligaría a arrastrar en cascada pedidos, facturas, cobros y trazas cada
  -- vez que alguien arregla un dígito. El vínculo vivo es `contact_id`.
  cliente_cedula     TEXT    NOT NULL DEFAULT '',
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
  -- De dónde sale el dinero. UN valor por pedido, el de verdad:
  --
  --   'transferencia'     consigna y manda el comprobante
  --   'contraentrega'     paga en efectivo cuando el domiciliario toca la puerta
  --   'credito'           fiado, contra el cupo de su ficha
  --   'entrega_en_tienda' compra web que el cliente pasa a recoger y pagar
  --   'efectivo'          venta de mostrador, en billete
  --   'tarjeta'           venta de mostrador, con datáfono
  --
  -- ⚠ SIN CHECK, y es una decisión pensada, no un descuido.
  --
  -- En D1 una lista cerrada aquí es una lista que NO SE PUEDE AMPLIAR NUNCA:
  -- añadir un valor obliga a recrear la tabla, y recrear `orders` es imposible
  -- en cuanto tiene pedidos — el DROP TABLE choca con el RESTRICT de
  -- `invoices.order_id` y arrastra los CASCADE de `order_items`,
  -- `order_status_log` y `order_item_components`. Se probaron las cuatro
  -- salidas (foreign_keys = OFF, defer_foreign_keys, legacy_alter_table con
  -- doble renombrado, y el DROP directo) y ninguna funciona bajo wrangler,
  -- que envuelve cada fichero en una transacción. La migración 0031 nació
  -- muerta justo por esto.
  --
  -- Y el CHECK aquí no compraba lo que compra en otras columnas. El de
  -- `stock_actual >= 0` es una defensa contra CARRERAS: dos peticiones
  -- concurrentes pasan la validación de la aplicación y la base es lo único
  -- que las frena. Una lista de valores no tiene carrera posible — nada
  -- convierte 'efectivo' en basura entre la validación y el INSERT. Solo
  -- protege contra un error de programación, y de eso ya se encarga
  -- `readMetodoPago()` en routes/orders.ts, que además da un 400 legible en
  -- vez del texto crudo de SQLite.
  --
  -- Resumen: los CHECK que defienden invariantes de concurrencia se quedan;
  -- los que solo enumeran valores se van, porque en esta base cuestan la
  -- capacidad de evolucionar y no aportan seguridad real.
  metodo_pago        TEXT    NOT NULL DEFAULT 'transferencia',

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
  entregado_en       TEXT,

  -- Quién lo lleva (migración 0029). SET NULL: si la cuenta del domiciliario
  -- se borra, el pedido sigue existiendo — se pierde el vínculo, no la venta.
  -- Por eso el nombre se copia congelado, igual que `cliente_nombre`.
  domiciliario_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  domiciliario_nombre TEXT,

  -- De dónde salió la venta (migración 0032). Es lo que permite tener dos
  -- cierres de caja separados —el de la tienda web y el del mostrador— que
  -- luego se suman en un consolidado. Va como columna y no como una tabla
  -- `pos_cash_closings` aparte a propósito: una tabla paralela obligaría a
  -- duplicar RECAUDADO_WHERE y closeCash(), y dos verdades sobre el mismo
  -- hecho es justo lo que advierte el comentario de esa constante.
  --
  -- Se llama `canal` y no `origen` porque `products.origen` ya significa "de
  -- qué finca viene": reusar el nombre confundiría al leer el código.
  -- Sin CHECK por lo mismo que `metodo_pago`: que abrir un canal nuevo mañana
  -- —un marketplace, una segunda tienda— no obligue a recrear una tabla que no
  -- se puede recrear. Lo valida el Worker.
  canal               TEXT NOT NULL DEFAULT 'ecommerce',

  -- Si el cliente pidió recibo impreso en el mostrador. Dato operativo; NO
  -- condiciona la reimpresión: cualquier factura se puede volver a imprimir
  -- siempre desde GET /api/admin/invoices/:id.
  recibo_solicitado   INTEGER NOT NULL DEFAULT 0
);

-- "¿Qué llevo yo hoy?". Parcial: casi ningún pedido tiene domiciliario.
CREATE INDEX idx_orders_domiciliario
  ON orders (domiciliario_id, estado) WHERE domiciliario_id IS NOT NULL;

-- El panel lista por estado y por jornada abierta; ambos índices evitan
-- escanear la tabla completa cuando crezca.
CREATE INDEX idx_orders_estado  ON orders (estado, creado_en DESC);
CREATE INDEX idx_orders_closing ON orders (closing_id);
CREATE INDEX idx_orders_user    ON orders (user_id);
-- La cartera pregunta siempre lo mismo: fiados, sin pagar, ordenados por
-- vencimiento. Los tres campos en el índice la resuelven sin tocar la tabla.
CREATE INDEX idx_orders_credito ON orders (metodo_pago, estado, vence_en);
-- "Todos los pedidos de este cliente", que es la ficha de la agenda.
CREATE INDEX idx_orders_contact ON orders (contact_id);
-- "Todo lo que ha comprado esta cédula", que es como pregunta el mostrador:
-- el cliente dicta su número, no el id interno de su ficha.
CREATE INDEX idx_orders_cedula  ON orders (cliente_cedula, creado_en DESC);
-- "Las ventas de caja de hoy", que es lo que pregunta el historial del POS en
-- cada carga. Parcial: la caja física es una fracción de todos los pedidos.
CREATE INDEX idx_orders_canal   ON orders (canal, creado_en DESC) WHERE canal = 'pos';

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

  -- Por qué esta línea no salió al precio calculado (migración 0032). NULL =
  -- precio automático, de lista o con el descuento de mayorista que le toque
  -- al cliente. Con texto = el cajero lo cambió a mano en el mostrador, y esto
  -- es la razón que dio.
  --
  -- El negocio decidió no poner tope al descuento manual: el control es que
  -- quede registrado, no un límite en el código. El "quién" no se duplica
  -- aquí — ya lo captura `order_status_log.actor_id` en la fila 'editado' que
  -- se escribe en la misma transacción.
  motivo_ajuste    TEXT,

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

-- ────────────────────────────── Facturación (0027) ──────────────────────────────
-- El pedido es logística y se puede editar; la factura es contabilidad y no se
-- edita nunca. Separarlas es lo que permite cobrar por partes sin que la deuda
-- del cliente se mueva cada vez que alguien corrige una línea del pedido.
-- Ver la migración 0027 para el razonamiento completo.

CREATE TABLE invoices (
  id                TEXT    PRIMARY KEY,

  -- Consecutivo de la numeración. No se deriva de COUNT(*): contar filas
  -- reutilizaría un número si alguna vez se borra una factura, y un
  -- consecutivo con huecos es un problema, pero uno repetido es un fraude.
  consecutivo       INTEGER NOT NULL UNIQUE,
  -- Lo que se lee e imprime: «FAC-000123». Se guarda ya formateado porque el
  -- día que haya resolución DIAN el prefijo cambia, y las ya emitidas tienen
  -- que conservar el número con el que salieron.
  numero            TEXT    NOT NULL UNIQUE,

  -- RESTRICT: una factura emitida es un hecho contable y borrar el pedido no
  -- puede llevársela. NULL deja la puerta abierta a una venta de mostrador.
  order_id          TEXT    REFERENCES orders(id)   ON DELETE RESTRICT,
  -- Apunta a `contacts` y no a `users` por lo mismo que el crédito en la 0023:
  -- se compra sin cuenta, y la deuda es de una persona, no de un login.
  contact_id        TEXT    REFERENCES contacts(id) ON DELETE RESTRICT,

  -- Copia congelada, igual que `orders.cliente_nombre`.
  cliente_nombre    TEXT    NOT NULL,
  cliente_telefono  TEXT    NOT NULL DEFAULT '',
  -- Igual que en `orders`: es el dato que la DIAN pide para reportar la
  -- venta, y una factura emitida no se reescribe nunca.
  cliente_cedula    TEXT    NOT NULL DEFAULT '',

  subtotal          INTEGER NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  envio             INTEGER NOT NULL DEFAULT 0 CHECK (envio    >= 0),
  total             INTEGER NOT NULL DEFAULT 0 CHECK (total    >= 0),

  -- Lo que falta por cobrar. Materializado y no calculado con SUM() sobre los
  -- abonos: la cartera lo pregunta en cada carga del panel. Se recalcula
  -- siempre dentro del mismo `batch()` que inserta el abono.
  saldo             INTEGER NOT NULL DEFAULT 0 CHECK (saldo >= 0),

  -- Cuánto de una nota crédito ya se devolvió en plata (migración 0037).
  -- Caché recalculada desde `invoice_refunds`, igual que `monto_pagado` en
  -- `provider_purchases`. En una FACTURA se queda siempre en 0: una factura
  -- no se «devuelve», se corrige con una nota. `saldo` de una nota es siempre
  -- 0 por diseño (no se cobra, corrige) — este es el campo que sí le importa.
  monto_devuelto    INTEGER NOT NULL DEFAULT 0,

  estado            TEXT    NOT NULL DEFAULT 'emitida'
                            CHECK (estado IN ('emitida', 'pagada_parcial', 'pagada', 'anulada')),

  emitida_en        TEXT    NOT NULL DEFAULT (datetime('now')),
  vence_en          TEXT,

  anulada_en        TEXT,
  anulada_por       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  motivo_anulacion  TEXT,

  -- ── Notas crédito y débito (migración 0030) ──
  --
  -- Una nota vive en esta misma tabla, como en Odoo y QuickBooks: es un
  -- documento con líneas, número y estado, igual que una factura. Lo único
  -- que cambia es qué le hace al saldo de otra.
  --
  --   'factura'      → lo que se cobra
  --   'nota_credito' → RESTA de la factura de origen (devolución, descuento,
  --                    corrección de algo ya cobrado que no se puede editar)
  --   'nota_debito'  → SUMA a la factura de origen (mora, reenvío, cargo extra)
  tipo              TEXT    NOT NULL DEFAULT 'factura'
                            CHECK (tipo IN ('factura', 'nota_credito', 'nota_debito')),
  -- Qué factura corrige. Obligatorio en las notas, NULL en las facturas: lo
  -- garantiza el CHECK de abajo, no solo el endpoint.
  --
  -- CASCADE, no RESTRICT: una nota no existe sin su factura —es una corrección
  -- SOBRE ella— así que si la factura se va, sus notas se van con ella. Con
  -- RESTRICT, además, la FK apunta a la propia tabla y `DROP TABLE invoices`
  -- chocaba consigo misma: cada nota bloqueaba el borrado de su factura y el
  -- esquema no se podía recrear.
  --
  -- Lo que de verdad protege el dinero es la FK de `payment_allocations`, que
  -- sí es RESTRICT: una factura con cobros encima no se borra pase lo que pase.
  invoice_origen_id TEXT    REFERENCES invoices(id) ON DELETE CASCADE,

  -- Una nota SIEMPRE corrige algo, y una factura nunca corrige nada. Sin esto
  -- podría existir una nota crédito suelta, que no significa nada: no habría
  -- deuda de la que restar.
  CHECK (
    (tipo = 'factura'      AND invoice_origen_id IS NULL) OR
    (tipo <> 'factura'     AND invoice_origen_id IS NOT NULL)
  )

  -- Aquí vivía `CHECK (saldo <= total)`. Se quitó con las notas débito: un
  -- cargo extra sobre una factura ya emitida hace que el saldo pase del total
  -- original a propósito, y el CHECK habría bloqueado el caso legítimo.
);

-- Un pedido tiene como mucho una factura viva. Parcial sobre las no anuladas:
-- anular y reemitir es el camino previsto para corregir.
CREATE UNIQUE INDEX idx_invoices_order_viva
  ON invoices (order_id) WHERE order_id IS NOT NULL AND estado <> 'anulada';

CREATE INDEX idx_invoices_cartera ON invoices (estado, vence_en);
CREATE INDEX idx_invoices_contact ON invoices (contact_id, emitida_en DESC);
-- El estado de cuenta buscado por cédula, sin pasar por la ficha.
CREATE INDEX idx_invoices_cedula  ON invoices (cliente_cedula, emitida_en DESC);
-- "¿Qué notas tiene esta factura encima?", que es lo que el saldo pregunta en
-- cada recálculo. Parcial: casi ninguna factura acaba teniendo notas.
CREATE INDEX idx_invoices_origen
  ON invoices (invoice_origen_id) WHERE invoice_origen_id IS NOT NULL;

-- Cada devolución de dinero, atada a la nota crédito que la autoriza
-- (migración 0037).
--
-- Una nota crédito ya podía emitirse contra una factura pagada por completo
-- —eso es justamente una devolución— pero sin esta tabla esa plata no
-- quedaba registrada en ningún lado: `saldo` de una nota es siempre 0 por
-- diseño. Es la misma forma que `provider_payments` (0036) para los abonos a
-- una finca: una fila por movimiento, con su propia cuenta y su propia fecha,
-- porque una devolución también se puede pagar en varias partes.
CREATE TABLE invoice_refunds (
  id                TEXT    PRIMARY KEY,
  -- CASCADE: una devolución no significa nada sin la nota que la autoriza.
  nota_credito_id   TEXT    NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  monto             INTEGER NOT NULL CHECK (monto > 0),
  -- Sin CHECK, igual que `payments.metodo`: la lista vive en el Worker.
  metodo            TEXT    NOT NULL DEFAULT 'efectivo',
  cuenta_id         TEXT    REFERENCES treasury_accounts(id),
  observaciones     TEXT,
  devuelto_por      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  devuelto_en       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invoice_refunds_nota   ON invoice_refunds (nota_credito_id, devuelto_en DESC);
CREATE INDEX idx_invoice_refunds_cuenta ON invoice_refunds (cuenta_id, devuelto_en DESC);

-- Líneas de la factura, congeladas igual que `order_items`. Existen para que
-- una factura pueda vivir sin pedido detrás (venta de mostrador, un servicio):
-- sin ellas, facturar a mano obligaría a inventar un pedido falso.
CREATE TABLE invoice_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE: una línea no significa nada sin su factura. Lo que no se borra es
  -- una factura con dinero encima, y eso lo defiende el endpoint.
  invoice_id      TEXT    NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  -- NULL permitido: se puede cobrar algo que no está en el catálogo. SET NULL
  -- y no RESTRICT: retirar un producto no puede reescribir una factura vieja
  -- — el nombre cobrado vive en `descripcion`.
  product_id      TEXT    REFERENCES products(id) ON DELETE SET NULL,
  descripcion     TEXT    NOT NULL,
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario INTEGER NOT NULL CHECK (precio_unitario >= 0),
  -- Redundante con cantidad × precio a propósito: es la cifra que se imprimió.
  importe         INTEGER NOT NULL CHECK (importe >= 0)
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items (invoice_id);

-- ─────────────────────── Cartera: abonos y cobros (0028) ───────────────────────
-- Modelo de tres tablas (invoices ← payment_allocations → payments), el mismo
-- de Odoo, QuickBooks y Xero. La tabla del medio es la que permite que un pago
-- cubra varias facturas y que una factura reciba varios abonos.
-- Ver la migración 0028 para el razonamiento completo.

CREATE TABLE payments (
  id                  TEXT    PRIMARY KEY,
  -- Serie propia, aparte de la de facturas.
  referencia          TEXT    NOT NULL UNIQUE,

  contact_id          TEXT    REFERENCES contacts(id) ON DELETE RESTRICT,
  -- Copia congelada, igual que en `invoices`.
  cliente_nombre      TEXT    NOT NULL,

  monto               INTEGER NOT NULL CHECK (monto > 0),
  -- 'efectivo', 'transferencia', 'nequi', 'daviplata', 'tarjeta'.
  --
  -- Sin CHECK por el mismo motivo que `orders.metodo_pago`, agravado aquí:
  -- recrear `payments` dispararía el CASCADE de `payment_allocations` y se
  -- llevaría por delante la asignación de cobros a facturas, que es la cartera
  -- entera. Lo valida `leerMetodo()` en routes/payments.ts.
  metodo              TEXT    NOT NULL DEFAULT 'efectivo',

  -- Cuándo entró la plata. No tiene por qué coincidir con la fecha de la
  -- factura: representar ese desfase es el motivo de este módulo.
  recibido_en         TEXT    NOT NULL DEFAULT (datetime('now')),
  recibido_por        TEXT    REFERENCES users(id) ON DELETE SET NULL,
  recibido_por_nombre TEXT    NOT NULL DEFAULT '',

  -- 0 solo para el efectivo que un domiciliario aún no ha entregado en la
  -- finca. Misma distinción que `orders.efectivo_liquidado` (0015): un cierre
  -- que cuente ese dinero cuenta plata que nadie ha visto.
  liquidado           INTEGER NOT NULL DEFAULT 1 CHECK (liquidado IN (0, 1)),

  closing_id          TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,

  comprobante_url     TEXT,
  nota                TEXT,

  -- Por qué CAJA entró la plata: 'ecommerce' o 'pos' (migración 0032).
  -- `payments` no tiene FK a `orders`, así que sin esta columna el cierre del
  -- mostrador no podría distinguir sus cobros de los de cartera al barrer
  -- `closing_id IS NULL`. Es también lo que hace que un abono que alguien viene
  -- a pagar a la tienda cuadre contra el cierre del POS: ese billete está en
  -- ESE cajón.
  canal               TEXT    NOT NULL DEFAULT 'ecommerce',

  -- En qué CUENTA quedó la plata (migración 0035): el cajón o el banco.
  -- Distinto de `canal`, que dice por qué puerta entró la venta, y distinto de
  -- `metodo`, que dice cómo pagó el cliente. Un cobro en efectivo hecho en la
  -- tienda web —el domiciliario que trae el billete— es canal 'ecommerce',
  -- método 'efectivo' y cuenta 'caja-efectivo': las tres cosas a la vez, y
  -- ninguna se puede deducir de las otras dos.
  cuenta_id           TEXT    REFERENCES treasury_accounts(id)
);

CREATE INDEX idx_payments_closing ON payments (closing_id, liquidado);
CREATE INDEX idx_payments_contact ON payments (contact_id, recibido_en DESC);
CREATE INDEX idx_payments_canal   ON payments (canal, closing_id);

-- Cuánto de este pago salda esta factura. La suma de las asignaciones de un
-- pago nunca pasa de su monto; lo que sobra es anticipo. Esa invariante no
-- cabe en un CHECK (SQLite no admite subconsultas ahí): la impone el endpoint
-- dentro del mismo batch que inserta.
CREATE TABLE payment_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT    NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  -- RESTRICT: una factura con plata asignada no se borra.
  invoice_id TEXT    NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  monto      INTEGER NOT NULL CHECK (monto > 0),
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX idx_allocations_invoice ON payment_allocations (invoice_id);

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
  closing_id  TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL,
  -- De qué cuenta salió la plata (migración 0035). Sin esto, un gasto bajaba
  -- la ganancia pero no bajaba ningún saldo, y el cajón cuadraba de menos.
  cuenta_id   TEXT    REFERENCES treasury_accounts(id)
);

CREATE INDEX idx_expenses_closing ON expenses (closing_id, creado_en DESC);
CREATE INDEX idx_expenses_cuenta  ON expenses (cuenta_id, creado_en DESC);

-- ──────────────────────── Compras a las fincas (0021) ────────────────────────
--
-- Lo que se le compró a cada agricultor. Al registrarse sube el inventario y
-- se actualiza `products.precio_costo`; ese costo se congela en
-- `order_items.costo_unitario` al vender y de ahí sale el `costo_producto` del
-- cierre. Por eso la compra NO se resta de `ganancia`: ya está contada al
-- venderse. Restarla otra vez convertiría el inventario en bodega en pérdida.

CREATE TABLE provider_purchases (
  id          TEXT    PRIMARY KEY,
  -- El proveedor en la agenda. SET NULL para que desactivar o borrar una ficha
  -- no borre la compra: para eso está `origen`, que conserva el nombre.
  contact_id  TEXT    REFERENCES contacts(id) ON DELETE SET NULL,
  -- El nombre del proveedor COPIADO al comprar. No es redundante con
  -- `contact_id`: si mañana se corrige la ficha, esta compra debe seguir
  -- diciendo a quién se le compró ese día.
  origen      TEXT    NOT NULL,
  -- Suma del detalle, verificada por el servidor antes de escribirla.
  total_pago  INTEGER NOT NULL CHECK (total_pago >= 0),
  -- 'pendiente': la mercancía ya entró pero no se ha terminado de girar.
  estado      TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado')),
  -- Suma de los abonos de `provider_payments` (migración 0036). Es una CACHÉ,
  -- no una verdad: se recalcula desde esa tabla en el mismo lote que inserta
  -- cada abono, nunca se incrementa a ciegas, así que no puede desviarse.
  monto_pagado INTEGER NOT NULL DEFAULT 0,
  notas       TEXT,
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  pagado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  pagado_en   TEXT,
  -- De qué cuenta se le giró (migración 0035). Se escribe al marcar el pago,
  -- no al registrar la compra: mientras está pendiente no ha salido plata de
  -- ningún lado, y por eso la compra pendiente no toca ningún saldo.
  cuenta_id   TEXT    REFERENCES treasury_accounts(id)
);

CREATE INDEX idx_purchases_origen ON provider_purchases (origen, creado_en DESC);
CREATE INDEX idx_purchases_cuenta ON provider_purchases (cuenta_id, pagado_en DESC);
CREATE INDEX idx_purchases_estado  ON provider_purchases (estado, creado_en DESC);
-- "Todo lo que le he comprado a este proveedor", que es su ficha en la agenda.
CREATE INDEX idx_purchases_contact ON provider_purchases (contact_id);

-- Cada giro a una finca, uno por fila (migración 0036).
--
-- Una compra se puede abonar en varias veces: hoy lo que hay en el cajón, el
-- viernes el resto por transferencia. Cada abono trae SU cuenta y SU fecha,
-- que es lo que necesita el libro de Tesorería para cuadrar contra el cajón.
-- Con una sola columna «monto_pagado» en la compra, dos abonos de bolsillos
-- distintos serían indistinguibles y el saldo mentiría.
--
-- Es la simetría del lado de los clientes: `payments` guarda el cobro y
-- `payment_allocations` a qué factura fue; aquí cada fila guarda el giro y a
-- qué compra fue.
CREATE TABLE provider_payments (
  id          TEXT    PRIMARY KEY,
  -- CASCADE porque un abono no significa nada sin su compra. Borrar una compra
  -- que ya tiene abonos no se permite en el Worker justamente por eso: sería
  -- borrar el rastro de plata que ya salió de una cuenta.
  purchase_id TEXT    NOT NULL REFERENCES provider_purchases(id) ON DELETE CASCADE,
  monto       INTEGER NOT NULL CHECK (monto > 0),
  -- Sin CHECK, igual que `payments.metodo`: la lista vive en el Worker, donde
  -- ampliarla no obliga a recrear la tabla.
  metodo      TEXT    NOT NULL DEFAULT 'transferencia',
  cuenta_id   TEXT    REFERENCES treasury_accounts(id),
  nota        TEXT,
  pagado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  pagado_en   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_provider_payments_compra ON provider_payments (purchase_id, pagado_en DESC);
CREATE INDEX idx_provider_payments_cuenta ON provider_payments (cuenta_id, pagado_en DESC);

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

-- ────────────────── Baja de inventario por merma (0034) ──────────────────
--
-- El cierre de jornada de la bodega: lo que se deshidrató, se pudrió, se
-- venció o se rompió y ya no se puede vender. Antes el stock solo bajaba
-- vendiendo, y corregirlo a mano en Inventario no dejaba rastro de POR QUÉ
-- bajó — que es justo lo que pregunta una auditoría.
--
-- Misma forma que `provider_purchases` + sus líneas, porque es el otro
-- documento que mueve inventario, solo que en sentido contrario.
--
-- A diferencia de la compra, la merma SÍ resta de `ganancia`: el costo de la
-- compra se recupera al vender (congelado en `order_items.costo_unitario`),
-- pero lo que se bota nunca se vende y su costo no lo descuenta nadie más.

CREATE TABLE mermas (
  id            TEXT    PRIMARY KEY,
  -- Las dos valoraciones del mismo descarte, congeladas al registrarlo:
  --   · `total_costo` es la pérdida REAL —lo que se le pagó a la finca— y es
  --     la que resta de la ganancia.
  --   · `total_venta` es lo que se habría facturado de haberse vendido. No
  --     entra en ninguna cuenta; dimensiona el problema en el informe.
  total_costo   INTEGER NOT NULL CHECK (total_costo >= 0),
  total_venta   INTEGER NOT NULL DEFAULT 0 CHECK (total_venta >= 0),
  observaciones TEXT,
  creado_por    TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL mientras la jornada sigue abierta; el cierre la adopta, igual que a
  -- los gastos. Con cierre puesto ya no se deshace: es cuenta congelada.
  closing_id    TEXT    REFERENCES cash_closings(id) ON DELETE SET NULL
);

CREATE INDEX idx_mermas_closing ON mermas (closing_id, creado_en DESC);

CREATE TABLE merma_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- CASCADE: una línea no significa nada sin su acta. El stock que descontó se
  -- devuelve antes, en la misma transacción (ver remove() en mermas.ts).
  merma_id        TEXT    NOT NULL REFERENCES mermas(id) ON DELETE CASCADE,
  -- RESTRICT como en `order_items`: lo que alguna vez se dio de baja no se
  -- borra del catálogo mientras esta línea lo nombre.
  product_id      TEXT    NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Nombre y unidad COPIADOS: el acta es el documento de lo que pasó ese día.
  producto_nombre TEXT    NOT NULL,
  unidad          TEXT    NOT NULL,
  -- NUMERIC y no INTEGER: desde la 0033 hay productos que se venden por peso y
  -- se bota "0.4 kg" tan a menudo como "3 unidades". La afinidad NUMERIC
  -- guarda el 3 como entero y el 0.4 como real, sin tener que elegir.
  cantidad        NUMERIC NOT NULL CHECK (cantidad > 0),
  costo_unitario  INTEGER NOT NULL CHECK (costo_unitario >= 0),
  subtotal_costo  INTEGER NOT NULL CHECK (subtotal_costo >= 0),
  precio_unitario INTEGER NOT NULL DEFAULT 0 CHECK (precio_unitario >= 0),
  subtotal_venta  INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_venta >= 0),
  -- La causa raíz. Lista cerrada a propósito: es la columna por la que agrupa
  -- el informe, y con texto libre ("podrido", "pudrición") no sumaría nada.
  motivo          TEXT    NOT NULL CHECK (
                    motivo IN ('deshidratacion', 'pudricion', 'vencimiento', 'rotura', 'otro')
                  ),
  observacion     TEXT,
  -- Una sola línea por producto y acta, mismo criterio que `order_items`.
  UNIQUE (merma_id, product_id)
);

CREATE INDEX idx_merma_items_merma   ON merma_items (merma_id);
CREATE INDEX idx_merma_items_product ON merma_items (product_id);
CREATE INDEX idx_merma_items_motivo  ON merma_items (motivo);

-- ──────────────────────────── Tesorería (0035) ────────────────────────────
--
-- Responde «¿cuánto hay en el cajón?» y «¿cuánto hay en el banco?», que hoy
-- nadie podía contestar sin sumar a mano.
--
-- La decisión de fondo: NO existe un libro que lo registre todo. Un cobro ya
-- vive en `payments` y un gasto en `expenses`; copiarlos a una tabla de
-- movimientos sería una segunda verdad sobre el mismo hecho, y se rompería el
-- día que alguien escriba un pago por otro camino. En su lugar, a esas tablas
-- se les dice EN QUÉ CUENTA movieron la plata (`cuenta_id`), y el saldo de
-- cada cuenta se calcula sumándolas al leer. Un saldo calculado no se puede
-- desincronizar. Mismo criterio que el stock de una canasta, que tampoco se
-- guarda (ver `stockDeCanastas()` en combos.ts).
--
-- `treasury_movements` existe solo para lo que HOY no tiene dónde vivir:
-- traslados entre cuentas, y la plata que entra o sale sin ser cobro, gasto ni
-- compra.

CREATE TABLE treasury_accounts (
  id          TEXT    PRIMARY KEY,
  nombre      TEXT    NOT NULL,
  -- 'efectivo' es el cajón físico —el único que se cuenta a mano en un
  -- arqueo— y 'banco' es todo lo que llega por transferencia o datáfono.
  tipo        TEXT    NOT NULL CHECK (tipo IN ('efectivo', 'banco')),
  descripcion TEXT,
  -- Con cuánto arrancó antes de que el sistema registrara nada. Sin esto, una
  -- caja que ya tenía plata el día de la instalación aparecería en cero.
  saldo_inicial INTEGER NOT NULL DEFAULT 0,
  activo      INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),
  orden       INTEGER NOT NULL DEFAULT 0,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_treasury_accounts_activo ON treasury_accounts (activo, orden);

-- Ids fijos y legibles: el Worker los usa como destino por defecto según el
-- método de pago, así que tienen que ser iguales en cualquier instalación.
INSERT INTO treasury_accounts (id, nombre, tipo, descripcion, orden) VALUES
  ('caja-efectivo',   'Caja (efectivo)', 'efectivo', 'El cajón del mostrador',   1),
  ('cuenta-bancaria', 'Cuenta bancaria', 'banco',    'Tarjeta y transferencias', 2);

CREATE TABLE treasury_movements (
  id          TEXT    PRIMARY KEY,
  tipo        TEXT    NOT NULL CHECK (tipo IN ('ingreso', 'egreso', 'traslado')),
  -- En un traslado, de DÓNDE sale; en un ingreso, a dónde entra; en un
  -- egreso, de dónde sale.
  cuenta_id   TEXT    NOT NULL REFERENCES treasury_accounts(id),
  -- Solo en traslados: a dónde llega.
  cuenta_destino_id TEXT REFERENCES treasury_accounts(id),
  monto       INTEGER NOT NULL CHECK (monto > 0),
  concepto    TEXT    NOT NULL,
  -- Texto libre y no FK a `contacts`: un ingreso puede venir del dueño, que no
  -- es ni cliente ni proveedor.
  tercero     TEXT,
  referencia  TEXT,
  creado_por  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  creado_en   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Un traslado tiene destino y no puede ser a sí mismo; lo que no es traslado
  -- no puede tenerlo. Así ninguna fila queda a medio significar.
  CHECK (
    (tipo = 'traslado' AND cuenta_destino_id IS NOT NULL AND cuenta_destino_id <> cuenta_id)
    OR (tipo <> 'traslado' AND cuenta_destino_id IS NULL)
  )
);

CREATE INDEX idx_treasury_movements_fecha  ON treasury_movements (creado_en DESC);
CREATE INDEX idx_treasury_movements_cuenta ON treasury_movements (cuenta_id, creado_en DESC);

-- ── Turnos de cajero ──
--
-- El arqueo: con cuánto abrió, cuánto contó al cerrar y en cuánto falló.
-- Convive con el cierre de jornada sin reemplazarlo: el turno responde
-- «¿cuadró el cajón de este cajero?» y el cierre «¿cuánto se ganó hoy?».
-- Dentro de una jornada caben varios turnos.
--
-- Los cobros del turno NO se marcan con una columna en `payments`: se sacan
-- por rango de horas. Es lo que hace un arqueo de verdad —«lo que pasó por el
-- cajón mientras yo estuve»— y evita otra columna que habría que acordarse de
-- escribir en cada camino que cobra.
CREATE TABLE cashier_shifts (
  id             TEXT    PRIMARY KEY,
  -- TRN-AAAAMMDD-N, con N reiniciando cada día. Lo arma el Worker.
  referencia     TEXT    NOT NULL UNIQUE,
  cuenta_id      TEXT    NOT NULL REFERENCES treasury_accounts(id),
  cajero_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  cajero_nombre  TEXT    NOT NULL,
  abierto_en     TEXT    NOT NULL DEFAULT (datetime('now')),
  fondo_apertura INTEGER NOT NULL DEFAULT 0 CHECK (fondo_apertura >= 0),

  -- Todo lo de abajo es NULL hasta que se cierra.
  cerrado_en     TEXT,
  efectivo_contado  INTEGER CHECK (efectivo_contado IS NULL OR efectivo_contado >= 0),
  vouchers_contados INTEGER CHECK (vouchers_contados IS NULL OR vouchers_contados >= 0),
  -- Lo que el sistema decía que debía haber, CONGELADO al cerrar: recalcularlo
  -- después daría otra cifra en cuanto entre un cobro atrasado, y entonces la
  -- diferencia que alguien firmó dejaría de cuadrar con nada.
  efectivo_esperado INTEGER,
  -- Contado menos esperado. Negativa es faltante.
  diferencia     INTEGER,
  notas          TEXT,
  -- Quién recibe el turno, confirmado con su usuario y su clave: es lo que
  -- convierte la entrega en algo que dos personas firmaron.
  recibido_por        TEXT REFERENCES users(id) ON DELETE SET NULL,
  recibido_por_nombre TEXT,
  CHECK (cerrado_en IS NULL OR efectivo_contado IS NOT NULL)
);

CREATE INDEX idx_shifts_abierto ON cashier_shifts (cuenta_id, cerrado_en);
CREATE INDEX idx_shifts_fecha   ON cashier_shifts (abierto_en DESC);

-- ─────────────────────── Ajustes de operación (0032) ───────────────────────
-- Banderas que un SUPER_ADMIN cambia en vivo desde el panel, sin desplegar.
-- Clave-valor y no una columna por ajuste: son opciones de operación, no
-- entidades, y añadir la siguiente no puede costar otra migración.
CREATE TABLE app_settings (
  clave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Si la caja imprime recibo por defecto. El cajero puede cambiarlo en cada
-- venta —preguntándole al cliente—; esto solo decide cómo llega la casilla.
INSERT INTO app_settings (clave, valor) VALUES ('pos_recibo_por_defecto', '1');
