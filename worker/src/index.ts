import { ApiError, errorResponse, json } from './http';
import { Env } from './types';
import { requireAuth } from './auth/middleware';
import * as auth from './routes/auth';
import * as products from './routes/products';
import * as orders from './routes/orders';
import * as reports from './routes/reports';

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

  if (pathname === '/api/auth/login' && method === 'POST') {
    return auth.login(request, env);
  }

  if (pathname === '/api/products' && method === 'GET') {
    return products.listPublic(env, url);
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

  if (pathname.startsWith('/api/admin/')) {
    const user = await requireAuth(request, env);

    // Inventario
    if (pathname === '/api/admin/products' && method === 'GET') {
      return products.listAdmin(env, user);
    }
    if (pathname === '/api/admin/products/alerts' && method === 'GET') {
      return products.listAlerts(env, user);
    }
    if (pathname === '/api/admin/products/recalcular-abc' && method === 'POST') {
      return products.recalcAbc(env, user);
    }

    const productMatch = pathname.match(/^\/api\/admin\/products\/([\w-]+)$/);
    if (productMatch && method === 'PATCH') {
      return products.update(request, env, user, productMatch[1]);
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
    if (pathname === '/api/admin/reports/closings' && method === 'GET') {
      return reports.closings(env, user);
    }
  }

  throw ApiError.notFound(`No existe ${method} ${pathname}.`);
}
