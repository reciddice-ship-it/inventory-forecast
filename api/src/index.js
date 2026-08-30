/**
 * Cloudflare Worker entrypoint.
 *
 * Bindings expected (see wrangler.toml):
 *   DB              D1 database
 *   API_TOKEN       secret; every /api/* call must send it as a bearer token
 *   ALLOWED_ORIGINS comma-separated origin allowlist for CORS (or "*")
 */

import { Router, json, error, corsHeaders, authorize, HttpError } from './lib/http.js';
import * as products from './routes/products.js';
import * as sales from './routes/sales.js';
import * as forecast from './routes/forecast.js';

const router = new Router()
  .get('/api/health', async ({ env }) => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first();
    return json({ ok: true, products: row?.n ?? 0, time: new Date().toISOString() });
  })

  .get('/api/products', products.listProducts)
  .post('/api/products', products.createProduct)
  .get('/api/products/:id', products.getProduct)
  .patch('/api/products/:id', products.updateProduct)
  .delete('/api/products/:id', products.deleteProduct)

  .get('/api/sales', sales.listSales)
  .post('/api/sales', sales.createSales)
  .delete('/api/sales', sales.deleteSalesRange)
  .get('/api/sales/weekly', sales.weeklySales)
  .post('/api/sales/preview', sales.previewImport)
  .post('/api/sales/import', sales.commitImport)
  .delete('/api/sales/:id', sales.deleteSale)

  .get('/api/settings', forecast.getSettings)
  .put('/api/settings', forecast.putSettings)

  .get('/api/forecast', forecast.getForecast)
  .get('/api/forecast/purchase-orders', forecast.getPurchaseOrders)

  .get('/api/export/sales.csv', sales.exportSalesCSV);

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/api') {
      return withCors(json({
        name: 'inventory-forecast API',
        docs: 'https://github.com/reciddice-ship-it/inventory-forecast#api-reference',
        endpoints: router.routes.map((r) => `${r.method} ${r.regex.source}`),
      }), cors);
    }

    const auth = authorize(request, env);
    if (!auth.ok) {
      return withCors(error(`Unauthorized: ${auth.reason}`, 401), cors);
    }

    try {
      const res = await router.handle(request, env, ctx);
      return withCors(res, cors);
    } catch (err) {
      if (err instanceof HttpError) {
        return withCors(json({ error: err.message, ...err.extra }, err.status), cors);
      }
      console.error(err);
      return withCors(error(err?.message || 'Internal error', 500), cors);
    }
  },
};

function withCors(res, cors) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
