import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, tap, throwError } from 'rxjs';
import { ApiSession, TokenStore } from './token-store';
import { UserRole, WholesaleRole } from '../models/user.model';
import { PaymentMethod, WebPaymentMethod } from '../models/order.model';
import {
  CategoryId,
  Product,
  ProductBadge,
  ProductUnit,
} from '../models/product.model';

/** Cuenta del panel. `password_hash` nunca sale del servidor. */
export interface ApiUser {
  readonly id: string;
  readonly email: string;
  readonly nombre: string;
  readonly activo: number;
  readonly creadoEn: string;
  readonly roles: readonly UserRole[];
  /**
   * ⚠ Sin uso desde la migración 0023: el crédito se mudó a la ficha del
   * contacto (`contactId` de aquí abajo). Se sigue devolviendo por si algo
   * viejo lo lee, pero el panel ya no lo muestra ni lo escribe.
   */
  readonly cupoCredito: number;
  readonly diasCredito: number;
  /**
   * La ficha de la agenda enlazada a esta cuenta (migración 0024). `null` es
   * el estado normal: la mayoría de las cuentas no tiene enlace, y su
   * checkout busca o crea la ficha por el teléfono que escriban ese día.
   *
   * Con enlace, el checkout de esta cuenta usa SIEMPRE esta ficha —así el
   * cupo que se le abrió no se pierde si un día teclea otro teléfono.
   */
  readonly contactId: string | null;
  /** El nombre de esa ficha, para pintarlo sin cruzar con Contactos. */
  readonly contactoNombre: string | null;
}

/** Forma estable de los errores del Worker: `{ error: { code, message, details } }`. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface Shortfall {
  readonly productId: string;
  readonly productName: string;
  readonly requested: number;
  readonly available: number;
}

/** Fila de `categories`. Los chips de la vitrina y el desplegable del panel. */
/** Un producto dentro de una canasta, con lo necesario para pintarlo. */
export interface ApiComponent {
  readonly childId: string;
  readonly nombre: string;
  readonly unidad: string;
  readonly cantidadUnidad: number;
  /** Stock del componente suelto, para ver cuál es el que frena la canasta. */
  readonly stock: number;
  readonly activo: number;
  /**
   * 1 = el componente se vende a granel. Es lo que decide si su cantidad en la
   * receta puede ser una fracción: «medio kilo de papa» sí, «medio huevo» no.
   */
  readonly vendidoPorPeso: number;
  /** Cuántos entran en UNA canasta. Decimal solo si el componente es a granel. */
  readonly cantidadRequerida: number;
}

/** La receta completa de una canasta. */
export interface ApiRecipe {
  readonly parentId: string;
  readonly componentes: readonly ApiComponent[];
  /**
   * Cuántas canastas salen con el inventario de ahora, por el componente más
   * escaso. `null` = no es canasta, se vende con su propio stock.
   */
  readonly armables: number | null;
}

export interface ApiCategory {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string;
  /**
   * Clave de la silueta del chip: 'hoja', 'panal', 'espiga'… El repertorio
   * vive en `CategoryIcon`; aquí solo viaja cuál le toca. Vacío = la de por
   * defecto, que es lo que trae una categoría recién creada.
   */
  readonly icono: string;
  /** Id de la fila en `admin_groups`. Desde la 0025 ya no es un literal fijo. */
  readonly grupoAdmin: string;
  /** Posición del chip. Menor va antes. */
  readonly orden: number;
  readonly activo: 0 | 1;
  readonly actualizadoEn: string;
  /** Cuántos productos cuelgan de ella. Solo en `/api/admin/categories`. */
  readonly productos?: number;
}

/**
 * Un grupo tal como lo ve la tienda: solo lo que hace falta para pintar su
 * solapa.
 *
 * Deliberadamente más pobre que `ApiAdminGroup`. `mostrarFiltroFino` y
 * `activo` describen cómo se comporta el panel, y el endpoint público ni
 * siquiera los manda: la vitrina no tiene por qué enterarse de la forma
 * interna del inventario.
 */
export interface ApiPublicGroup {
  readonly id: string;
  readonly nombre: string;
  /** Clave de la silueta (`CategoryIcon`). Vacío = la de por defecto. */
  readonly icono: string;
  /** Posición de la solapa. Menor va antes. */
  readonly orden: number;
}

/**
 * Un grupo del panel de compras ("Frutas", "Verduras", "Agroindustriales"...).
 *
 * Eran tres literales fijos; desde la migración 0025 son filas de
 * `admin_groups`, editables desde Inventario → Grupos.
 */
export interface ApiAdminGroup {
  readonly id: string;
  readonly nombre: string;
  /**
   * "Este grupo mezcla categorías muy distintas, mostrar filtro adicional" —
   * la casilla que en Inventario abre el desplegable de categoría fina bajo
   * este grupo. Reemplaza comparar el nombre contra el literal
   * 'agroindustriales': ahora cualquier grupo puede encenderla.
   */
  readonly mostrarFiltroFino: 0 | 1;
  readonly orden: number;
  readonly activo: 0 | 1;
  /** Clave de la silueta (`CategoryIcon`, compartida con categorías). Vacío = la de por defecto. */
  readonly icono: string;
  readonly actualizadoEn: string;
  /** Cuántas categorías y productos lo usan. Solo en `/api/admin/admin-groups`. */
  readonly categorias?: number;
  readonly productos?: number;
}

export interface ApiProduct {
  readonly id: string;
  readonly slug: string;
  readonly nombre: string;
  readonly tagline: string;
  readonly categoriaId: string;
  readonly grupoAdmin: string;
  readonly precio: number;
  readonly precioAnterior: number | null;
  readonly unidad: string;
  /** Cuánto lleva la presentación: 500 con unidad 'gr', 5 con 'unidad'. */
  readonly cantidadUnidad: number;
  readonly origen: string;
  readonly rating: number;
  readonly reviewCount: number;
  readonly badge: string | null;
  /** 1 = sale en "Más vendidos" de la portada. Decisión comercial, no del stock. */
  readonly destacado: number;
  readonly stock: number;
  readonly imagen: string;
  readonly imagenHover: string | null;
  readonly imagenAlt: string;
  /** Producto sombrilla del que esta fila es variante. `null` = producto suelto o madre. */
  readonly parentId?: string | null;
  /** Solo en las madres: 'presentación', 'sabor'… */
  readonly varianteEtiqueta?: string | null;
  /**
   * Código de barras impreso, si lo tiene. Solo viaja en las respuestas del
   * panel: la tienda pública no lo necesita y es un dato de operación interna.
   * Es lo único contra lo que puede comparar el lector de la caja.
   */
  readonly codigoBarras?: string | null;
  /**
   * Qué lleva dentro, si es una canasta. Solo lo que el cliente puede saber:
   * nombre y cuánto entra, nunca el stock ni el costo de cada componente.
   */
  readonly contiene?: readonly {
    readonly nombre: string;
    readonly cantidad: number;
    readonly unidad: string;
    readonly cantidadUnidad: number;
  }[];
  /**
   * Precio ya con el descuento del nivel de mayorista de la sesión. Solo llega
   * en `/api/products` y solo si la cuenta tiene tarifa para ese producto: sin
   * sesión, o siendo cliente normal, el campo no viene y se paga `precio`.
   *
   * Lo calcula el servidor. La tienda no recibe la tabla de descuentos, así
   * que desde el navegador no se pueden ver los tratos de otros niveles.
   */
  readonly precioMayorista?: number;
  readonly descuentoMayorista?: number;
  /** Solo en las respuestas de /api/admin/*. */
  readonly precioCosto?: number;
  readonly stockSeguridad?: number;
  readonly categoriaAbc?: 'A' | 'B' | 'C';
  readonly margenUnitario?: number;
  /**
   * 1 = tiene receta: su stock sale de los componentes, no de columna propia.
   * 1 en `tieneVariantes` = es madre y el inventario vive en sus hijas.
   *
   * Las pantallas que mueven inventario (registrar una compra) no deben
   * ofrecer ninguna de las dos: sumarles unidades escribiría en una columna
   * que nadie lee. Solo en `/api/admin/*`.
   */
  readonly esCanasta?: number;
  readonly tieneVariantes?: number;
  /**
   * 1 = se ofrece esta semana · 0 = el agricultor no tiene cosecha.
   *
   * Solo llega en `/api/admin/*`: el catálogo público ya viene filtrado por
   * el servidor, así que allí todo lo que llega está activo por definición.
   */
  readonly activo?: number;
  /**
   * 1 = se vende a granel, pesado en la caja: el ticket del POS pide un peso
   * decimal en vez de un conteo de unidades. Solo en `/api/admin/*`.
   */
  readonly vendidoPorPeso?: number;
}

/**
 * Traduce el `ApiProduct` del Worker (columnas en español, tal cual las
 * expone la API) al `Product` que ya consume toda la tienda pública
 * (`nombre` → `name`, `precio` → `price`, …).
 *
 * Existe para que conectar el catálogo público al backend real sea cambiar
 * **de dónde** sale el `Product[]`, no reescribir cada componente de la
 * vitrina. `/api/products` (el endpoint público) no manda `precioCosto` ni
 * `stockSeguridad` — son columnas solo de `/api/admin/*` — así que aquí caen
 * a 0: la tienda pública nunca los muestra, solo el panel.
 */
export function toProduct(p: ApiProduct): Product {
  return {
    id: p.id,
    slug: p.slug,
    name: p.nombre,
    tagline: p.tagline,
    categoryId: p.categoriaId as CategoryId,
    // `price` es siempre lo que paga quien mira: con tarifa de mayorista, el
    // precio ya descontado. Así el carrito y el checkout suman sin saber que
    // los mayoristas existen, y `listPrice` queda solo para pintar el tachado.
    price: p.precioMayorista ?? p.precio,
    listPrice: p.precioMayorista !== undefined ? p.precio : undefined,
    wholesaleDiscount: p.descuentoMayorista,
    compareAtPrice: p.precioAnterior ?? undefined,
    costPrice: p.precioCosto ?? 0,
    unit: p.unidad as ProductUnit,
    quantity: p.cantidadUnidad ?? 1,
    origin: p.origen,
    rating: p.rating,
    reviewCount: p.reviewCount,
    badge: (p.badge as ProductBadge | null) ?? undefined,
    featured: p.destacado === 1,
    stock: p.stock,
    safetyStock: p.stockSeguridad ?? 0,
    image: p.imagen,
    imageHover: p.imagenHover ?? undefined,
    imageAlt: p.imagenAlt,
    parentId: p.parentId ?? undefined,
    variantLabel: p.varianteEtiqueta ?? undefined,
    // Solo viene en las canastas. Su ausencia es lo que distingue un producto
    // normal de uno que se arma con otros, así que se deja `undefined` en vez
    // de un array vacío: la tienda pregunta por el contenido, no por su largo.
    contains: p.contiene?.map((c) => ({
      name: c.nombre,
      quantity: c.cantidad,
      unit: c.unidad as ProductUnit,
      unitQuantity: c.cantidadUnidad,
    })),
  };
}

export interface ApiOrderItem {
  readonly productId: string;
  readonly productoNombre: string;
  readonly precioUnitario: number;
  readonly costoUnitario: number;
  readonly cantidad: number;
  /**
   * Stock actual del producto, ya incluido en la línea del pedido. Así el
   * detalle es legible también para `GESTOR_PEDIDOS`, que no tiene permiso
   * sobre `/api/admin/products` (esa ruta expone costo y margen, que no son
   * de su incumbencia). `null` si el producto se borró del catálogo.
   */
  readonly stockDisponible: number | null;
  /**
   * Si esta línea es una canasta, qué llevaba dentro — con la receta
   * **congelada** el día que se vendió, no la de hoy. Ausente en un producto
   * simple; es lo que distingue una línea de la otra.
   */
  readonly contiene?: readonly {
    readonly nombre: string;
    readonly cantidad: number;
    readonly unidad: string;
    readonly cantidadUnidad: number;
  }[];
}

export interface ApiOrderStatusLogEntry {
  readonly estado:
    | 'verificacion' | 'pendiente' | 'aprobado' | 'enviado' | 'cancelado' | 'editado'
    | 'pago' | 'liquidado' | 'rechazado';
  readonly actorId: string | null;
  /** Nombre del cliente en la creación; nombre del admin en el resto de pasos. */
  readonly actorNombre: string | null;
  readonly creadoEn: string;
}

export interface ApiOrder {
  readonly id: string;
  readonly referencia: string;
  /** La ficha de la agenda a la que se le cobra. Ver migraciones 0022–0024. */
  readonly contactId: string | null;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  readonly estado: 'verificacion' | 'pendiente' | 'aprobado' | 'enviado' | 'cancelado' | 'pago';
  readonly stockReservado: number;
  readonly subtotal: number;
  readonly envio: number;
  readonly total: number;
  readonly comprobanteNombre?: string | null;
  /**
   * Si el pedido trae comprobante adjunto. La imagen **no** viaja en el
   * listado: vive en Workers KV y se pide aparte con `orderReceipt()` solo
   * cuando el admin abre ese pedido concreto.
   */
  readonly tieneComprobante?: number | null;
  readonly aprobadoEn?: string | null;
  readonly metodoPago: PaymentMethod;
  /** Solo importa para contra entrega — ver la migración 0015. */
  readonly efectivoLiquidado: number;
  /**
   * Cuándo vence la deuda. Solo en 'credito'; `null` en el resto, donde no
   * hay nada que vencer porque el dinero ya entró o se cobra en la puerta.
   */
  readonly venceEn: string | null;
  readonly closingId: string | null;
  readonly creadoEn: string;
  /** Quién lo lleva (migración 0029). `null` = sin asignar o se recoge en finca. */
  readonly domiciliarioId: string | null;
  /** Copia congelada: sobrevive a que se borre la cuenta del domiciliario. */
  readonly domiciliarioNombre: string | null;
  readonly items: readonly ApiOrderItem[];
}

/**
 * Un pedido 'enviado' pendiente en la calle, tal como lo ve un domiciliario.
 *
 * `metodoPago` decide qué le falta: a un contra entrega hay que cobrarle
 * (`markOrderPaid`), a cualquier otro solo confirmarle la entrega
 * (`confirmDelivery`) — no trae nada que cobrar.
 */
export interface ApiDelivery {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  readonly total: number;
  readonly creadoEn: string;
  readonly metodoPago: PaymentMethod;
  /** Quién lo lleva (migración 0029). `null` = todavía sin asignar. */
  readonly domiciliarioId: string | null;
  /** Copia congelada del nombre: sobrevive a que se borre la cuenta. */
  readonly domiciliarioNombre: string | null;
  /** La ficha del cliente, para poder registrarle un abono en la puerta. */
  readonly contactId: string | null;
  /**
   * Lo que este cliente debe de antes, sin contar este pedido. Viaja con la
   * entrega porque es lo que hace falta saber en la puerta cuando el cliente
   * saca plata de una deuda vieja.
   */
  readonly deudaAnterior: number;
  readonly items: readonly {
    readonly productoNombre: string;
    readonly precioUnitario: number;
    readonly cantidad: number;
  }[];
}

export interface ApiSalesRow {
  readonly productId: string;
  readonly nombre: string;
  readonly unidades: number;
  readonly ingresos: number;
  readonly costo: number;
  readonly ganancia: number;
  readonly pedidos: number;
  readonly origen: string;
  readonly grupoAdmin: string;
  readonly stockRestante: number;
  readonly imagen: string;
  readonly imagenAlt: string;
  readonly categoriaAbc: 'A' | 'B' | 'C';
  readonly participacion: number;
}

/**
 * Un cliente encontrado por el buscador del mostrador.
 *
 * Es deliberadamente más pequeño que `ApiContact`: solo lo que hace falta para
 * decidir a quién se le está vendiendo. La agenda completa —con su resumen de
 * compras y pedidos— es otra pantalla y otra consulta.
 */
export interface ApiContactMatch {
  readonly id: string;
  readonly nombre: string;
  /** La cédula o NIT. Es la llave de negocio del cliente. */
  readonly documento: string;
  readonly telefono: string | null;
  readonly direccion: string | null;
  readonly cupoCredito: number;
  readonly diasCredito: number;
  /** Lo que debe hoy en facturas vivas. 0 = está al día. */
  readonly deuda: number;
  /** 'MAYORISTA_N2' si la ficha tiene cuenta con ese rol; null = precio de lista. */
  readonly nivelPrecio: string | null;
}

/** De qué caja hablamos: la tienda web o el mostrador físico. */
export type PosCanal = 'ecommerce' | 'pos';

/** Cómo se pagó de verdad, cuando el método de pago se queda corto. */
/**
 * Cómo se pagó un pedido. Un solo campo, el de verdad.
 *
 * Los tres primeros existen desde siempre; 'entrega_en_tienda' es la compra web
 * que el cliente pasa a recoger, y 'efectivo'/'tarjeta' solo nacen en el
 * mostrador. La columna que lo respalda no lleva CHECK: esta lista y la del
 * Worker son la validación real (ver la nota en schema.sql).
 */
export type MetodoPago =
  | 'transferencia'
  | 'contraentrega'
  | 'credito'
  | 'entrega_en_tienda'
  | 'efectivo'
  | 'tarjeta';

export interface ApiPosItemInput {
  readonly productId: string;
  readonly cantidad: number;
  /** Precio que el cajero fijó a mano. Si difiere del calculado, exige motivo. */
  readonly precioManual?: number;
  readonly motivoAjuste?: string;
}

export interface ApiPosSellInput {
  readonly contactId?: string | null;
  readonly clienteNombre?: string;
  readonly clienteTelefono?: string;
  readonly items: readonly ApiPosItemInput[];
  readonly metodoPago: 'efectivo' | 'tarjeta' | 'credito';
  readonly reciboSolicitado: boolean;
  /**
   * Cuánto dio el cliente, si es menos que el total. Ausente o mayor o igual
   * al total es un cobro completo; con un valor menor, el resto queda vivo en
   * el saldo de la factura — mismo campo que ya usa `markOrderPaid()` para el
   * abono del domiciliario.
   */
  readonly montoAbono?: number;
}

export interface ApiPosVentaItem {
  readonly productId: string;
  readonly productoNombre: string;
  readonly precioUnitario: number;
  readonly cantidad: number;
  readonly motivoAjuste: string | null;
}

export interface ApiPosVenta {
  readonly id: string;
  readonly referencia: string;
  readonly contactId: string | null;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly estado: string;
  readonly subtotal: number;
  readonly envio: number;
  readonly total: number;
  readonly metodoPago: MetodoPago;
  readonly canal: PosCanal;
  readonly reciboSolicitado: number;
  readonly venceEn: string | null;
  readonly creadoEn: string;
  readonly items: readonly ApiPosVentaItem[];
  readonly factura: {
    readonly id: string;
    readonly numero: string;
    readonly total: number;
    readonly saldo: number;
    readonly estado: string;
    readonly emitidaEn: string;
  } | null;
}

/** Fila del historial de caja. Trae sus líneas para no pedirlas una a una. */
export interface ApiPosVentaResumen {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly contactId: string | null;
  readonly estado: string;
  readonly subtotal: number;
  readonly total: number;
  readonly metodoPago: MetodoPago;
  readonly reciboSolicitado: number;
  readonly closingId: string | null;
  readonly creadoEn: string;
  readonly invoiceId: string | null;
  readonly invoiceNumero: string | null;
  readonly items: readonly ApiPosVentaItem[];
}

export interface ApiCashConsolidadoFila {
  readonly canal: PosCanal;
  readonly cierres: number;
  readonly pedidos: number;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
  readonly ganancia: number;
  readonly enviosCobrados: number;
  readonly totalRecaudado: number;
  readonly totalGastos: number;
  readonly totalCobrado: number;
}

export interface ApiCashConsolidado {
  readonly porCanal: readonly ApiCashConsolidadoFila[];
  readonly total: Omit<ApiCashConsolidadoFila, 'canal'>;
  readonly desde: string | null;
  readonly hasta: string | null;
}

export interface ApiAjuste {
  readonly clave: string;
  readonly descripcion: string;
  readonly valor: string;
}

export interface ApiCashSummary {
  readonly pedidos: number;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
  readonly ganancia: number;
  readonly enviosCobrados: number;
  readonly totalRecaudado: number;
  readonly porMetodo: readonly { metodo: string; pedidos: number; total: number }[];
}

/** Una fila de la pantalla de tarifas: el producto y su descuento en un nivel. */
export interface ApiWholesaleRow {
  readonly productId: string;
  readonly nombre: string;
  readonly categoriaId: string;
  readonly grupoAdmin: string;
  readonly unidad: string;
  readonly cantidadUnidad: number;
  readonly precio: number;
  readonly precioCosto: number;
  readonly activo: number;
  /** `null` = sin trato especial en este nivel. */
  readonly porcentaje: number | null;
  readonly precioMayorista: number;
  readonly actualizadoEn: string | null;
}

export interface ApiWholesaleTariff {
  readonly role: WholesaleRole;
  readonly products: readonly ApiWholesaleRow[];
  readonly resumen: {
    readonly conDescuento: number;
    readonly total: number;
    /** Productos cuya tarifa queda por debajo del costo de la finca. */
    readonly bajoCosto: number;
  };
}

/** Una línea del consolidado: cuánto hay que cosechar de un producto. */
export interface ApiConsolidationProduct {
  readonly productId: string;
  readonly nombre: string;
  /** Presentaciones vendidas, no unidades de medida. */
  readonly cantidadTotal: number;
  readonly pedidos: number;
  readonly unidad: string;
  /** Cuánto lleva cada presentación: 500 con `unidad: 'gr'`. */
  readonly cantidadUnidad: number;
  readonly grupoAdmin: string;
  /** Categoría fina (lácteos, mieles, verduras…), no solo el grupo macro. */
  readonly categoriaId: string;
  readonly origen: string;
}

/** Un pedido en la hoja de ruta, con el domicilio ya auditado. */
/** Una canasta a armar, con cuántas y para cuántos pedidos. */
export interface ApiConsolidationBasket {
  readonly productId: string;
  readonly nombre: string;
  readonly cantidadTotal: number;
  readonly pedidos: number;
}

export interface ApiConsolidationOrder {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  readonly estado: string;
  readonly subtotal: number;
  readonly envio: number;
  readonly total: number;
  readonly unidades: number;
  readonly creadoEn: string;
  readonly cobroEnvio: boolean;
  /** Lo que la regla vigente dice que debió cobrarse. */
  readonly envioEsperado: number;
  readonly envioCorrecto: boolean;
  readonly diferenciaEnvio: number;
}

export interface ApiConsolidation {
  readonly ventana: {
    readonly desde: string | null;
    readonly hasta: string | null;
    readonly soloJornadaAbierta: boolean;
    readonly estados: readonly string[];
  };
  readonly regla: {
    readonly umbralEnvioGratis: number;
    readonly costoEnvio: number;
  };
  readonly productos: readonly ApiConsolidationProduct[];
  /**
   * Canastas a armar. **No se suman a `productos`**: sus componentes ya están
   * repartidos ahí como cantidades a cosechar, y contarlos otra vez duplicaría
   * el mismo tomate. Esta lista es para quien empaca, no para quien cosecha.
   */
  readonly canastas: readonly ApiConsolidationBasket[];
  readonly pedidos: readonly ApiConsolidationOrder[];
  readonly domicilios: {
    readonly pedidos: number;
    readonly conCobro: number;
    readonly sinCobro: number;
    readonly totalRecaudado: number;
    readonly diferencia: number;
    readonly descuadres: number;
  };
  readonly totales: {
    readonly pedidos: number;
    readonly referencias: number;
    readonly unidades: number;
    readonly ventaProducto: number;
  };
  /** Pedidos sin aprobar en la misma ventana: no entran, pero avisan. */
  readonly pendientes: {
    readonly pedidos: number;
    readonly subtotal: number;
  };
}

/** Una línea del detalle de un cierre: el pedido tal y como entró en la caja. */
export interface ApiClosingOrder {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly estado: 'verificacion' | 'pendiente' | 'aprobado' | 'enviado';
  readonly envio: number;
  readonly creadoEn: string;
  readonly aprobadoEn: string | null;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
}

/** Categorías del CHECK de `expenses`. Fuera de estas, D1 rechaza la fila. */
export type ExpenseCategory = 'transporte' | 'empaque' | 'servicios' | 'otros';

/**
 * Un gasto operativo de la jornada.
 *
 * `closingId` es toda la máquina de estados que tiene: `null` mientras la
 * jornada está abierta —y entonces se puede borrar— y con valor una vez el
 * cierre lo adoptó, cuando ya es parte de una cuenta congelada.
 */
export interface ApiExpense {
  readonly id: string;
  readonly descripcion: string;
  readonly monto: number;
  readonly categoria: ExpenseCategory;
  readonly creadoEn: string;
  readonly creadoPor: string | null;
  readonly closingId: string | null;
}

/**
 * Baja de inventario por merma (migración 0034).
 *
 * La causa raíz es lista cerrada porque es por donde agrupa el informe: con
 * texto libre («podrido», «pudrición», «se dañó») no se podría sumar nada.
 */
export type MotivoMerma = 'deshidratacion' | 'pudricion' | 'vencimiento' | 'rotura' | 'otro';

/** Etiquetas legibles de cada motivo, para pintarlas sin un `switch` por vista. */
export const MOTIVO_MERMA_LABELS: Readonly<Record<MotivoMerma, string>> = {
  deshidratacion: 'Deshidratación',
  pudricion: 'Pudrición / deterioro',
  vencimiento: 'Vencimiento',
  rotura: 'Rotura / empaque dañado',
  otro: 'Otro',
};

export interface ApiMermaItem {
  readonly productId: string;
  /** Nombre y unidad congelados el día del descarte. */
  readonly productoNombre: string;
  readonly unidad: string;
  readonly cantidad: number;
  readonly costoUnitario: number;
  readonly subtotalCosto: number;
  readonly precioUnitario: number;
  readonly subtotalVenta: number;
  readonly motivo: MotivoMerma;
  readonly observacion: string | null;
}

export interface ApiMerma {
  readonly id: string;
  /** Lo que costó de verdad: es lo que resta de la ganancia del cierre. */
  readonly totalCosto: number;
  /** Lo que se habría facturado. Dato del informe, no entra en cuentas. */
  readonly totalVenta: number;
  readonly observaciones: string | null;
  readonly creadoEn: string;
  readonly creadoPor: string | null;
  /** Con cierre puesto ya no se puede deshacer: es cuenta congelada. */
  readonly closingId: string | null;
  readonly items: readonly ApiMermaItem[];
}

export interface ApiMermaReporte {
  readonly porMotivo: readonly {
    readonly motivo: MotivoMerma;
    readonly actas: number;
    readonly cantidad: number;
    readonly costo: number;
    readonly venta: number;
  }[];
  readonly porProducto: readonly {
    readonly productId: string;
    readonly productoNombre: string;
    readonly unidad: string;
    readonly cantidad: number;
    readonly costo: number;
    readonly venta: number;
  }[];
  readonly total: { readonly actas: number; readonly costo: number; readonly venta: number };
}

/** Cómo se le gira a un proveedor. `null` = se le paga en efectivo. */
export type AccountType = 'ahorros' | 'corriente' | 'nequi' | 'daviplata';

/**
 * Una ficha de la agenda: proveedor, cliente, o las dos cosas.
 *
 * `esProveedor` y `esCliente` son banderas independientes porque la misma
 * persona puede vender y comprar — a una vereda se le compra lechuga y esa
 * misma vereda compra huevos.
 *
 * Los contadores (`compras`, `pedidos`, …) los calcula el servidor sobre el
 * historial: son de solo lectura y no se mandan al guardar.
 */
export interface ApiContact {
  readonly id: string;
  readonly nombre: string;
  readonly esProveedor: number;
  readonly esCliente: number;
  readonly telefono: string | null;
  readonly direccion: string | null;
  readonly notas: string | null;
  readonly banco: string | null;
  readonly tipoCuenta: AccountType | null;
  readonly numeroCuenta: string | null;
  readonly titular: string | null;
  readonly documento: string | null;
  /**
   * Cuánto se le puede fiar. 0 = no se le fía.
   *
   * Vive aquí y no en la cuenta de usuario porque la deuda la tiene una
   * persona, no un login: se le fía igual a un cliente sin cuenta. Ver la
   * migración 0023.
   */
  readonly cupoCredito: number;
  /** A cuántos días vence lo fiado. De aquí sale `orders.venceEn`. */
  readonly diasCredito: number;
  readonly activo: number;
  readonly creadoEn: string;

  /** Resumen del historial. Solo en el listado. */
  readonly compras?: number;
  readonly compradoTotal?: number;
  /** Lo que se le debe todavía a este proveedor. */
  readonly porPagar?: number;
  readonly pedidos?: number;
  /** Cuánto ha comprado él, sin domicilios. */
  readonly compradoPorEl?: number;
  readonly ultimoPedido?: string | null;
}

/** Lo que el formulario de la agenda manda. Los contadores no viajan. */
export interface ContactInput {
  readonly nombre: string;
  readonly esProveedor: boolean;
  readonly esCliente: boolean;
  readonly telefono: string | null;
  readonly direccion: string | null;
  readonly notas: string | null;
  readonly banco: string | null;
  readonly tipoCuenta: AccountType | null;
  readonly numeroCuenta: string | null;
  readonly titular: string | null;
  readonly documento: string | null;
  readonly cupoCredito: number;
  readonly diasCredito: number;
  readonly activo: boolean;
}

/** Una línea de compra: qué producto, cuánto y a qué costo se negoció. */
export interface ApiPurchaseItem {
  readonly productId: string;
  readonly productoNombre: string;
  readonly unidad: string;
  readonly cantidad: number;
  /** El costo pactado ese día, congelado. Puede diferir del catálogo de hoy. */
  readonly costoUnitario: number;
  readonly subtotal: number;
}

/**
 * Una compra a una finca.
 *
 * Registrarla sube el inventario y fija `products.precio_costo`. NO se resta
 * de la ganancia: ese costo ya se cuenta al vender, cuando viaja congelado a
 * la línea del pedido. Ver `worker/src/routes/purchases.ts`.
 */
export interface ApiPurchase {
  readonly id: string;
  /** La ficha del proveedor en la agenda. `null` en compras sin enlazar. */
  readonly contactId: string | null;
  /**
   * El nombre del proveedor COPIADO al comprar. No es redundante con
   * `contactId`: si mañana se corrige la ficha, esta compra sigue diciendo a
   * quién se le compró ese día.
   */
  readonly origen: string;
  /** Datos vivos de la ficha, para saber a dónde girarle. */
  readonly proveedorTelefono: string | null;
  readonly proveedorBanco: string | null;
  readonly proveedorTipoCuenta: AccountType | null;
  readonly proveedorNumeroCuenta: string | null;
  readonly proveedorTitular: string | null;
  /** Suma del detalle, calculada por el servidor. */
  readonly totalPago: number;
  /** 'pendiente' = la mercancía entró pero al agricultor no se le ha girado. */
  readonly estado: 'pendiente' | 'pagado';
  readonly notas: string | null;
  readonly creadoEn: string;
  readonly creadoPor: string | null;
  readonly pagadoEn: string | null;
  readonly pagadoPor: string | null;
  readonly items: readonly ApiPurchaseItem[];
}

/** Lo que el formulario manda por línea. El servidor recalcula los totales. */
export interface PurchaseItemInput {
  readonly productId: string;
  readonly cantidad: number;
  readonly costoUnitario: number;
}

/**
 * Lo que el formulario de compra manda.
 *
 * Se manda `contactId` y el servidor saca el nombre de la agenda, para que una
 * compra no pueda quedar a nombre de un proveedor que no existe.
 */
export interface PurchaseInput {
  readonly contactId: string;
  readonly notas: string | null;
  readonly items: readonly PurchaseItemInput[];
}

export interface ApiClosing {
  readonly id: string;
  readonly referencia: string;
  readonly cerradoEn: string;
  readonly cerradoPor: string;
  readonly pedidos: number;
  readonly unidades: number;
  readonly ventaProducto: number;
  readonly costoProducto: number;
  /** Venta − costo de mercancía − gastos. Lo que quedó de verdad. */
  readonly ganancia: number;
  /** Congelado como dato operativo. No suma a nada — ver migración 0019. */
  readonly enviosCobrados: number;
  readonly totalRecaudado: number;
  /** Gastos operativos de la jornada. Ya restados en `ganancia`. */
  readonly totalGastos: number;
}

/**
 * Una deuda viva de un mayorista: pedido a crédito entregado y sin pagar.
 *
 * `diasVencido` y `tramo` los calcula el Worker contra el reloj de la base,
 * no el navegador: si los calculara cada cliente, dos personas en husos
 * distintos verían vencida la misma factura en días distintos.
 */
/**
 * Una factura (migración 0027) — el documento contable de una venta.
 *
 * No hay forma de crearla ni editarla desde el cliente, y es deliberado: nace
 * sola al aprobar el pedido, y se corrige anulándola y emitiendo otra.
 */
export interface ApiInvoice {
  readonly id: string;
  /** Posición en la numeración. Sirve para ordenar sin depender del texto. */
  readonly consecutivo: number;
  /** Ya formateado: «FAC-000123». */
  readonly numero: string;
  readonly orderId: string | null;
  readonly contactId: string | null;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly subtotal: number;
  readonly envio: number;
  readonly total: number;
  /** Lo que falta por cobrar. 0 en las pagadas y en las anuladas. */
  readonly saldo: number;
  readonly estado: 'emitida' | 'pagada_parcial' | 'pagada' | 'anulada';
  readonly emitidaEn: string;
  readonly venceEn: string | null;
  readonly anuladaEn: string | null;
  /** También guarda el motivo de una nota: las dos responden «por qué existe». */
  readonly motivoAnulacion: string | null;
  /**
   * Qué clase de documento es (migración 0030). Una nota vive en la misma
   * tabla que la factura porque es lo mismo —número, líneas, cliente— y solo
   * cambia qué le hace al saldo de otra.
   */
  readonly tipo: 'factura' | 'nota_credito' | 'nota_debito';
  /** La factura que esta nota corrige. `null` en las facturas. */
  readonly invoiceOrigenId: string | null;
}

/** Lo que se manda al emitir una nota crédito o débito. */
export interface ApiNotaInput {
  readonly tipo: 'nota_credito' | 'nota_debito';
  /** Obligatorio: una nota sin explicación no se puede auditar. */
  readonly motivo: string;
  readonly items: readonly ApiInvoiceItemInput[];
}

/** Una línea de la factura. Congelada: lo que se cobró y a qué precio ese día. */
export interface ApiInvoiceItem {
  readonly id: number;
  /** `null` cuando se cobró algo que no está en el catálogo. */
  readonly productId: string | null;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precioUnitario: number;
  /** `cantidad × precioUnitario`, calculado por el servidor. */
  readonly importe: number;
}

/** Lo que se manda al crear o editar una factura. El importe lo calcula el servidor. */
export interface ApiInvoiceItemInput {
  readonly productId?: string | null;
  readonly descripcion: string;
  readonly cantidad: number;
  readonly precioUnitario: number;
}

export interface ApiInvoiceInput {
  readonly contactId?: string | null;
  readonly clienteNombre: string;
  readonly clienteTelefono?: string;
  readonly envio?: number;
  readonly venceEn?: string | null;
  readonly items: readonly ApiInvoiceItemInput[];
}

/**
 * Un cobro (migración 0028): entró tal plata, tal día, por tal medio.
 *
 * Separado de la factura a propósito. Contra qué deudas se aplica lo dicen sus
 * `allocations`, y por eso un mismo cobro puede cubrir varias facturas.
 */
export interface ApiPayment {
  readonly id: string;
  readonly referencia: string;
  readonly contactId: string | null;
  readonly clienteNombre: string;
  readonly monto: number;
  readonly metodo: 'efectivo' | 'transferencia' | 'nequi' | 'daviplata';
  readonly recibidoEn: string;
  readonly recibidoPorNombre: string;
  /** 0 = efectivo todavía en poder del domiciliario, no cuenta para caja. */
  readonly liquidado: 0 | 1;
  /** La jornada que se lo llevó. `null` = todavía sin cerrar, aún editable. */
  readonly closingId: string | null;
  readonly nota: string | null;
  /** Cuánto de este cobro está repartido. Lo que falte es anticipo. */
  readonly asignado?: number;
}

/** Una línea del reparto: cuánto de este cobro salda esta factura. */
export interface ApiAllocation {
  readonly id: number;
  readonly invoiceId: string;
  readonly numero: string;
  readonly monto: number;
}

/** Una factura que todavía debe algo, para armar el reparto. */
export interface ApiDeuda {
  readonly id: string;
  readonly numero: string;
  readonly total: number;
  readonly saldo: number;
  readonly emitidaEn: string;
  readonly venceEn: string | null;
  /**
   * A quién es. En `deudasDe(contactId)` es redundante —ya se sabe de quién
   * se preguntó— pero en `deudores()`, que trae TODOS los clientes de una
   * vez, es lo único que permite agruparlas. Se manda en los dos endpoints
   * para que una sola interfaz sirva a las dos pantallas.
   */
  readonly contactId: string | null;
  readonly clienteNombre: string;
}

export interface ApiPaymentInput {
  readonly contactId: string;
  readonly monto: number;
  readonly metodo?: string;
  readonly nota?: string | null;
  /** Sin reparto explícito se aplica a lo más viejo primero. */
  readonly allocations?: readonly { invoiceId: string; monto: number }[];
  /**
   * Solo importa con `metodo: 'efectivo'`, y solo lo lee el servidor cuando
   * quien registra NO es domiciliario — un domiciliario nunca puede marcar su
   * propio cobro como "ya en caja". `false` es para el caso de oficina
   * anotando un cobro que un domiciliario hizo en la calle y todavía no ha
   * entregado: sin esto, ese abono nacía "ya en caja" sin excepción y jamás
   * aparecía en "Efectivo por liquidar". Por defecto `true`.
   */
  readonly enCaja?: boolean;
}

export interface ApiPaymentSummary {
  readonly cobrado: number;
  readonly enPoderDelDomiciliario: number;
  readonly sinCerrar: number;
}

/** Las cifras de cabecera de Facturación, calculadas sobre TODAS las facturas. */
export interface ApiInvoiceSummary {
  readonly facturado: number;
  readonly porCobrar: number;
  readonly abiertas: number;
  readonly vencidas: number;
}

export interface ApiCarteraRow {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
  readonly clienteDireccion: string;
  /** Solo producto: el domicilio va aparte, en `envio`. */
  readonly total: number;
  /** Domicilio cobrado. No es venta, pero el mayorista sí lo debe: al cobrar
   *  hay que pedir `total + envio`. */
  readonly envio: number;
  readonly venceEn: string | null;
  readonly creadoEn: string;
  readonly estado: string;
  /** Negativo = aún no vence. Positivo = días de mora. `null` = sin fecha. */
  readonly diasVencido: number | null;
  readonly tramo: 'corriente' | '30' | '60' | '90';
}

/**
 * Un cobro en efectivo que todavía no se confirma que llegó a la finca.
 *
 * Dos orígenes distintos conviven en la misma fila:
 *
 *  · El cobro en la puerta de un contra entrega — `orderId` viene puesto, y
 *    con él `totalPedido`/`envio`, para poder avisar si `cobrado` es menos
 *    de lo que el pedido valía (un abono parcial). Se libera con
 *    `settleCash(orderId)`, el mismo camino que ya existía.
 *  · Un abono suelto que el domiciliario cobró en la calle —de una deuda
 *    vieja, sin pedido puntual detrás— o que oficina registró por él con
 *    "todavía no está en caja" marcado. `orderId` es `null`: no hay un solo
 *    pedido al que atarlo, un abono puede repartirse entre varias facturas
 *    de golpe. Se libera con `liquidarPago(id)`.
 */
export interface ApiEfectivoPendiente {
  readonly id: string;
  readonly referencia: string;
  readonly clienteNombre: string;
  /** Lo que trae en la mano de verdad — siempre sale de `payments.monto`. */
  readonly cobrado: number;
  /** Solo con un contra entrega: `null` en un abono suelto. */
  readonly orderId: string | null;
  /** Solo producto, sin domicilio. `null` en un abono suelto. */
  readonly totalPedido: number | null;
  /** Domicilio del pedido. `null` en un abono suelto. */
  readonly envio: number | null;
  /** Quién lo registró y cuándo — no necesariamente quien tiene la plata:
   *  puede ser oficina anotando lo que un domiciliario avisó por teléfono. */
  readonly cobradoPor: string | null;
  readonly cobradoEn: string | null;
}

/**
 * Cliente HTTP del Worker.
 *
 * Las URLs son **relativas**: en producción el mismo Worker sirve la SPA y la
 * API, así que no hay CORS ni dominio que configurar. En desarrollo,
 * `proxy.conf.json` reenvía `/api` al `wrangler dev` local.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly tokens = inject(TokenStore);

  // ──────────────────────────────── Auth ────────────────────────────────

  /** Sitekey pública de Turnstile. Vacía = no está configurada en el servidor. */
  config(): Observable<{ turnstileSiteKey: string }> {
    return this.http
      .get<{ turnstileSiteKey: string }>('/api/config')
      .pipe(catchError(handleError));
  }

  login(email: string, password: string, turnstileToken?: string | null): Observable<ApiSession> {
    return this.http
      .post<ApiSession>('/api/auth/login', { email, password, turnstileToken })
      .pipe(
        tap((session) => this.tokens.set(session)),
        catchError(handleError),
      );
  }

  logout(): void {
    this.tokens.clear();
  }

  /**
   * Pide un enlace de recuperación.
   *
   * Responde 200 exista o no la cuenta, a propósito: la interfaz muestra el
   * mismo mensaje en ambos casos para no convertir esta pantalla en un censo
   * de correos registrados.
   */
  requestPasswordReset(email: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>('/api/auth/recuperar', { email })
      .pipe(catchError(handleError));
  }

  /** Cambia la contraseña con el token que llegó por correo. */
  resetPassword(token: string, nueva: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>('/api/auth/restablecer', { token, nueva })
      .pipe(catchError(handleError));
  }

  /** Cambia la contraseña de la sesión actual. Exige la vigente. */
  changeOwnPassword(actual: string, nueva: string): Observable<{ ok: boolean }> {
    return this.http
      .post<{ ok: boolean }>('/api/auth/password', { actual, nueva })
      .pipe(catchError(handleError));
  }

  // ──────────────────────────── Usuarios ────────────────────────────

  users(): Observable<readonly ApiUser[]> {
    return this.http
      .get<{ users: ApiUser[] }>('/api/admin/users')
      .pipe(map((res) => res.users), catchError(handleError));
  }

  createUser(input: {
    email: string;
    nombre: string;
    password: string;
    roles: readonly UserRole[];
  }): Observable<ApiUser> {
    return this.http
      .post<{ user: ApiUser }>('/api/admin/users', input)
      .pipe(map((res) => res.user), catchError(handleError));
  }

  updateUser(
    id: string,
    patch: Partial<{
      nombre: string;
      email: string;
      password: string;
      roles: readonly UserRole[];
      activo: 0 | 1;
      /** `null` desenlaza la ficha de la agenda. */
      contactId: string | null;
    }>,
  ): Observable<ApiUser> {
    return this.http
      .patch<{ user: ApiUser }>(`/api/admin/users/${id}`, patch)
      .pipe(map((res) => res.user), catchError(handleError));
  }

  // ───────────────────────────── Categorías ─────────────────────────────

  /** Los chips de la vitrina. Solo las activas. */
  categories(): Observable<readonly ApiCategory[]> {
    return this.http
      .get<{ categories: ApiCategory[] }>('/api/categories')
      .pipe(map((res) => res.categories), catchError(handleError));
  }

  /** Las solapas de la vitrina. Solo los grupos activos. */
  groups(): Observable<readonly ApiPublicGroup[]> {
    return this.http
      .get<{ grupos: ApiPublicGroup[] }>('/api/groups')
      .pipe(map((res) => res.grupos), catchError(handleError));
  }

  /** Todas, con cuántos productos cuelgan de cada una. */
  adminCategories(): Observable<readonly ApiCategory[]> {
    return this.http
      .get<{ categories: ApiCategory[] }>('/api/admin/categories')
      .pipe(map((res) => res.categories), catchError(handleError));
  }

  createCategory(input: {
    nombre: string;
    /** Se deduce del nombre si no se manda. */
    id?: string;
    descripcion?: string;
    icono?: string;
    grupoAdmin?: string;
    orden?: number;
    activo?: 0 | 1;
  }): Observable<ApiCategory> {
    return this.http
      .post<{ category: ApiCategory }>('/api/admin/categories', input)
      .pipe(map((res) => res.category), catchError(handleError));
  }

  /** El `id` no se puede cambiar: es por donde apuntan los productos. */
  updateCategory(
    id: string,
    patch: Partial<{
      nombre: string;
      descripcion: string;
      icono: string;
      grupoAdmin: string;
      orden: number;
      activo: 0 | 1;
    }>,
  ): Observable<ApiCategory> {
    return this.http
      .put<{ category: ApiCategory }>(`/api/admin/categories/${id}`, patch)
      .pipe(map((res) => res.category), catchError(handleError));
  }

  /** Falla con `categoria-en-uso` si todavía quedan productos dentro. */
  deleteCategory(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/categories/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ────────────────────── Grupos del panel de compras ──────────────────────

  /** Todos, con cuántas categorías y productos usa cada uno. */
  adminGroups(): Observable<readonly ApiAdminGroup[]> {
    return this.http
      .get<{ grupos: ApiAdminGroup[] }>('/api/admin/admin-groups')
      .pipe(map((res) => res.grupos), catchError(handleError));
  }

  createAdminGroup(input: {
    nombre: string;
    /** Se deduce del nombre si no se manda. */
    id?: string;
    mostrarFiltroFino?: boolean;
    orden?: number;
    activo?: 0 | 1;
    icono?: string;
  }): Observable<ApiAdminGroup> {
    return this.http
      .post<{ grupo: ApiAdminGroup }>('/api/admin/admin-groups', input)
      .pipe(map((res) => res.grupo), catchError(handleError));
  }

  /** El `id` no se puede cambiar: es por donde apuntan categorías y productos. */
  updateAdminGroup(
    id: string,
    patch: Partial<{
      nombre: string;
      mostrarFiltroFino: boolean;
      orden: number;
      activo: 0 | 1;
      icono: string;
    }>,
  ): Observable<ApiAdminGroup> {
    return this.http
      .put<{ grupo: ApiAdminGroup }>(`/api/admin/admin-groups/${id}`, patch)
      .pipe(map((res) => res.grupo), catchError(handleError));
  }

  /** Falla con `grupo-en-uso` si todavía hay categorías o productos dentro. */
  deleteAdminGroup(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/admin-groups/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ─────────────────────── Canastas, combos y mixes ───────────────────────

  /**
   * La receta de una canasta: qué productos la llenan y cuántos de cada uno.
   *
   * `armables` es `null` cuando el producto no tiene receta —entonces es un
   * producto normal con su propio stock— y un número cuando sí la tiene: lo
   * manda el componente que primero se agote.
   */
  productComponents(productId: string): Observable<ApiRecipe> {
    return this.http
      .get<ApiRecipe>(`/api/admin/products/${productId}/componentes`)
      .pipe(catchError(handleError));
  }

  /** Añade un componente o corrige su cantidad. Repetirlo deja lo mismo. */
  setProductComponent(
    productId: string,
    childId: string,
    cantidad: number,
  ): Observable<ApiRecipe> {
    return this.http
      .put<ApiRecipe>(`/api/admin/products/${productId}/componentes`, { childId, cantidad })
      .pipe(catchError(handleError));
  }

  /** Al quitar el último, el producto deja de ser canasta. */
  removeProductComponent(productId: string, childId: string): Observable<ApiRecipe> {
    return this.http
      .delete<ApiRecipe>(`/api/admin/products/${productId}/componentes/${childId}`)
      .pipe(catchError(handleError));
  }

  // ────────────────────────────── Catálogo ──────────────────────────────

  products(): Observable<readonly ApiProduct[]> {
    return this.http
      .get<{ products: ApiProduct[] }>('/api/products')
      .pipe(map((res) => res.products), catchError(handleError));
  }

  adminProducts(): Observable<readonly ApiProduct[]> {
    return this.http
      .get<{ products: ApiProduct[] }>('/api/admin/products')
      .pipe(map((res) => res.products), catchError(handleError));
  }

  createProduct(input: {
    nombre: string;
    slug?: string;
    tagline?: string;
    categoriaId: string;
    grupoAdmin: string;
    precio: number;
    precioCosto?: number;
    unidad: string;
    cantidadUnidad?: number;
    origen: string;
    imagen: string;
    imagenHover?: string;
    imagenAlt: string;
    /** Id del producto sombrilla: nace ya como variante suya. */
    parentId?: string | null;
    /** Solo tiene efecto en las madres: 'presentación', 'sabor'… */
    varianteEtiqueta?: string | null;
    /** 1 = se vende a granel, pesado en la caja. */
    vendidoPorPeso?: 0 | 1;
  }): Observable<ApiProduct> {
    return this.http
      .post<{ product: ApiProduct }>('/api/admin/products', input)
      .pipe(map((res) => res.product), catchError(handleError));
  }

  /** Crea una variante a medio hacer a partir de otro producto. */
  duplicateProduct(id: string): Observable<ApiProduct> {
    return this.http
      .post<{ product: ApiProduct }>(`/api/admin/products/${id}/duplicar`, {})
      .pipe(map((res) => res.product), catchError(handleError));
  }

  updateProduct(
    id: string,
    patch: Partial<{
      precio: number;
      precioCosto: number;
      stock: number;
      stockSeguridad: number;
      /** 1 = se ofrece esta semana · 0 = sin oferta del agricultor. */
      activo: 0 | 1;
      /** Código de barras para la caja. Cadena vacía lo borra. */
      codigoBarras: string;
      /** 1 = se vende a granel, pesado en la caja. */
      vendidoPorPeso: 0 | 1;
    }>,
  ): Observable<ApiProduct> {
    return this.http
      .patch<{ product: ApiProduct }>(`/api/admin/products/${id}`, patch)
      .pipe(map((res) => res.product), catchError(handleError));
  }

  updateProductFull(id: string, input: {
    nombre: string;
    slug?: string;
    tagline?: string;
    categoriaId: string;
    grupoAdmin: string;
    precio: number;
    precioCosto: number;
    unidad: string;
    cantidadUnidad?: number;
    origen: string;
    imagen: string;
    imagenHover?: string;
    imagenAlt: string;
    /**
     * `null` desliga la variante y la deja suelta; **omitirlo** deja el vínculo
     * como esté. El Worker distingue los dos casos a propósito, para que un
     * formulario que no conozca este campo no pueda soltar variantes de su
     * madre al guardar un cambio de precio.
     */
    parentId?: string | null;
    varianteEtiqueta?: string | null;
    /** 1 = se vende a granel, pesado en la caja. */
    vendidoPorPeso?: 0 | 1;
  }): Observable<ApiProduct> {
    return this.http
      .put<{ product: ApiProduct }>(`/api/admin/products/${id}`, input)
      .pipe(map((res) => res.product), catchError(handleError));
  }

  // ─────────────────────────────── Pedidos ───────────────────────────────

  createOrder(input: {
    clienteNombre: string;
    clienteTelefono: string;
    clienteDireccion: string;
    /** La cedula del cliente. Obligatoria desde que es la llave de negocio. */
    clienteCedula: string;
    envio: number;
    items: readonly { productId: string; cantidad: number }[];
    comprobanteNombre?: string;
    /** Data URL del comprobante ya comprimido (ver `shared/utils/image-file.ts`). */
    comprobanteUrl?: string;
    /**
     * Se omite en transferencia: 'transferencia' es el default del servidor.
     *
     * 'credito' no cabe aquí a propósito: fiar es una decisión del panel sobre
     * una cuenta con cupo, no algo que se elija en el checkout. El Worker lo
     * vuelve a comprobar con lista blanca por si alguien llama a la API a mano.
     */
    metodoPago?: WebPaymentMethod;
  }): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>('/api/orders', input)
      .pipe(map((res) => res.order), catchError(handleError));
  }

  orders(params: { estado?: string; abiertos?: boolean } = {}): Observable<readonly ApiOrder[]> {
    const query = new URLSearchParams();
    if (params.estado) query.set('estado', params.estado);
    if (params.abiertos) query.set('abiertos', '1');

    return this.http
      .get<{ orders: ApiOrder[] }>(`/api/admin/orders?${query.toString()}`)
      .pipe(map((res) => res.orders), catchError(handleError));
  }

  approveOrder(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/aprobar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  cancelOrder(
    id: string,
    motivo?: string,
  ): Observable<{ order: ApiOrder; unidadesDevueltas: number }> {
    return this.http
      .post<{ order: ApiOrder; unidadesDevueltas: number }>(
        `/api/admin/orders/${id}/cancelar`,
        { motivo },
      )
      .pipe(catchError(handleError));
  }

  /** Borra un pedido del todo. Ver en el Worker qué casos no permite. */
  deleteOrder(id: string): Observable<{ ok: boolean; referencia: string; unidadesDevueltas: number }> {
    return this.http
      .delete<{ ok: boolean; referencia: string; unidadesDevueltas: number }>(
        `/api/admin/orders/${id}`,
      )
      .pipe(catchError(handleError));
  }

  shipOrder(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/enviar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * El domiciliario (o un admin de respaldo) marca que cobró un pedido contra
   * entrega.
   *
   * `monto` es opcional: sin él es un cobro completo, que sigue siendo el
   * camino de siempre. Con él es un abono — el cliente en la puerta solo dio
   * una parte — y el Worker lo cobra contra la factura del pedido dejando el
   * resto vivo en su saldo, sin superar nunca lo que en realidad se debía.
   */
  markOrderPaid(id: string, monto?: number): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/pagar`, monto ? { monto } : {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * El domiciliario confirma que entregó un pedido que NO es contra entrega
   * (ya venía pagado por transferencia). No hay nada que cobrar, así que a
   * diferencia de `markOrderPaid` esto no mueve `estado`, solo anota cuándo.
   */
  confirmDelivery(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/entregar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * Fía este pedido al mayorista que lo hizo. El Worker comprueba el cupo y
   * calcula el vencimiento con el plazo de esa cuenta.
   */
  grantCredit(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/credito`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /**
   * El mayorista pagó lo que debía.
   *
   * Endpoint propio y no `markOrderPaid`: a ese llega un DOMICILIARIO, que no
   * puede certificar una transferencia que no presenció. Ver collectCredit()
   * en el Worker.
   */
  collectCredit(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/recaudar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** Un admin confirma que el efectivo cobrado ya está físicamente en la finca. */
  settleOrderCash(id: string): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${id}/liquidar`, {})
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** El cliente rechazó el pedido en la puerta: devuelve el stock, como cancelar. */
  rejectDelivery(
    id: string,
    motivo?: string,
  ): Observable<{ order: ApiOrder; unidadesDevueltas: number }> {
    return this.http
      .post<{ order: ApiOrder; unidadesDevueltas: number }>(
        `/api/admin/orders/${id}/rechazar-entrega`,
        { motivo },
      )
      .pipe(catchError(handleError));
  }

  /** Pedidos contra entrega 'enviado', para la vista del domiciliario. Sin costo ni margen. */
  deliveries(): Observable<readonly ApiDelivery[]> {
    return this.http
      .get<{ entregas: ApiDelivery[] }>('/api/admin/entregas')
      .pipe(map((res) => res.entregas), catchError(handleError));
  }

  /**
   * Reemplaza las líneas de un pedido por la lista completa que se le pasa.
   * El Worker calcula el diff contra lo guardado: aquí no hace falta decir
   * qué se añadió, quitó o cambió, solo cómo debe quedar el pedido al final.
   */
  updateOrderItems(
    id: string,
    items: readonly { productId: string; cantidad: number }[],
  ): Observable<ApiOrder> {
    return this.http
      .patch<{ order: ApiOrder }>(`/api/admin/orders/${id}/items`, { items })
      .pipe(map((res) => res.order), catchError(handleError));
  }

  /** Traza de estados del pedido, para soporte postventa por WhatsApp. */
  orderHistory(id: string): Observable<readonly ApiOrderStatusLogEntry[]> {
    return this.http
      .get<{ history: ApiOrderStatusLogEntry[] }>(`/api/admin/orders/${id}/historial`)
      .pipe(map((res) => res.history), catchError(handleError));
  }

  /**
   * Imagen del comprobante, desde Workers KV.
   *
   * Llega como `Blob` y no como URL porque el endpoint exige el JWT: un
   * `<img src="/api/...">` no pasa por el interceptor y respondería 401. El
   * componente convierte este blob en una object URL para pintarlo.
   */
  orderReceipt(id: string): Observable<Blob> {
    return this.http
      .get(`/api/admin/orders/${id}/comprobante`, { responseType: 'blob' })
      .pipe(catchError(handleBlobError));
  }

  // ─────────────────────────────── Reportes ───────────────────────────────

  salesReport(): Observable<{
    products: readonly ApiSalesRow[];
    totals: { unidades: number; ingresos: number; costo: number; ganancia: number };
  }> {
    return this.http
      .get<{
        products: ApiSalesRow[];
        totals: { unidades: number; ingresos: number; costo: number; ganancia: number };
      }>('/api/admin/reports/sales')
      .pipe(catchError(handleError));
  }

  // ─────────────────────────── Tarifas de mayorista ───────────────────────────

  /** Catálogo completo con el descuento de ese nivel donde lo haya. */
  wholesaleTariff(role: WholesaleRole): Observable<ApiWholesaleTariff> {
    return this.http
      .get<ApiWholesaleTariff>(`/api/admin/wholesale/${role}`)
      .pipe(catchError(handleError));
  }

  /** Fija el descuento de un producto. `0` retira la tarifa. */
  setWholesaleDiscount(
    role: WholesaleRole,
    productId: string,
    porcentaje: number,
  ): Observable<{
    productId: string;
    role: WholesaleRole;
    porcentaje: number | null;
    precioMayorista: number;
    bajoCosto: boolean;
  }> {
    return this.http
      .put<{
        productId: string;
        role: WholesaleRole;
        porcentaje: number | null;
        precioMayorista: number;
        bajoCosto: boolean;
      }>(`/api/admin/wholesale/${role}/${productId}`, { porcentaje })
      .pipe(catchError(handleError));
  }

  /** Mismo descuento a varios productos, en una sola transacción. */
  setWholesaleBulk(
    role: WholesaleRole,
    productIds: readonly string[],
    porcentaje: number,
  ): Observable<{ role: WholesaleRole; porcentaje: number | null; aplicados: number }> {
    return this.http
      .put<{ role: WholesaleRole; porcentaje: number | null; aplicados: number }>(
        `/api/admin/wholesale/${role}`,
        { productIds, porcentaje },
      )
      .pipe(catchError(handleError));
  }

  /**
   * Consolidado semanal. Sin fechas trae la jornada abierta —lo que se cosecha
   * para el próximo domingo—; con ellas, el rango pedido.
   */
  consolidation(range: { desde?: string; hasta?: string } = {}): Observable<ApiConsolidation> {
    const query = new URLSearchParams();
    if (range.desde) query.set('desde', range.desde);
    if (range.hasta) query.set('hasta', range.hasta);
    const suffix = query.toString() ? `?${query.toString()}` : '';

    return this.http
      .get<ApiConsolidation>(`/api/admin/reports/consolidation${suffix}`)
      .pipe(catchError(handleError));
  }

  /**
   * `canal` elige qué caja se resume: la tienda web o el mostrador.
   *
   * Se omite por defecto para que las pantallas de siempre sigan pidiendo lo
   * mismo que pedían — el Worker interpreta la ausencia como 'ecommerce'.
   */
  cashSummary(canal?: PosCanal): Observable<ApiCashSummary> {
    const query = canal ? `?canal=${canal}` : '';
    return this.http
      .get<ApiCashSummary>(`/api/admin/reports/cash${query}`)
      .pipe(catchError(handleError));
  }

  closeCash(canal?: PosCanal): Observable<{ closing: ApiClosing; pedidosArchivados: number }> {
    const query = canal ? `?canal=${canal}` : '';
    return this.http
      .post<{ closing: ApiClosing; pedidosArchivados: number }>(
        `/api/admin/reports/cash/close${query}`,
        {},
      )
      .pipe(catchError(handleError));
  }

  // ────────────────────────── Punto de venta (0032) ──────────────────────────

  /**
   * Cierra una venta de mostrador: pedido, factura y cobro en una sola llamada.
   *
   * El navegador manda **qué y cuánto**, y el precio solo cuando el cajero lo
   * cambia a mano. Todo lo demás —el precio de lista, el descuento de mayorista
   * que le toque a la ficha, el total— lo calcula el Worker: aquí no se decide
   * cuánto se cobra, igual que en el checkout de la tienda.
   */
  posSell(input: ApiPosSellInput): Observable<ApiPosVenta> {
    return this.http
      .post<{ venta: ApiPosVenta }>('/api/admin/pos/sell', input)
      .pipe(map((res) => res.venta), catchError(handleError));
  }

  /** El historial de la caja, con las líneas de cada venta. */
  posVentas(opciones: { hoy?: boolean; limit?: number } = {}): Observable<{
    ventas: readonly ApiPosVentaResumen[];
    resumen: { cantidad: number; total: number };
  }> {
    const params = new URLSearchParams();
    if (opciones.hoy) {
      params.set('hoy', '1');
    }
    if (opciones.limit) {
      params.set('limit', String(opciones.limit));
    }
    const query = params.toString();

    return this.http
      .get<{ ventas: ApiPosVentaResumen[]; resumen: { cantidad: number; total: number } }>(
        `/api/admin/pos/ventas${query ? `?${query}` : ''}`,
      )
      .pipe(catchError(handleError));
  }

  /**
   * Devuelve mercancía de una venta de mostrador.
   *
   * Emite la nota crédito y devuelve el stock en la misma transacción del
   * Worker: el dinero y el inventario se mueven juntos o no se mueve ninguno.
   */
  posDevolucion(
    orderId: string,
    input: { items: readonly { productId: string; cantidad: number }[]; motivo: string },
  ): Observable<{ nota: ApiInvoice; venta: ApiPosVenta; unidadesDevueltas: number }> {
    return this.http
      .post<{ nota: ApiInvoice; venta: ApiPosVenta; unidadesDevueltas: number }>(
        `/api/admin/pos/${orderId}/devolucion`,
        input,
      )
      .pipe(catchError(handleError));
  }

  /**
   * Busca un cliente por cédula, nombre o teléfono, todo en la misma consulta.
   *
   * Es lo que usa el buscador del mostrador: el cajero teclea lo que el cliente
   * le dicte, sin elegir antes en qué campo está buscando.
   */
  searchContacts(query: string): Observable<readonly ApiContactMatch[]> {
    return this.http
      .get<{ contactos: ApiContactMatch[] }>(
        `/api/admin/contacts/search?query=${encodeURIComponent(query)}`,
      )
      .pipe(map((res) => res.contactos), catchError(handleError));
  }

  /** Banderas de operación que un SUPER_ADMIN cambia sin desplegar. */
  settings(): Observable<readonly ApiAjuste[]> {
    return this.http
      .get<{ ajustes: ApiAjuste[] }>('/api/admin/settings')
      .pipe(map((res) => res.ajustes), catchError(handleError));
  }

  updateSetting(clave: string, valor: string): Observable<{ clave: string; valor: string }> {
    return this.http
      .put<{ clave: string; valor: string }>('/api/admin/settings', { clave, valor })
      .pipe(catchError(handleError));
  }

  /** Las dos cajas sumadas, para cuadrar el día completo. */
  cashConsolidado(rango: { desde?: string; hasta?: string } = {}): Observable<ApiCashConsolidado> {
    const params = new URLSearchParams();
    if (rango.desde) {
      params.set('desde', rango.desde);
    }
    if (rango.hasta) {
      params.set('hasta', rango.hasta);
    }
    const query = params.toString();

    return this.http
      .get<ApiCashConsolidado>(`/api/admin/reports/cash/consolidado${query ? `?${query}` : ''}`)
      .pipe(catchError(handleError));
  }

  closings(): Observable<readonly ApiClosing[]> {
    return this.http
      .get<{ closings: ApiClosing[] }>('/api/admin/reports/closings')
      .pipe(map((res) => res.closings), catchError(handleError));
  }

  /**
   * Pedidos que componen un cierre pasado.
   *
   * Sale de `orders.closing_id`, la FK que el propio cierre puso al archivar.
   * No hay copia de la lista en ningún otro sitio: la relación se consulta,
   * no se duplica.
   */
  closingOrders(id: string): Observable<readonly ApiClosingOrder[]> {
    return this.http
      .get<{ orders: ApiClosingOrder[] }>(`/api/admin/reports/closings/${id}/pedidos`)
      .pipe(map((res) => res.orders), catchError(handleError));
  }

  /** Lo que los mayoristas deben, con su antigüedad ya calculada por el Worker. */
  // ──────────────────────────── Facturación (0027) ────────────────────────────

  /** Las facturas y sus totales. Sin método de creación: nacen al aprobar. */
  invoices(filtros: { estado?: string; contactId?: string } = {}): Observable<{
    invoices: readonly ApiInvoice[];
    resumen: ApiInvoiceSummary;
  }> {
    const params = new URLSearchParams();
    if (filtros.estado) {
      params.set('estado', filtros.estado);
    }
    if (filtros.contactId) {
      params.set('contactId', filtros.contactId);
    }
    const query = params.toString();

    return this.http
      .get<{ invoices: ApiInvoice[]; resumen: ApiInvoiceSummary }>(
        `/api/admin/invoices${query ? `?${query}` : ''}`,
      )
      .pipe(catchError(handleError));
  }

  /** La factura con sus líneas. */
  invoice(id: string): Observable<{ invoice: ApiInvoice; items: readonly ApiInvoiceItem[] }> {
    return this.http
      .get<{ invoice: ApiInvoice; items: ApiInvoiceItem[] }>(`/api/admin/invoices/${id}`)
      .pipe(catchError(handleError));
  }

  /** Factura a mano, sin pedido detrás. No mueve inventario. */
  createInvoice(input: ApiInvoiceInput): Observable<ApiInvoice> {
    return this.http
      .post<{ invoice: ApiInvoice }>('/api/admin/invoices', input)
      .pipe(map((res) => res.invoice), catchError(handleError));
  }

  /** Reescribe la factura entera. Solo mientras no tenga dinero encima. */
  updateInvoice(id: string, input: ApiInvoiceInput): Observable<ApiInvoice> {
    return this.http
      .put<{ invoice: ApiInvoice }>(`/api/admin/invoices/${id}`, input)
      .pipe(map((res) => res.invoice), catchError(handleError));
  }

  /** Borrado real. Solo mientras no tenga dinero encima. */
  deleteInvoice(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/invoices/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  /**
   * Emite una nota crédito o débito sobre una factura.
   *
   * Devuelve la nota y la factura ya recalculada: el saldo cambia en el mismo
   * batch, así que la pantalla puede pintar las dos sin volver a preguntar.
   */
  crearNota(
    invoiceId: string,
    input: ApiNotaInput,
  ): Observable<{ nota: ApiInvoice; invoice: ApiInvoice }> {
    return this.http
      .post<{ nota: ApiInvoice; invoice: ApiInvoice }>(
        `/api/admin/invoices/${invoiceId}/nota`,
        input,
      )
      .pipe(catchError(handleError));
  }

  /** Anular: el camino para algo que ya salió al cliente. Exige motivo. */
  anularInvoice(id: string, motivo: string): Observable<ApiInvoice> {
    return this.http
      .post<{ invoice: ApiInvoice }>(`/api/admin/invoices/${id}/anular`, { motivo })
      .pipe(map((res) => res.invoice), catchError(handleError));
  }

  // ───────────────────────────── Reparto (0029) ─────────────────────────────

  /** Las cuentas que pueden repartir. Solo id y nombre. */
  couriers(): Observable<readonly { id: string; nombre: string }[]> {
    return this.http
      .get<{ couriers: { id: string; nombre: string }[] }>('/api/admin/couriers')
      .pipe(map((res) => res.couriers), catchError(handleError));
  }

  /** Asigna, reasigna o suelta (con `null`) el domiciliario de un pedido. */
  assignCourier(orderId: string, domiciliarioId: string | null): Observable<ApiOrder> {
    return this.http
      .post<{ order: ApiOrder }>(`/api/admin/orders/${orderId}/domiciliario`, { domiciliarioId })
      .pipe(map((res) => res.order), catchError(handleError));
  }

  // ────────────────────────────── Cartera (0028) ──────────────────────────────

  payments(contactId?: string): Observable<{
    payments: readonly ApiPayment[];
    resumen: ApiPaymentSummary;
  }> {
    const query = contactId ? `?contactId=${encodeURIComponent(contactId)}` : '';
    return this.http
      .get<{ payments: ApiPayment[]; resumen: ApiPaymentSummary }>(`/api/admin/payments${query}`)
      .pipe(catchError(handleError));
  }

  /** Lo que un cliente debe hoy, para armar el reparto de un abono. */
  deudasDe(contactId: string): Observable<readonly ApiDeuda[]> {
    return this.http
      .get<{ deudas: ApiDeuda[] }>(
        `/api/admin/payments/deudas?contactId=${encodeURIComponent(contactId)}`,
      )
      .pipe(map((res) => res.deudas), catchError(handleError));
  }

  /** Todos los clientes con algo pendiente, con el detalle de cada factura. */
  deudores(): Observable<readonly ApiDeuda[]> {
    return this.http
      .get<{ deudas: ApiDeuda[] }>('/api/admin/payments/deudores')
      .pipe(map((res) => res.deudas), catchError(handleError));
  }

  paymentDetail(id: string): Observable<{
    payment: ApiPayment;
    allocations: readonly ApiAllocation[];
  }> {
    return this.http
      .get<{ payment: ApiPayment; allocations: ApiAllocation[] }>(`/api/admin/payments/${id}`)
      .pipe(catchError(handleError));
  }

  /** Registrar un cobro. Devuelve también cuánto quedó como anticipo. */
  createPayment(input: ApiPaymentInput): Observable<{ payment: ApiPayment; anticipo: number }> {
    return this.http
      .post<{ payment: ApiPayment; anticipo: number }>('/api/admin/payments', input)
      .pipe(catchError(handleError));
  }

  updatePayment(
    id: string,
    input: Omit<ApiPaymentInput, 'contactId'>,
  ): Observable<{ payment: ApiPayment; anticipo: number }> {
    return this.http
      .put<{ payment: ApiPayment; anticipo: number }>(`/api/admin/payments/${id}`, input)
      .pipe(catchError(handleError));
  }

  deletePayment(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/payments/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  cartera(): Observable<readonly ApiCarteraRow[]> {
    return this.http
      .get<{ deudores: ApiCarteraRow[] }>('/api/admin/reports/cartera')
      .pipe(map((res) => res.deudores), catchError(handleError));
  }

  /** Todo el efectivo cobrado que aún no se confirma que llegó a la finca. */
  efectivoPendiente(): Observable<readonly ApiEfectivoPendiente[]> {
    return this.http
      .get<{ pendientes: ApiEfectivoPendiente[] }>('/api/admin/reports/efectivo-pendiente')
      .pipe(map((res) => res.pendientes), catchError(handleError));
  }

  /** Libera un abono suelto (sin pedido contra entrega detrás). */
  liquidarPago(id: string): Observable<void> {
    return this.http
      .post<{ payment: unknown }>(`/api/admin/payments/${id}/liquidar`, {})
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ──────────────── Gastos operativos y pago a las fincas ────────────────

  /**
   * Gastos de un cierre, o los de la jornada abierta si no se pasa `closingId`.
   *
   * Sin cierre son los que todavía se pueden borrar y los que entrarán al
   * próximo; con cierre, los ya archivados, para auditar su `totalGastos`.
   */
  expenses(closingId?: string): Observable<readonly ApiExpense[]> {
    const query = closingId ? `?closing_id=${encodeURIComponent(closingId)}` : '';
    return this.http
      .get<{ gastos: ApiExpense[] }>(`/api/admin/expenses${query}`)
      .pipe(map((res) => res.gastos), catchError(handleError));
  }

  createExpense(gasto: {
    descripcion: string;
    monto: number;
    categoria: ExpenseCategory;
  }): Observable<ApiExpense> {
    return this.http
      .post<{ gasto: ApiExpense }>('/api/admin/expenses', gasto)
      .pipe(map((res) => res.gasto), catchError(handleError));
  }

  /** Solo funciona mientras el gasto siga sin cierre. El Worker manda. */
  deleteExpense(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/expenses/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ───────────── Bajas de inventario por merma ─────────────

  /** `abiertas` deja solo las actas que todavía puede deshacer la jornada. */
  mermas(abiertas = false): Observable<readonly ApiMerma[]> {
    return this.http
      .get<{ mermas: ApiMerma[] }>(`/api/admin/mermas${abiertas ? '?abiertas=1' : ''}`)
      .pipe(map((res) => res.mermas), catchError(handleError));
  }

  /**
   * Registra el acta y baja el inventario en el mismo paso.
   *
   * No se manda el costo: lo pone el servidor leyendo el catálogo. Es la
   * justificación contable de una pérdida, y dejar que el navegador diga
   * cuánto valía sería dejarle decidir cuánta ganancia se resta del cierre.
   */
  createMerma(input: {
    observaciones?: string;
    items: readonly {
      productId: string;
      cantidad: number;
      motivo: MotivoMerma;
      observacion?: string;
    }[];
  }): Observable<ApiMerma> {
    return this.http
      .post<{ merma: ApiMerma }>('/api/admin/mermas', input)
      .pipe(map((res) => res.merma), catchError(handleError));
  }

  /** Solo mientras la jornada siga abierta; después el Worker responde 409. */
  deleteMerma(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/mermas/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  mermaReporte(rango: { desde?: string; hasta?: string } = {}): Observable<ApiMermaReporte> {
    const params = new URLSearchParams();
    if (rango.desde) params.set('desde', rango.desde);
    if (rango.hasta) params.set('hasta', rango.hasta);
    const query = params.toString();

    return this.http
      .get<ApiMermaReporte>(`/api/admin/mermas/reporte${query ? `?${query}` : ''}`)
      .pipe(catchError(handleError));
  }

  // ───────────── Agenda: proveedores y clientes ─────────────

  /**
   * La agenda. `tipo` filtra por bandera; sin él vienen todos.
   *
   * Cada ficha trae su resumen de historial calculado por el servidor: cuántas
   * compras y pedidos, por cuánto, y qué se le debe.
   */
  contacts(options?: {
    tipo?: 'proveedor' | 'cliente';
    incluirInactivos?: boolean;
  }): Observable<readonly ApiContact[]> {
    const params = new URLSearchParams();
    if (options?.tipo) {
      params.set('tipo', options.tipo);
    }
    if (options?.incluirInactivos) {
      params.set('inactivos', '1');
    }
    const query = params.toString() ? `?${params}` : '';

    return this.http
      .get<{ contactos: ApiContact[] }>(`/api/admin/contacts${query}`)
      .pipe(map((res) => res.contactos), catchError(handleError));
  }

  createContact(contacto: ContactInput): Observable<ApiContact> {
    return this.http
      .post<{ contacto: ApiContact }>('/api/admin/contacts', contacto)
      .pipe(map((res) => res.contacto), catchError(handleError));
  }

  updateContact(id: string, contacto: ContactInput): Observable<ApiContact> {
    return this.http
      .patch<{ contacto: ApiContact }>(`/api/admin/contacts/${id}`, contacto)
      .pipe(map((res) => res.contacto), catchError(handleError));
  }

  /** Solo funciona sin historial detrás; si lo hay, el servidor responde 409. */
  deleteContact(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/contacts/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  // ─────────────────────── Compras a las fincas ───────────────────────

  /** Historial de compras, con su detalle dentro. Filtros opcionales. */
  purchases(options?: {
    origen?: string;
    estado?: 'pendiente' | 'pagado';
  }): Observable<readonly ApiPurchase[]> {
    const params = new URLSearchParams();
    if (options?.origen) {
      params.set('origen', options.origen);
    }
    if (options?.estado) {
      params.set('estado', options.estado);
    }
    const query = params.toString() ? `?${params}` : '';

    return this.http
      .get<{ compras: ApiPurchase[] }>(`/api/admin/providers/purchases${query}`)
      .pipe(map((res) => res.compras), catchError(handleError));
  }

  /** Registra la compra: sube el inventario y fija el costo del catálogo. */
  createPurchase(compra: PurchaseInput): Observable<ApiPurchase> {
    return this.http
      .post<{ compra: ApiPurchase }>('/api/admin/providers/purchases', compra)
      .pipe(map((res) => res.compra), catchError(handleError));
  }

  /**
   * Corrige una compra. El servidor devuelve al inventario lo anterior y suma
   * lo nuevo; si lo anterior ya se vendió, responde `stock-ya-vendido`.
   */
  updatePurchase(id: string, compra: PurchaseInput): Observable<ApiPurchase> {
    return this.http
      .patch<{ compra: ApiPurchase }>(`/api/admin/providers/purchases/${id}`, compra)
      .pipe(map((res) => res.compra), catchError(handleError));
  }

  /** Borra la compra y devuelve su mercancía al inventario. */
  deletePurchase(id: string): Observable<void> {
    return this.http
      .delete<{ ok: true }>(`/api/admin/providers/purchases/${id}`)
      .pipe(map(() => undefined), catchError(handleError));
  }

  /** Se le giró al agricultor. Solo cambia el estado: el stock ya entró. */
  markPurchasePaid(id: string): Observable<ApiPurchase> {
    return this.http
      .post<{ compra: ApiPurchase }>(`/api/admin/providers/purchases/${id}/pagar`, {})
      .pipe(map((res) => res.compra), catchError(handleError));
  }
}

/**
 * Normaliza el error para que los componentes reciban siempre un `ApiErrorBody`
 * y puedan discriminar por `code` (por ejemplo `stock-insuficiente`) en vez de
 * comparar textos, que cambian con cualquier retoque de copy.
 */
function handleError(response: HttpErrorResponse): Observable<never> {
  const body = response.error as { error?: ApiErrorBody } | null;

  if (body?.error?.code) {
    return throwError(() => body.error as ApiErrorBody);
  }

  // Error de red, o el servidor devolvió algo que no es nuestro JSON.
  return throwError(() => ({
    code: response.status === 0 ? 'sin-conexion' : 'error-desconocido',
    message:
      response.status === 0
        ? 'No se pudo contactar el servidor. Revisa tu conexión.'
        : `El servidor respondió ${response.status}.`,
  } satisfies ApiErrorBody));
}

/**
 * Variante para las respuestas `responseType: 'blob'`.
 *
 * Cuando la petición pide un blob, Angular entrega también el **cuerpo del
 * error** como blob, así que el `{ error: { code } }` del Worker no se puede
 * leer de forma síncrona. Se traduce por código de estado, que para este
 * endpoint alcanza: lo único que el panel necesita distinguir es "no hay
 * comprobante" de "no hay permiso" o "se cayó la conexión".
 */
function handleBlobError(response: HttpErrorResponse): Observable<never> {
  const byStatus: Record<number, ApiErrorBody> = {
    0: { code: 'sin-conexion', message: 'No se pudo contactar el servidor.' },
    401: { code: 'sesion-expirada', message: 'Tu sesión expiró. Vuelve a entrar.' },
    403: { code: 'sin-permiso', message: 'No tienes permiso para ver este comprobante.' },
    404: { code: 'sin-comprobante', message: 'Este pedido no tiene comprobante adjunto.' },
  };

  return throwError(
    () =>
      byStatus[response.status] ?? {
        code: 'error-desconocido',
        message: `El servidor respondió ${response.status}.`,
      },
  );
}
