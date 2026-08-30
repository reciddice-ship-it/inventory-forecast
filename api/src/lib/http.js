/** Tiny HTTP helpers: JSON responses, CORS, auth, and a regex router. */

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export function error(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes('*')
    ? '*'
    : (allowed.includes(origin) ? origin : allowed[0] || '');
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

/**
 * Bearer-token auth. Constant-time-ish comparison so the token can't be
 * probed a character at a time.
 */
export function authorize(request, env) {
  const expected = env.API_TOKEN;
  if (!expected) return { ok: false, reason: 'API_TOKEN is not configured on the Worker' };
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const supplied = m ? m[1] : new URL(request.url).searchParams.get('token') || '';
  if (!supplied) return { ok: false, reason: 'missing bearer token' };
  if (supplied.length !== expected.length) return { ok: false, reason: 'invalid token' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: 'invalid token' };
}

/** Minimal router: register(method, '/api/products/:id', handler). */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const names = [];
    const regex = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_, n) => {
      names.push(n); return '/([^/]+)';
    }) + '/?$');
    this.routes.push({ method, regex, names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    let methodMatched = false;
    for (const r of this.routes) {
      const m = url.pathname.match(r.regex);
      if (!m) continue;
      methodMatched = true;
      if (r.method !== request.method) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return r.handler({ request, env, ctx, params, url });
    }
    return error(methodMatched ? 'Method not allowed' : 'Not found', methodMatched ? 405 : 404);
  }
}

export async function readJSON(request) {
  try { return await request.json(); }
  catch { throw new HttpError('Request body must be valid JSON', 400); }
}

export class HttpError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
