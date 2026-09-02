import { ApiError, json, readJson, requireInt, requireString } from '../http';
import { Env, JwtPayload } from '../types';
import { optionalAuth, requireRole } from '../auth/middleware';
import { discountedPrice, loadDiscounts, loadUserRoles } from '../pricing';
import { contenidoPublico } from '../combos';
import { validarGrupo } from './admin-groups';

/**
 * Tope de una imagen de producto ya en base64.
 *
 * D1 rechaza cualquier fila de más de 2 MB, así que sin este corte una foto
 * sin comprimir no daba un 400 explicando qué pasó, sino un 500 del motor.
 * El panel ya redimensiona antes de subir (ver `shared/utils/image-file.ts`),
 * pero eso ocurre en el navegador del cliente y no es una garantía.
 */
const MAX_IMAGE_CHARS = 1_500_000;

function checkImageSize(value: string | undefined, field: string): void {
  if (value && value.length > MAX_IMAGE_CHARS) {
    throw ApiError.badRequest(
      'imagen-grande',
      `La imagen de "${field}" pesa demasiado. Súbela desde el panel, que la reduce sola.`,
    );
  }
}

/**
 * Una imagen es una URL https o un data URL de imagen. Nada más.
 *
 * El valor acaba en el `src` de un `<img>` de la tienda, así que conviene
 * acotarlo en el servidor y no solo en el formulario. Se rechaza `http://`
 * a propósito: el sitio va por https y el navegador bloquearía la imagen por
 * contenido mixto, dejando una ficha rota sin decir por qué.
 */
function checkImageSource(value: string | undefined, field: string): void {
  if (!value) {
    return;
  }
  const ok = value.startsWith('https://') || /^data:image\/(jpeg|png|webp);base64,/.test(value);
  if (!ok) {
    throw ApiError.badRequest(
      'imagen-invalida',
      value.startsWith('http://')
        ? `El enlace de "${field}" debe ser https. Con http el navegador bloquea la imagen.`
        : `El enlace de "${field}" no es válido. Pega una URL https o sube el archivo.`,
    );
  }
}

/** Columnas que ve el público. `precio_costo` queda deliberadamente fuera. */
const PUBLIC_COLUMNS = `
  id, slug, nombre, tagline, categoria_id AS categoriaId, grupo_admin_id AS grupoAdmin,
  precio, precio_anterior AS precioAnterior, unidad, cantidad_unidad AS cantidadUnidad, origen, rating,
  review_count AS reviewCount, badge, destacado,
  -- Stock de una canasta: cuántas se pueden armar con lo que hay de sus
  -- componentes, por el que primero se agote. Su columna stock_actual vale 0
  -- por definición, así que servirla tal cual la mostraría siempre agotada.
  --
  -- MIN sobre cero filas devuelve NULL, así que el COALESCE deja pasar el
  -- stock normal de todo lo que no es canasta sin necesitar un CASE aparte.
  --
  -- El CAST a INTEGER es el FLOOR, y tiene que estar escrito igual que en
  -- stockDeCanastas() (combos.ts): son dos copias de la misma cuenta —esta
  -- sirve el catálogo, aquella valida el pedido— y si divergen, la tienda
  -- ofrecería una cantidad que el checkout después rechaza. Sin el CAST, un
  -- componente decimal («Paquete de 500 g» = 0,5 kg de granel) hacía que
  -- SQLite dividiera en coma flotante y saliera «84,6 disponibles».
  COALESCE(
    (SELECT MIN(CASE WHEN h.activo = 1
                     THEN CAST(h.stock_actual / pc.cantidad_requerida AS INTEGER)
                     ELSE 0 END)
       FROM product_components pc
       JOIN products h ON h.id = pc.child_product_id
      WHERE pc.parent_product_id = products.id),
    stock_actual
  ) AS stock,
  imagen, imagen_hover AS imagenHover, imagen_alt AS imagenAlt,
  parent_id AS parentId, variante_etiqueta AS varianteEtiqueta
`;

/** El panel además ve costo, umbral de reposición, clase ABC y disponibilidad. */
const ADMIN_COLUMNS = `
  ${PUBLIC_COLUMNS},
  precio_costo AS precioCosto,
  stock_seguridad AS stockSeguridad,
  categoria_abc AS categoriaAbc,
  activo,
  -- Lo que teclea el lector del mostrador. Solo en el panel: en la tienda
  -- pública no le sirve a nadie y es un dato de operación interna.
  codigo_barras AS codigoBarras,
  -- 1 = se vende a granel, pesado en la caja (migración 0033). Solo en el
  -- panel: decide si el ticket del POS pide un peso decimal o un conteo.
  vendido_por_peso AS vendidoPorPeso,
  (precio - precio_costo) AS margenUnitario,
  -- Las dos formas de no tener inventario propio. Ambas tienen stock_actual = 0
  -- por definición: la canasta lo deriva de sus componentes y la madre de sus
  -- hijas (ver el COALESCE de arriba y combos.ts).
  --
  -- Viajan al panel para que las pantallas que MUEVEN stock —hoy, registrar una
  -- compra a una finca— no las ofrezcan siquiera. Sin esto habría que deducirlo
  -- recorriendo la lista entera buscando quién es hija de quién, y de las
  -- canastas no habría forma: sus componentes no salen en esta respuesta.
  EXISTS (SELECT 1 FROM product_components pc
           WHERE pc.parent_product_id = products.id) AS esCanasta,
  EXISTS (SELECT 1 FROM products h
           WHERE h.parent_id = products.id)          AS tieneVariantes
`;

/** `null`, o un id no vacío. Cualquier otra cosa es un 400. */
function readParentId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw ApiError.badRequest('padre-invalido', 'El producto principal debe ser un id.');
  }
  return value;
}

/**
 * Cómo se llama lo que distingue a las variantes: 'presentación', 'sabor'.
 *
 * Texto libre y no una lista cerrada: es una palabra que solo se pinta en el
 * modal, y cerrarla obligaría a una migración cada vez que aparezca una línea
 * nueva (tamaño, molienda, corte…). Se recorta a 40 para que no se pueda meter
 * un párrafo donde va una palabra.
 */
function readVariantLabel(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw ApiError.badRequest(
      'variante-etiqueta-invalida',
      'La etiqueta de variante debe ser un texto.',
    );
  }
  return value.trim().slice(0, 40) || null;
}

/**
 * Comprueba que `parentId` puede ser madre de `productId`.
 *
 * Tres cosas que no pueden pasar y por qué:
 *
 * · Que la madre no exista — la FK ya lo rechazaría, pero como un error del
 *   motor, no como un 400 con un mensaje que se pueda leer.
 * · Que la madre sea ella misma una variante — el catálogo solo pinta un nivel
 *   ("madre → hijas"). Una nieta no se ve en ninguna parte: ni tiene tarjeta
 *   propia (tiene `parent_id`) ni sale en el modal de nadie.
 * · Que el producto tenga ya hijas propias — convertirlo en hija las dejaría
 *   colgando de una nieta, con el mismo resultado.
 */
async function checkParent(env: Env, productId: string | null, parentId: string): Promise<void> {
  if (productId && parentId === productId) {
    throw ApiError.badRequest('variante-circular', 'Un producto no puede ser variante de sí mismo.');
  }

  const madre = await env.DB.prepare(`SELECT parent_id FROM products WHERE id = ?1`)
    .bind(parentId)
    .first<{ parent_id: string | null }>();

  if (!madre) {
    throw ApiError.badRequest('padre-inexistente', 'El producto principal indicado no existe.');
  }
  if (madre.parent_id !== null) {
    throw ApiError.badRequest(
      'variante-anidada',
      'Ese producto ya es una variante de otro. Las variantes no admiten variantes.',
    );
  }

  if (productId) {
    const hija = await env.DB.prepare(`SELECT 1 FROM products WHERE parent_id = ?1 LIMIT 1`)
      .bind(productId)
      .first();
    if (hija) {
      throw ApiError.badRequest(
        'padre-con-variantes',
        'Este producto ya agrupa variantes propias, así que no puede ser a su vez variante de otro.',
      );
    }
  }
}

/**
 * GET /api/products — catálogo público.
 *
 * Una sola consulta indexada, sin JOIN ni N+1. Filtros opcionales por
 * categoría y grupo.
 *
 * Las variantes viajan aquí mismo, como filas normales con `parentId` puesto.
 * No hay un endpoint aparte para pedir las hijas de un producto: eso sería una
 * petición por tarjeta abierta, y el catálogo entero cabe de sobra en la
 * respuesta que ya se estaba haciendo. Quien las esconde de la rejilla es la
 * tienda (`CatalogService.visible`), que las guarda para el modal.
 */
export async function listPublic(request: Request, env: Env, url: URL): Promise<Response> {
  const categoria = url.searchParams.get('categoria');
  const grupo = url.searchParams.get('grupo');

  let sql = `SELECT ${PUBLIC_COLUMNS} FROM products WHERE activo = 1`;
  const bindings: unknown[] = [];

  if (categoria) {
    bindings.push(categoria);
    sql += ` AND categoria_id = ?${bindings.length}`;
  }
  if (grupo) {
    bindings.push(grupo);
    sql += ` AND grupo_admin_id = ?${bindings.length}`;
  }

  sql += ' ORDER BY nombre COLLATE NOCASE';

  const { results } = await env.DB.prepare(sql).bind(...bindings).all<{
    id: string;
    precio: number;
  }>();

  /**
   * El precio de mayorista se resuelve aquí y no en el navegador.
   *
   * La tienda podría bajarse la tabla de descuentos y multiplicar, pero
   * entonces cualquiera vería los tratos de todos los niveles con solo abrir
   * la pestaña de red. Así cada cuenta recibe **su** precio ya calculado y
   * nada más, y `POST /api/orders` vuelve a calcularlo por su cuenta al
   * cobrar: lo que viaja aquí es para pintar, no para facturar.
   *
   * Sin sesión —la compra de invitado, que es el caso normal— no se consulta
   * nada: `loadDiscounts` corta en seco si no hay rol de mayorista.
   */
  const session = await optionalAuth(request, env);
  const roles = session ? await loadUserRoles(env, session.sub) : [];
  const ids = results.map((p) => p.id);
  const discounts = await loadDiscounts(env, ids, roles);

  // Qué lleva cada canasta. Quien compra una tiene que poder ver el contenido
  // antes de pagarla; su `stock` ya viene calculado desde PUBLIC_COLUMNS.
  const contenidos = await contenidoPublico(env, ids);

  if (discounts.size === 0 && contenidos.size === 0) {
    return json({ products: results });
  }

  return json({
    products: results.map((product) => {
      const porcentaje = discounts.get(product.id);
      const contenido = contenidos.get(product.id);

      return {
        ...product,
        ...(porcentaje
          ? {
              precioMayorista: discountedPrice(product.precio, porcentaje),
              descuentoMayorista: porcentaje,
            }
          : {}),
        ...(contenido ? { contiene: contenido } : {}),
      };
    }),
  });
}

/**
 * GET /api/admin/products — inventario completo, con costo y margen.
 *
 * A diferencia del catálogo público, aquí **sí** salen los productos con
 * `activo = 0`. Filtrarlos sería una puerta de un solo sentido: al marcar uno
 * como "sin oferta esta semana" desaparecería del panel y ya no habría forma
 * de volver a activarlo cuando el agricultor confirme que hay cosecha.
 */
export async function listAdmin(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${ADMIN_COLUMNS} FROM products ORDER BY nombre COLLATE NOCASE`,
  ).all();

  return json({ products: results });
}

/**
 * GET /api/admin/products/alerts — lo que hay que reponer.
 * Se resuelve contra idx_products_stock sin escanear la tabla.
 *
 * Las madres de variantes quedan fuera. Su `stock_actual` es 0 por definición
 * —el inventario está en las hijas— así que cumplirían la condición para
 * siempre y se instalarían en lo alto de la lista de reposición, empujando
 * hacia abajo lo que de verdad se está acabando.
 */
export async function listAlerts(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const { results } = await env.DB.prepare(
    `SELECT ${ADMIN_COLUMNS} FROM products
      WHERE activo = 1 AND stock_actual <= stock_seguridad
        AND NOT EXISTS (SELECT 1 FROM products h WHERE h.parent_id = products.id)
        -- Las canastas, por el mismo motivo que las madres de variantes: su
        -- columna vale 0 para siempre, así que cumplirían la condición
        -- eternamente y taparían lo que de verdad hay que reponer. Reponer una
        -- canasta es reponer sus componentes, y esos ya salen en la lista.
        AND NOT EXISTS (
          SELECT 1 FROM product_components pc WHERE pc.parent_product_id = products.id
        )
      ORDER BY stock_actual ASC`,
  ).all();

  return json({ products: results });
}

interface UpdateBody {
  precio?: unknown;
  precioCosto?: unknown;
  stock?: unknown;
  stockSeguridad?: unknown;
  /** 1 = se ofrece esta semana · 0 = el agricultor no tiene cosecha. */
  activo?: unknown;
  /** 1 = aparece en "Más vendidos" de la portada. */
  destacado?: unknown;
  /** Lo que teclea el lector del mostrador. '' lo borra. */
  codigoBarras?: unknown;
  /** 1 = se vende a granel, pesado en la caja. */
  vendidoPorPeso?: unknown;
}

/**
 * PATCH /api/admin/products/:id — actualización parcial de precio, costo y stock.
 *
 * Solo actualiza los campos que vengan en el cuerpo, para que dos pestañas
 * editando cosas distintas no se pisen mutuamente.
 */
export async function update(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<UpdateBody>(request);
  const sets: string[] = [];
  const bindings: unknown[] = [];

  const push = (column: string, value: number) => {
    bindings.push(value);
    sets.push(`${column} = ?${bindings.length}`);
  };

  if (body.precio !== undefined) push('precio', requireInt(body.precio, 'precio', 0));
  if (body.precioCosto !== undefined) push('precio_costo', requireInt(body.precioCosto, 'precioCosto', 0));
  if (body.stock !== undefined) push('stock_actual', requireInt(body.stock, 'stock', 0));
  if (body.stockSeguridad !== undefined) {
    push('stock_seguridad', requireInt(body.stockSeguridad, 'stockSeguridad', 0));
  }
  if (body.activo !== undefined) {
    // `requireInt` solo impone mínimo, y aquí el máximo importa: un 7 pasaría
    // la validación y reventaría contra el CHECK (activo IN (0,1)) de D1 como
    // un 500 en vez de un 400 con un mensaje útil.
    if (body.activo !== 0 && body.activo !== 1) {
      throw ApiError.badRequest('activo-invalido', 'El campo "activo" debe ser 0 o 1.');
    }
    push('activo', body.activo);
  }
  if (body.destacado !== undefined) {
    if (body.destacado !== 0 && body.destacado !== 1) {
      throw ApiError.badRequest('destacado-invalido', 'El campo \"destacado\" debe ser 0 o 1.');
    }
    push('destacado', body.destacado);
  }
  if (body.vendidoPorPeso !== undefined) {
    if (body.vendidoPorPeso !== 0 && body.vendidoPorPeso !== 1) {
      throw ApiError.badRequest(
        'vendido-por-peso-invalido',
        'El campo "vendidoPorPeso" debe ser 0 o 1.',
      );
    }
    push('vendido_por_peso', body.vendidoPorPeso);
  }

  if (body.codigoBarras !== undefined) {
    // Cadena vacía → NULL, no ''. El índice único es parcial y excluye los
    // vacíos, pero guardar '' haría que el buscador de la caja encontrara este
    // producto al escanear cualquier cosa que llegue vacía.
    const codigo =
      body.codigoBarras === null || body.codigoBarras === ''
        ? null
        : requireString(body.codigoBarras, 'codigoBarras', 64);
    bindings.push(codigo);
    sets.push(`codigo_barras = ?${bindings.length}`);
  }

  if (sets.length === 0) {
    throw ApiError.badRequest('sin-cambios', 'No enviaste ningún campo para actualizar.');
  }

  sets.push(`actualizado_en = datetime('now')`);
  bindings.push(productId);

  // Sin `AND activo = 1`: si se excluyera, reactivar un producto marcado como
  // sin oferta sería imposible — el propio UPDATE que lo reactiva no
  // encontraría la fila.
  const result = await env.DB.prepare(
    `UPDATE products SET ${sets.join(', ')} WHERE id = ?${bindings.length}`,
  )
    .bind(...bindings)
    .run();

  if (result.meta.changes === 0) {
    throw ApiError.notFound('Ese producto no existe.');
  }

  const updated = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(productId)
    .first();

  return json({ product: updated });
}

/**
 * Busca un slug libre a partir del original: `tomate` → `tomate-copia`, y si
 * ya existe, `tomate-copia-2`. Duplicar dos veces el mismo producto es lo
 * normal cuando se hacen tres variantes seguidas, y sin esto la segunda
 * chocaría contra el UNIQUE.
 */
async function slugLibre(env: Env, base: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT slug FROM products WHERE slug = ?1 OR slug LIKE ?2`,
  )
    .bind(`${base}-copia`, `${base}-copia-%`)
    .all<{ slug: string }>();

  const ocupados = new Set(results.map((r) => r.slug));
  if (!ocupados.has(`${base}-copia`)) {
    return `${base}-copia`;
  }
  for (let n = 2; n < 1000; n++) {
    if (!ocupados.has(`${base}-copia-${n}`)) {
      return `${base}-copia-${n}`;
    }
  }
  return `${base}-copia-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * POST /api/admin/products/:id/duplicar — crea una variante a medio hacer.
 *
 * Sirve para lo que en la práctica son dos productos con la misma ficha:
 * "Banano Verde" y "Banano Maduro" comparten foto, origen, precio y unidad, y
 * solo se diferencian en el nombre y en su inventario.
 *
 * ── Por qué las columnas se leen y no se listan ──
 *
 * El INSERT se arma a partir de las claves que devuelve `SELECT *`, no de una
 * lista escrita a mano. La tabla ya va por 23 columnas y ha crecido tres veces
 * en este proyecto; una lista fija se queda corta en silencio, y el síntoma
 * sería una copia a la que le falta un dato sin que nadie vea un error. Los
 * nombres vienen del esquema, no de la petición, así que no hay nada que
 * inyectar.
 */
export async function duplicate(
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const original = await env.DB.prepare(`SELECT * FROM products WHERE id = ?1`)
    .bind(productId)
    .first<Record<string, unknown>>();

  if (!original) {
    throw ApiError.notFound('Ese producto no existe.');
  }

  /**
   * Lo único que **no** se copia, y el motivo de cada uno:
   *
   * · `stock_actual` a 0 — copiarlo inventaría inventario que nadie compró, y
   *   ese número acaba en los cierres de caja como valor de bodega.
   * · `activo` a 0 — la copia sale del horno con el nombre del original y un
   *   slug provisional. Si naciera activa, aparecería tal cual en la tienda
   *   mientras se termina de editar.
   * · `rating` y `review_count` a 0 — son lo que dijeron clientes reales sobre
   *   *otro* producto. Heredarlos le pondría a una ficha recién creada 312
   *   valoraciones que nadie escribió.
   * · `categoria_abc` a 'C' — es una caché de ventas, y este producto no ha
   *   vendido nada todavía.
   */
  const distinto: Record<string, unknown> = {
    id: crypto.randomUUID(),
    slug: await slugLibre(env, String(original['slug'])),
    nombre: `${original['nombre']} (copia)`,
    stock_actual: 0,
    activo: 0,
    rating: 0,
    review_count: 0,
    categoria_abc: 'C',
    actualizado_en: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };

  const columnas = Object.keys(original);
  const valores = columnas.map((c) => (c in distinto ? distinto[c] : original[c]));
  const marcadores = columnas.map((_, i) => `?${i + 1}`).join(', ');

  await env.DB.prepare(
    `INSERT INTO products (${columnas.join(', ')}) VALUES (${marcadores})`,
  )
    .bind(...valores)
    .run();

  const copia = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(distinto['id'])
    .first();

  return json({ product: copia }, 201);
}

interface UpdateFullBody {
  nombre?: unknown;
  slug?: unknown;
  tagline?: unknown;
  categoriaId?: unknown;
  grupoAdmin?: unknown;
  precio?: unknown;
  precioCosto?: unknown;
  unidad?: unknown;
  cantidadUnidad?: unknown;
  origen?: unknown;
  imagen?: unknown;
  imagenHover?: unknown;
  imagenAlt?: unknown;
  /** Id del producto sombrilla, o `null` para desligarlo y dejarlo suelto. */
  parentId?: unknown;
  /** Solo en las madres: 'presentación', 'sabor'… */
  varianteEtiqueta?: unknown;
  /** 1 = se vende a granel, pesado en la caja. */
  vendidoPorPeso?: unknown;
}

/** `0` si no viene o viene basura: casi ningún producto se vende a granel. */
function readVendidoPorPeso(value: unknown): 0 | 1 {
  return value === 1 || value === true ? 1 : 0;
}

/**
 * PUT /api/admin/products/:id — actualización completa del producto.
 *
 * Actualiza todos los datos del producto excepto id.
 */
export async function updateFull(
  request: Request,
  env: Env,
  user: JwtPayload,
  productId: string,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<UpdateFullBody>(request);

  const nombre = body.nombre as string | undefined;
  const slug = body.slug as string | undefined;
  const tagline = (body.tagline as string) ?? '';
  const categoriaId = body.categoriaId as string | undefined;
  const grupoAdmin = body.grupoAdmin as string | undefined;
  const precio = body.precio !== undefined ? requireInt(body.precio, 'precio', 0) : undefined;
  const precioCosto = body.precioCosto !== undefined ? requireInt(body.precioCosto, 'precioCosto', 0) : undefined;
  const unidad = body.unidad as string | undefined;
  const cantidadUnidad =
    body.cantidadUnidad !== undefined ? requireInt(body.cantidadUnidad, 'cantidadUnidad', 1) : 1;
  const origen = body.origen as string | undefined;
  const imagen = body.imagen as string | undefined;
  const imagenHover = body.imagenHover as string | undefined;
  const imagenAlt = body.imagenAlt as string | undefined;
  const vendidoPorPeso = readVendidoPorPeso(body.vendidoPorPeso);

  if (!nombre || nombre.trim().length === 0) {
    throw ApiError.badRequest('nombre-requerido', 'El nombre es requerido.');
  }
  if (!categoriaId || categoriaId.trim().length === 0) {
    throw ApiError.badRequest('categoria-requerida', 'La categoría es requerida.');
  }
  if (!grupoAdmin) {
    throw ApiError.badRequest('grupo-invalido', 'El grupo es requerido.');
  }
  await validarGrupo(env, grupoAdmin);
  if (precio === undefined) {
    throw ApiError.badRequest('precio-requerido', 'El precio es requerido.');
  }
  if (precioCosto === undefined) {
    throw ApiError.badRequest('precio-costo-requerido', 'El precio de costo es requerido.');
  }
  if (!unidad || unidad.trim().length === 0) {
    throw ApiError.badRequest('unidad-requerida', 'La unidad es requerida.');
  }
  if (!origen || origen.trim().length === 0) {
    throw ApiError.badRequest('origen-requerido', 'El origen es requerido.');
  }
  if (!imagen || imagen.trim().length === 0) {
    throw ApiError.badRequest('imagen-requerida', 'La imagen es requerida.');
  }
  if (!imagenAlt || imagenAlt.trim().length === 0) {
    throw ApiError.badRequest('imagen-alt-requerida', 'El texto alternativo de la imagen es requerido.');
  }
  checkImageSize(imagen, 'imagen');
  checkImageSize(imagenHover, 'imagen hover');
  checkImageSource(imagen, 'imagen');
  checkImageSource(imagenHover, 'imagen hover');

  /**
   * El vínculo de variante solo se toca si viene en el cuerpo.
   *
   * Este endpoint es un PUT y reemplaza el resto de campos sin preguntar, pero
   * aquí eso sería una trampa: el formulario del panel todavía no manda estos
   * dos campos, así que cualquier edición de precio o de foto desde Inventario
   * desligaría las variantes de su madre sin que nadie lo pidiera ni lo viera.
   * Ausente significa "no lo cambies"; `null` explícito sí desliga.
   */
  const tocaParent = 'parentId' in body;
  const tocaEtiqueta = 'varianteEtiqueta' in body;

  const parentId = tocaParent ? readParentId(body.parentId) : null;
  if (parentId) {
    await checkParent(env, productId, parentId);
  }
  const varianteEtiqueta = tocaEtiqueta ? readVariantLabel(body.varianteEtiqueta) : null;

  const extras: string[] = [];
  const extraValores: unknown[] = [];
  if (tocaParent) {
    extraValores.push(parentId);
    extras.push(`parent_id = ?${14 + extraValores.length}`);
  }
  if (tocaEtiqueta) {
    extraValores.push(varianteEtiqueta);
    extras.push(`variante_etiqueta = ?${14 + extraValores.length}`);
  }

  const updateSlug = slug ? slug : nombre
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

  try {
    await env.DB.prepare(
      `UPDATE products SET
        slug = ?1, nombre = ?2, tagline = ?3, categoria_id = ?4, grupo_admin_id = ?5,
        precio = ?6, precio_costo = ?7, unidad = ?8, cantidad_unidad = ?9, origen = ?10,
        imagen = ?11, imagen_hover = ?12, imagen_alt = ?13, vendido_por_peso = ?14,
        ${extras.map((set) => `${set}, `).join('')}actualizado_en = datetime('now')
       WHERE id = ?${15 + extraValores.length}`,
    )
      .bind(updateSlug, nombre, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, origen, imagen, imagenHover ?? null, imagenAlt, vendidoPorPeso, ...extraValores, productId)
      .run();
  } catch (error) {
    if ((error as Error).message.includes('UNIQUE constraint failed: products.slug')) {
      throw ApiError.badRequest('slug-duplicado', 'Ya existe un producto con ese slug.');
    }
    throw error;
  }

  const updated = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(productId)
    .first();

  if (!updated) {
    throw ApiError.notFound('Ese producto no existe o está desactivado.');
  }

  return json({ product: updated });
}

interface CreateBody {
  nombre?: unknown;
  slug?: unknown;
  tagline?: unknown;
  categoriaId?: unknown;
  grupoAdmin?: unknown;
  precio?: unknown;
  precioCosto?: unknown;
  unidad?: unknown;
  cantidadUnidad?: unknown;
  origen?: unknown;
  imagen?: unknown;
  imagenHover?: unknown;
  imagenAlt?: unknown;
  /** Id del producto sombrilla: nace ya como variante suya. */
  parentId?: unknown;
  /** Solo en las madres: 'presentación', 'sabor'… */
  varianteEtiqueta?: unknown;
  /** 1 = se vende a granel, pesado en la caja. */
  vendidoPorPeso?: unknown;
}

/**
 * POST /api/admin/products — crear un nuevo producto.
 *
 * Slug se genera a partir del nombre si no viene en el cuerpo.
 * Las imágenes son data URLs (base64 comprimidas).
 */
export async function create(
  request: Request,
  env: Env,
  user: JwtPayload,
): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const body = await readJson<CreateBody>(request);

  const nombre = body.nombre as string | undefined;
  let slug = body.slug as string | undefined;
  const tagline = (body.tagline as string) ?? '';
  const categoriaId = body.categoriaId as string | undefined;
  const grupoAdmin = body.grupoAdmin as string | undefined;
  const precio = body.precio !== undefined ? requireInt(body.precio, 'precio', 0) : undefined;
  const precioCosto = body.precioCosto !== undefined ? requireInt(body.precioCosto, 'precioCosto', 0) : 0;
  const unidad = body.unidad as string | undefined;
  const cantidadUnidad =
    body.cantidadUnidad !== undefined ? requireInt(body.cantidadUnidad, 'cantidadUnidad', 1) : 1;
  const origen = body.origen as string | undefined;
  const imagen = body.imagen as string | undefined;
  const imagenHover = body.imagenHover as string | undefined;
  const imagenAlt = body.imagenAlt as string | undefined;
  const vendidoPorPeso = readVendidoPorPeso(body.vendidoPorPeso);

  if (!nombre || nombre.trim().length === 0) {
    throw ApiError.badRequest('nombre-requerido', 'El nombre es requerido.');
  }
  if (!categoriaId || categoriaId.trim().length === 0) {
    throw ApiError.badRequest('categoria-requerida', 'La categoría es requerida.');
  }
  if (!grupoAdmin) {
    throw ApiError.badRequest('grupo-invalido', 'El grupo es requerido.');
  }
  await validarGrupo(env, grupoAdmin);
  if (precio === undefined) {
    throw ApiError.badRequest('precio-requerido', 'El precio es requerido.');
  }
  if (!unidad || unidad.trim().length === 0) {
    throw ApiError.badRequest('unidad-requerida', 'La unidad es requerida.');
  }
  if (!origen || origen.trim().length === 0) {
    throw ApiError.badRequest('origen-requerido', 'El origen es requerido.');
  }
  if (!imagen || imagen.trim().length === 0) {
    throw ApiError.badRequest('imagen-requerida', 'La imagen es requerida.');
  }
  if (!imagenAlt || imagenAlt.trim().length === 0) {
    throw ApiError.badRequest('imagen-alt-requerida', 'El texto alternativo de la imagen es requerido.');
  }
  checkImageSize(imagen, 'imagen');
  checkImageSize(imagenHover, 'imagen hover');
  checkImageSource(imagen, 'imagen');
  checkImageSource(imagenHover, 'imagen hover');

  // `productId` va a null: el producto todavía no existe, así que no hay
  // circularidad ni hijas propias que comprobar, solo que la madre valga.
  const parentId = readParentId(body.parentId);
  if (parentId) {
    await checkParent(env, null, parentId);
  }
  const varianteEtiqueta = readVariantLabel(body.varianteEtiqueta);

  if (!slug) {
    slug = nombre
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      // `grupo_admin` (sin `_id`) va con un valor fijo, no con el real: es la
      // columna vieja, `NOT NULL` sin DEFAULT, que la migración 0025 no pudo
      // tocar sin recrear la tabla (ver esa migración). Nada la lee ya; esto
      // solo la mantiene satisfecha para que el INSERT no falle.
      `INSERT INTO products (
        id, slug, nombre, tagline, categoria_id, grupo_admin, grupo_admin_id,
        precio, precio_costo, unidad, cantidad_unidad, origen,
        imagen, imagen_hover, imagen_alt, parent_id, variante_etiqueta, vendido_por_peso
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'agroindustriales', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    )
      .bind(id, slug, nombre, tagline, categoriaId, grupoAdmin, precio, precioCosto, unidad, cantidadUnidad, origen, imagen, imagenHover ?? null, imagenAlt, parentId, varianteEtiqueta, vendidoPorPeso)
      .run();
  } catch (error) {
    if ((error as Error).message.includes('UNIQUE constraint failed: products.slug')) {
      throw ApiError.badRequest('slug-duplicado', 'Ya existe un producto con ese slug.');
    }
    throw error;
  }

  const product = await env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM products WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ product }, 201);
}

/**
 * POST /api/admin/products/recalcular-abc
 *
 * Refresca la columna `categoria_abc` a partir de las ventas reales.
 *
 * La clasificación se calcula con el acumulado **anterior** a cada producto:
 * el que cruza el 80 % sigue siendo clase A. Si se mirara el acumulado ya
 * sumado, un producto que por sí solo pasara del 80 % caería en B y la clase A
 * quedaría vacía.
 */
export async function recalcAbc(env: Env, user: JwtPayload): Promise<Response> {
  requireRole(user, 'ADMIN_INVENTARIO');

  const result = await env.DB.prepare(
    `WITH ventas AS (
       SELECT oi.product_id AS pid,
              SUM(oi.precio_unitario * oi.cantidad) AS ingreso
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        -- 'pago' entra sin condicionar a si ya se liquidó el efectivo: esto
        -- clasifica ventas por ingreso (qué tanto vende cada producto), no
        -- contabiliza caja — un pedido cobrado en la puerta ya es una venta
        -- real aunque el efectivo no haya llegado todavía a la finca.
        WHERE o.estado IN ('aprobado', 'enviado', 'pago')
        GROUP BY oi.product_id
     ),
     acumulado AS (
       SELECT pid,
              ingreso,
              SUM(ingreso) OVER () AS total,
              COALESCE(
                SUM(ingreso) OVER (
                  ORDER BY ingreso DESC, pid
                  ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                ), 0
              ) AS previo
         FROM ventas
     )
     UPDATE products
        SET categoria_abc = (
              SELECT CASE
                       WHEN a.total = 0 THEN 'C'
                       WHEN a.previo < a.total * 0.80 THEN 'A'
                       WHEN a.previo < a.total * 0.95 THEN 'B'
                       ELSE 'C'
                     END
                FROM acumulado a WHERE a.pid = products.id
            )
      WHERE id IN (SELECT pid FROM acumulado)`,
  ).run();

  return json({ actualizados: result.meta.changes });
}
