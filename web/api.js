/** Thin client for the Worker API. Credentials live in localStorage only. */

const LS_KEY = 'inventory-forecast.connection';

export const conn = {
  get() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { baseUrl: '', token: '' }; }
    catch { return { baseUrl: '', token: '' }; }
  },
  set(baseUrl, token) {
    localStorage.setItem(LS_KEY, JSON.stringify({ baseUrl: baseUrl.replace(/\/+$/, ''), token }));
  },
  clear() { localStorage.removeItem(LS_KEY); },
  get configured() { const c = this.get(); return Boolean(c.baseUrl && c.token); },
};

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function request(path, { method = 'GET', body, raw = false } = {}) {
  const { baseUrl, token } = conn.get();
  if (!baseUrl) throw new ApiError('No API URL configured — open Settings.', 0);

  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(
      `Could not reach ${baseUrl}. Check the URL, that the Worker is deployed, and that ALLOWED_ORIGINS includes ${location.origin}.`,
      0
    );
  }

  if (raw) {
    if (!res.ok) throw new ApiError(await res.text(), res.status);
    return res.text();
  }

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status, data);
  return data;
}

export const api = {
  health:        () => request('/api/health'),

  listProducts:  (includeInactive = false) => request(`/api/products${includeInactive ? '?include_inactive=1' : ''}`),
  createProduct: (p) => request('/api/products', { method: 'POST', body: p }),
  updateProduct: (id, p) => request(`/api/products/${id}`, { method: 'PATCH', body: p }),
  deleteProduct: (id, hard = false) => request(`/api/products/${id}${hard ? '?hard=1' : ''}`, { method: 'DELETE' }),

  listSales:     (params = {}) => request('/api/sales?' + new URLSearchParams(params)),
  weeklySales:   (params = {}) => request('/api/sales/weekly?' + new URLSearchParams(params)),
  addSales:      (rows) => request('/api/sales', { method: 'POST', body: rows }),
  deleteSale:    (id) => request(`/api/sales/${id}`, { method: 'DELETE' }),
  previewImport: (payload) => request('/api/sales/preview', { method: 'POST', body: payload }),
  commitImport:  (payload) => request('/api/sales/import', { method: 'POST', body: payload }),
  exportSales:   () => request('/api/export/sales.csv', { raw: true }),

  getSettings:   () => request('/api/settings'),
  putSettings:   (s) => request('/api/settings', { method: 'PUT', body: s }),

  forecast:      (params = {}) => request('/api/forecast?' + new URLSearchParams(params)),
  purchaseOrders:(params = {}) => request('/api/forecast/purchase-orders?' + new URLSearchParams(params)),
};
