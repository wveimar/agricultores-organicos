import { ApiError, errorResponse, json } from './http';
import { Env } from './types';
import { requireAuth } from './auth/middleware';
import * as auth from './routes/auth';
import * as products from './routes/products';
import * as categories from './routes/categories';
import * as adminGroups from './routes/admin-groups';
import * as orders from './routes/orders';
import * as reports from './routes/reports';
import * as expenses from './routes/expenses';
import * as purchases from './routes/purchases';
import * as contacts from './routes/contacts';
import * as users from './routes/users';
import * as wholesale from './routes/wholesale';
import * as components from './routes/components';
import * as passwordReset from './routes/password-reset';

/**
 * Punto de entrada del Worker.
 *
 * Solo atiende `/api/*`. El resto lo sirve el router de assets estáticos de
 * Cloudflare directamente (ver `run_worker_first` en wrangler.jsonc), así que
 * la tienda de Angular no paga ni un milisegundo de JavaScript de servidor.
 *
 * El enrutado es un `switch` sobre método + ruta en vez de un framework: en el
 * edge, cada kilobyte de bundle es tiempo de arranque en frío.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Defensa por si la configuración de assets cambia: nunca devolver 404
      // del Worker para una ruta del SPA.
      return env.ASSETS.fetch(request);
    }

    try {
      return await route(request, env, url);
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  // ─────────────────────────────── Público ───────────────────────────────

  if (pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, ts: new Date().toISOString() });
  }

  /**
   * Configuración pública del cliente.
   *
   * La sitekey de Turnstile es pública por diseño (va en el HTML del widget),
   * pero servirla desde aquí evita tener que recompilar el frontend para
   * activarla: se pone como `var` en wrangler.jsonc y el navegador la recoge.
   * La clave **secreta** nunca pasa por esta ruta.
   */
  if (pathname === '/api/config' && method === 'GET') {
    return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '' });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    return auth.login(request, env);
  }

  // Recuperación de contraseña. Es pública por necesidad: quien la usa es
  // justamente alguien que no puede iniciar sesión. La protegen el límite por
  // IP, el token de un solo uso y su caducidad — no una sesión.
  if (pathname === '/api/auth/recuperar' && method === 'POST') {
    return passwordReset.requestReset(request, env);
  }
  if (pathname === '/api/auth/restablecer' && method === 'POST') {
    return passwordReset.performReset(request, env);
  }

  // Lleva `request` porque la sesión es opcional: quien entra como mayorista
  // recibe su precio ya con descuento; el resto, el de lista.
  if (pathname === '/api/products' && method === 'GET') {
    return products.listPublic(request, env, url);
  }

  // Los chips de la vitrina. Sin sesión: es la estructura del catálogo, la
  // misma para todo el mundo — los precios son lo que cambia según quién mire.
  if (pathname === '/api/categories' && method === 'GET') {
    return categories.listPublic(env);
  }

  // Las solapas de la vitrina. Sin sesión, por lo mismo que las categorías:
  // los grupos son la estantería, no el precio.
  if (pathname === '/api/groups' && method === 'GET') {
    return adminGroups.listPublic(env);
  }

  if (pathname === '/api/orders' && method === 'POST') {
    return orders.create(request, env);
  }

  // ───────────────────────── A partir de aquí, con sesión ─────────────────────────
  // La verificación del JWT es criptográfica y no consulta D1, así que las
  // rutas protegidas no pagan un viaje extra a la base solo para autenticar.

  if (pathname.startsWith('/api/auth/me') && method === 'GET') {
    return auth.me(await requireAuth(request, env));
  }

  // Cambiar la contraseña propia no pide rol: cualquiera con sesión puede
  // hacerlo sobre su cuenta, y solo sobre la suya.
  if (pathname === '/api/auth/password' && method === 'POST') {
    return users.changeOwnPassword(request, env, await requireAuth(request, env));
  }

  if (pathname.startsWith('/api/admin/')) {
    const user = await requireAuth(request, env);

    // Inventario
    if (pathname === '/api/admin/products' && method === 'GET') {
      return products.listAdmin(env, user);
    }
    if (pathname === '/api/admin/products' && method === 'POST') {
      return products.create(request, env, user);
    }
    if (pathname === '/api/admin/products/alerts' && method === 'GET') {
      return products.listAlerts(env, user);
    }
    if (pathname === '/api/admin/products/recalcular-abc' && method === 'POST') {
      return products.recalcAbc(env, user);
    }

    const duplicateMatch = pathname.match(/^\/api\/admin\/products\/([\w-]+)\/duplicar$/);
    if (duplicateMatch && method === 'POST') {
      return products.duplicate(env, user, duplicateMatch[1]);
    }

    // Receta de una canasta: qué productos la llenan y cuántos de cada uno.
    const recipeMatch = pathname.match(/^\/api\/admin\/products\/([\w-]+)\/componentes$/);
    if (recipeMatch && method === 'GET') {
      return components.get(env, user, recipeMatch[1]);
    }
    if (recipeMatch && method === 'PUT') {
      return components.put(request, env, user, recipeMatch[1]);
    }

    const componentMatch = pathname.match(
      /^\/api\/admin\/products\/([\w-]+)\/componentes\/([\w-]+)$/,
    );
    if (componentMatch && method === 'DELETE') {
      return components.remove(env, user, componentMatch[1], componentMatch[2]);
    }

    const productMatch = pathname.match(/^\/api\/admin\/products\/([\w-]+)$/);
    if (productMatch && method === 'PATCH') {
      return products.update(request, env, user, productMatch[1]);
    }
    if (productMatch && method === 'PUT') {
      return products.updateFull(request, env, user, productMatch[1]);
    }

    // Categorías del catálogo
    if (pathname === '/api/admin/categories' && method === 'GET') {
      return categories.listAdmin(env, user);
    }
    if (pathname === '/api/admin/categories' && method === 'POST') {
      return categories.create(request, env, user);
    }

    const categoryMatch = pathname.match(/^\/api\/admin\/categories\/([\w-]+)$/);
    if (categoryMatch && method === 'PUT') {
      return categories.update(request, env, user, categoryMatch[1]);
    }
    if (categoryMatch && method === 'DELETE') {
      return categories.remove(env, user, categoryMatch[1]);
    }

    // Grupos del panel de compras (migración 0025)
    if (pathname === '/api/admin/admin-groups' && method === 'GET') {
      return adminGroups.listAdmin(env, user);
    }
    if (pathname === '/api/admin/admin-groups' && method === 'POST') {
      return adminGroups.create(request, env, user);
    }

    const groupMatch = pathname.match(/^\/api\/admin\/admin-groups\/([\w-]+)$/);
    if (groupMatch && method === 'PUT') {
      return adminGroups.update(request, env, user, groupMatch[1]);
    }
    if (groupMatch && method === 'DELETE') {
      return adminGroups.remove(env, user, groupMatch[1]);
    }

    // Pedidos
    if (pathname === '/api/admin/orders' && method === 'GET') {
      return orders.list(env, user, url);
    }

    const approveMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/aprobar$/);
    if (approveMatch && method === 'POST') {
      return orders.approve(env, user, approveMatch[1]);
    }

    const shipMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/enviar$/);
    if (shipMatch && method === 'POST') {
      return orders.ship(env, user, shipMatch[1]);
    }

    const cancelMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/cancelar$/);
    if (cancelMatch && method === 'POST') {
      return orders.cancel(request, env, user, cancelMatch[1]);
    }

    if (pathname === '/api/admin/entregas' && method === 'GET') {
      return orders.deliveries(env, user);
    }

    const payMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/pagar$/);
    if (payMatch && method === 'POST') {
      return orders.markPaid(env, user, payMatch[1]);
    }

    // Equivalente de /pagar para lo que no es contra entrega: no hay nada que
    // cobrar, solo confirmar que el domiciliario tocó la puerta.
    const deliverMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/entregar$/);
    if (deliverMatch && method === 'POST') {
      return orders.confirmDelivery(env, user, deliverMatch[1]);
    }

    // Aparte de /pagar: solo GESTOR_PEDIDOS, y desde 'aprobado' o 'enviado'.
    // El porqué, en collectCredit().
    const grantMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/credito$/);
    if (grantMatch && method === 'POST') {
      return orders.grantCredit(env, user, grantMatch[1]);
    }

    const collectMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/recaudar$/);
    if (collectMatch && method === 'POST') {
      return orders.collectCredit(env, user, collectMatch[1]);
    }

    const settleMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/liquidar$/);
    if (settleMatch && method === 'POST') {
      return orders.settleCash(env, user, settleMatch[1]);
    }

    const rejectMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/rechazar-entrega$/);
    if (rejectMatch && method === 'POST') {
      return orders.rejectDelivery(request, env, user, rejectMatch[1]);
    }

    const orderMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)$/);
    if (orderMatch && method === 'DELETE') {
      return orders.remove(env, user, orderMatch[1]);
    }

    const itemsMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/items$/);
    if (itemsMatch && method === 'PATCH') {
      return orders.updateItems(request, env, user, itemsMatch[1]);
    }

    const historyMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/historial$/);
    if (historyMatch && method === 'GET') {
      return orders.history(env, user, historyMatch[1]);
    }

    // Imagen del comprobante de consignación. Va detrás del JWT como el resto
    // de /api/admin/*: lleva datos bancarios del cliente.
    const receiptMatch = pathname.match(/^\/api\/admin\/orders\/([\w-]+)\/comprobante$/);
    if (receiptMatch && method === 'GET') {
      return orders.receipt(env, user, receiptMatch[1]);
    }

    // Usuarios del panel
    if (pathname === '/api/admin/users' && method === 'GET') {
      return users.list(env, user);
    }
    if (pathname === '/api/admin/users' && method === 'POST') {
      return users.create(request, env, user);
    }

    const userMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
    if (userMatch && method === 'PATCH') {
      return users.update(request, env, user, userMatch[1]);
    }

    // Tarifas de mayorista
    const wholesaleListMatch = pathname.match(/^\/api\/admin\/wholesale\/([\w-]+)$/);
    if (wholesaleListMatch && method === 'GET') {
      return wholesale.list(env, user, wholesaleListMatch[1]);
    }
    if (wholesaleListMatch && method === 'PUT') {
      return wholesale.setBulk(request, env, user, wholesaleListMatch[1]);
    }

    const wholesaleItemMatch = pathname.match(/^\/api\/admin\/wholesale\/([\w-]+)\/([\w-]+)$/);
    if (wholesaleItemMatch && method === 'PUT') {
      return wholesale.set(request, env, user, wholesaleItemMatch[1], wholesaleItemMatch[2]);
    }

    // Reportes
    if (pathname === '/api/admin/reports/sales' && method === 'GET') {
      return reports.sales(env, user);
    }
    if (pathname === '/api/admin/reports/cash' && method === 'GET') {
      return reports.cashSummary(env, user);
    }
    if (pathname === '/api/admin/reports/cash/close' && method === 'POST') {
      return reports.closeCash(env, user);
    }
    if (pathname === '/api/admin/reports/cod-pendiente' && method === 'GET') {
      return reports.codPending(env, user);
    }
    if (pathname === '/api/admin/reports/cartera' && method === 'GET') {
      return reports.cartera(env, user);
    }
    if (pathname === '/api/admin/reports/closings' && method === 'GET') {
      return reports.closings(env, user);
    }

    // Gastos operativos. Entran en `ganancia` del cierre, así que van detrás
    // del mismo rol que cierra la caja — ver expenses.ts.
    if (pathname === '/api/admin/expenses' && method === 'GET') {
      return expenses.list(env, user, url);
    }
    if (pathname === '/api/admin/expenses' && method === 'POST') {
      return expenses.create(request, env, user);
    }

    const expenseMatch = pathname.match(/^\/api\/admin\/expenses\/([\w-]+)$/);
    if (expenseMatch && method === 'DELETE') {
      return expenses.remove(env, user, expenseMatch[1]);
    }

    // Agenda: proveedores y clientes en una sola lista, con banderas.
    if (pathname === '/api/admin/contacts' && method === 'GET') {
      return contacts.list(env, user, url);
    }
    if (pathname === '/api/admin/contacts' && method === 'POST') {
      return contacts.create(request, env, user);
    }

    const contactMatch = pathname.match(/^\/api\/admin\/contacts\/([\w-]+)$/);
    if (contactMatch && method === 'PATCH') {
      return contacts.update(request, env, user, contactMatch[1]);
    }
    if (contactMatch && method === 'DELETE') {
      return contacts.remove(env, user, contactMatch[1]);
    }

    // Compras a las fincas: registrarlas sube el inventario y fija el costo.
    // El pago al agricultor se confirma aparte, con /pagar.
    if (pathname === '/api/admin/providers/purchases' && method === 'GET') {
      return purchases.list(env, user, url);
    }
    if (pathname === '/api/admin/providers/purchases' && method === 'POST') {
      return purchases.create(request, env, user);
    }

    // El id va antes que /pagar en el mismo prefijo, así que el patrón de la
    // acción se prueba primero: si no, `([\w-]+)` se tragaría "…/pagar".
    const purchasePayMatch = pathname.match(
      /^\/api\/admin\/providers\/purchases\/([\w-]+)\/pagar$/,
    );
    if (purchasePayMatch && method === 'POST') {
      return purchases.markPaid(env, user, purchasePayMatch[1]);
    }

    const purchaseMatch = pathname.match(/^\/api\/admin\/providers\/purchases\/([\w-]+)$/);
    if (purchaseMatch && method === 'PATCH') {
      return purchases.update(request, env, user, purchaseMatch[1]);
    }
    if (purchaseMatch && method === 'DELETE') {
      return purchases.remove(env, user, purchaseMatch[1]);
    }
    // Consolidado semanal: qué cosechar y a quién se le lleva.
    if (pathname === '/api/admin/reports/consolidation' && method === 'GET') {
      return reports.consolidation(request, env, user);
    }

    // Detalle de un cierre pasado: qué pedidos lo componen.
    const closingOrdersMatch = pathname.match(
      /^\/api\/admin\/reports\/closings\/([\w-]+)\/pedidos$/,
    );
    if (closingOrdersMatch && method === 'GET') {
      return reports.closingOrders(env, user, closingOrdersMatch[1]);
    }
  }

  throw ApiError.notFound(`No existe ${method} ${pathname}.`);
}
