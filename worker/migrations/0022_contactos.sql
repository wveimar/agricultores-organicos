-- ============================================================================
--  Contactos: proveedores y clientes en una sola tabla.
--
--  ── Por qué una tabla y no dos ──
--
--  Porque son el mismo tipo de cosa —alguien con nombre, teléfono y dirección
--  con quien se mueve dinero— y porque en esta finca la misma persona puede
--  ser las dos: a una vereda se le compra lechuga y esa misma vereda compra
--  huevos. Con dos tablas habría que teclearla dos veces y mantener los dos
--  teléfonos sincronizados a mano.
--
--  `es_proveedor` y `es_cliente` son banderas independientes, no un `tipo`
--  excluyente: las dos pueden estar en 1 a la vez, que es justo el caso que
--  motivó la tabla única.
--
--  ── Lo que NO se toca ──
--
--  `products.origen` se queda como está: es el texto de marketing que ve el
--  cliente ("Finca Los Nogales · Antioquia") y lo que agrupa el informe
--  consolidado. No se convierte en una FK a `contacts` a propósito, porque el
--  mismo producto se le puede comprar a varias fincas —la lechuga de una
--  semana viene de una vereda y la de la siguiente de otra— y una sola columna
--  no puede decir eso. Quién puso la mercancía se responde por compra, no por
--  producto: está en `provider_purchases.contact_id`.
--
--  ── El teléfono es la llave de los clientes ──
--
--  El checkout de invitado no pide cuenta, así que lo único estable entre dos
--  compras de la misma persona es el teléfono. De ahí el índice único: dos
--  pedidos con el mismo número son el mismo cliente, aunque escriba su nombre
--  distinto cada vez (en los datos actuales hay un número con siete grafías).
--  El pedido conserva SU copia del nombre y la dirección —es el documento de
--  lo que pasó— y el contacto guarda la versión más reciente.
--
--    npx wrangler d1 execute DB --local  --file=worker/migrations/0022_contactos.sql
--    npx wrangler d1 execute DB --remote --file=worker/migrations/0022_contactos.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS contacts (
  id             TEXT    PRIMARY KEY,
  nombre         TEXT    NOT NULL,

  -- Las dos pueden ser 1: hay quien vende y compra.
  es_proveedor   INTEGER NOT NULL DEFAULT 0 CHECK (es_proveedor IN (0, 1)),
  es_cliente     INTEGER NOT NULL DEFAULT 0 CHECK (es_cliente   IN (0, 1)),

  telefono       TEXT,
  direccion      TEXT,
  notas          TEXT,

  -- Para girarle a un proveedor cuando se marca una compra como pagada.
  -- Todos opcionales: un vecino al que se le paga en efectivo no tiene cuenta.
  banco          TEXT,
  tipo_cuenta    TEXT    CHECK (tipo_cuenta IS NULL OR tipo_cuenta IN ('ahorros', 'corriente', 'nequi', 'daviplata')),
  numero_cuenta  TEXT,
  titular        TEXT,
  documento      TEXT,

  -- Desactivar en vez de borrar: el historial de compras y pedidos lo sigue
  -- nombrando. Un inactivo no sale en los selectores pero conserva su ficha.
  activo         INTEGER NOT NULL DEFAULT 1 CHECK (activo IN (0, 1)),

  creado_en      TEXT    NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Va al final y no junto a las banderas porque SQLite no admite volver a
  -- definir columnas después de una restricción de tabla: ponerla en medio es
  -- un error de sintaxis, no un detalle de estilo.
  --
  -- Un contacto que no es ni proveedor ni cliente no tendría pantalla donde
  -- aparecer, así que sería una fila invisible imposible de encontrar.
  CHECK (es_proveedor = 1 OR es_cliente = 1)
);

-- Dos pedidos con el mismo teléfono son la misma persona: esto es lo que hace
-- que el checkout de invitado pueda buscarla en vez de duplicarla en cada
-- compra. Parcial porque un proveedor puede no tener teléfono, y varios NULL
-- no pueden chocar entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_telefono
  ON contacts (telefono) WHERE telefono IS NOT NULL AND telefono <> '';

-- Las dos preguntas de las pantallas: "mis proveedores activos", "mis clientes".
CREATE INDEX IF NOT EXISTS idx_contacts_proveedor ON contacts (es_proveedor, activo, nombre);
CREATE INDEX IF NOT EXISTS idx_contacts_cliente   ON contacts (es_cliente,   activo, nombre);

-- ──────────────────────── Enganche con lo que ya existe ────────────────────────

-- SET NULL y no CASCADE: borrar un contacto jamás puede llevarse pedidos ni
-- compras por delante. Por eso además la pantalla desactiva en vez de borrar.
ALTER TABLE orders ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE provider_purchases ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_contact    ON orders (contact_id);
CREATE INDEX IF NOT EXISTS idx_purchases_contact ON provider_purchases (contact_id);

-- ─────────────────────────── Sembrado desde lo que hay ───────────────────────────

-- 1. Un proveedor por cada `origen` distinto del catálogo. Es de dónde se ha
--    estado comprando hasta hoy, aunque nunca se hubiera escrito en ningún
--    sitio con teléfono y cuenta. Entran sin datos de contacto: la ficha se
--    completa desde el panel.
INSERT INTO contacts (id, nombre, es_proveedor, notas)
SELECT lower(hex(randomblob(16))),
       p.origen,
       1,
       'Creado automáticamente desde el origen del catálogo. Completa el contacto.'
  FROM products p
 WHERE p.origen IS NOT NULL AND p.origen <> ''
   AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.nombre = p.origen)
 GROUP BY p.origen;

-- 2. Un cliente por cada teléfono distinto de los pedidos, con el nombre y la
--    dirección del pedido MÁS RECIENTE de ese número: es la versión más
--    probable de estar vigente. Los pedidos viejos conservan la suya.
--
--    El GROUP BY final es el que garantiza una fila por teléfono aunque dos
--    pedidos del mismo número compartan `creado_en` al segundo.
INSERT INTO contacts (id, nombre, telefono, direccion, es_cliente)
SELECT lower(hex(randomblob(16))),
       o.cliente_nombre,
       o.cliente_telefono,
       o.cliente_direccion,
       1
  FROM orders o
  JOIN (
        SELECT cliente_telefono, MAX(creado_en) AS ultimo
          FROM orders
         WHERE cliente_telefono IS NOT NULL AND cliente_telefono <> ''
         GROUP BY cliente_telefono
       ) u
    ON u.cliente_telefono = o.cliente_telefono
   AND u.ultimo = o.creado_en
 WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.telefono = o.cliente_telefono)
 GROUP BY o.cliente_telefono;

-- 3. Cada pedido apunta a su cliente.
UPDATE orders
   SET contact_id = (SELECT c.id FROM contacts c WHERE c.telefono = orders.cliente_telefono)
 WHERE contact_id IS NULL;

-- 4. Cada compra apunta a su proveedor, emparejando por el nombre que se copió
--    al registrarla. Las que no casen se quedan en NULL y la pantalla las
--    muestra con su texto original: mejor eso que inventar un proveedor.
UPDATE provider_purchases
   SET contact_id = (SELECT c.id FROM contacts c
                      WHERE c.nombre = provider_purchases.origen AND c.es_proveedor = 1)
 WHERE contact_id IS NULL;
