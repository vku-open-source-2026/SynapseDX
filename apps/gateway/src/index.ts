/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import yaml from 'js-yaml';
import client from 'prom-client';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT || process.env.GATEWAY_PORT || 8080);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IAM_SERVICE_URL = process.env.IAM_SERVICE_URL || 'http://iam:4001';

/** Fail fast on weak/default JWT secrets in production; warn loudly in dev. */
function jwtSecret(): string {
  const s = process.env.IAM_JWT_SECRET || '';
  const weak = !s || s.includes('change_me') || s.length < 32;
  if (weak) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[gateway] IAM_JWT_SECRET must be set to a random value ≥32 chars in production');
    }
    console.warn('[gateway][security] WARNING: IAM_JWT_SECRET is default/weak — dev only. Gateway and IAM must share the same strong secret.');
  }
  return s || 'change_me_super_secret_32chars_min';
}
const JWT_SECRET = jwtSecret();

/** Shared service-to-service credential (gateway → iam/workflow). Empty = dev mode (warn). */
const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
if (!INTERNAL_SECRET) {
  console.warn('[gateway][security] SYNAPSEDX_INTERNAL_SECRET not set — downstream services cannot tell gateway traffic apart (dev default). Set it in production.');
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpCounter = new client.Counter({
  name: 'gateway_requests_total',
  help: 'Total proxied requests',
  labelNames: ['route', 'status'],
  registers: [register],
});

export interface RouteRule {
  path: string;
  target: string;
  auth: 'none' | 'jwt' | 'apikey' | 'either';
}

export function expandEnv(s: string): string {
  return s.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '');
}

/** Longest-prefix match: /v1/orgs khớp /v1/orgs và /v1/orgs/..., không khớp /v1/organizations. */
export function findRoute(routes: RouteRule[], pathname: string): RouteRule | undefined {
  let best: RouteRule | undefined;
  for (const r of routes) {
    if (pathname === r.path || pathname.startsWith(r.path + '/')) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return best;
}

function loadRoutes(): RouteRule[] {
  const p = process.env.GATEWAY_ROUTES_PATH || './routes.yaml';
  const candidates = [p, './routes.yaml', '/app/routes.yaml', __dirname + '/../routes.yaml'];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const raw = expandEnv(fs.readFileSync(c, 'utf8'));
        const doc: any = yaml.load(raw);
        return (doc.routes || []) as RouteRule[];
      }
    } catch { /* try next */ }
  }
  // fallback defaults
  return [
    { path: '/v1/auth', target: IAM_SERVICE_URL, auth: 'none' },
    { path: '/v1/orgs', target: IAM_SERVICE_URL, auth: 'either' },
    { path: '/v1/workflows', target: process.env.WORKFLOW_SERVICE_URL || 'http://workflow:4002', auth: 'either' },
  ];
}

function authMiddleware(mode: RouteRule['auth']) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (mode === 'none') return next();
    const h = req.headers.authorization || '';
    const hasBearer = h.startsWith('Bearer ');
    const apiKey = (req.headers['x-api-key'] as string) || '';
    if (mode === 'jwt' || mode === 'either') {
      if (hasBearer) {
        const token = h.slice(7);
        try {
          const decoded: any = jwt.verify(token, JWT_SECRET, { issuer: 'synapsedx-iam' });
          (req as any).principal = { type: 'jwt', sub: decoded.sub, org: decoded.org, account: decoded.account, scopes: decoded.scopes || [] };
          return next();
        } catch (e) {
          if (mode === 'jwt') return res.status(401).json({ error: 'invalid_token', message: 'JWT invalid or expired' });
          // fallthrough to apikey check for 'either'
        }
      }
    }
    if (mode === 'apikey' || mode === 'either') {
      if (apiKey) {
        // Mặc định: edge check presence, upstream verify chi tiết.
        // GATEWAY_VERIFY_APIKEY=true: verify tập trung qua IAM (fail-closed khi IAM chết).
        if ((process.env.GATEWAY_VERIFY_APIKEY || 'false') === 'true') {
          verifyApiKeyUpstream(apiKey).then(
            (info) => {
              if (!info) return res.status(401).json({ error: 'invalid_api_key' });
              (req as any).principal = { type: 'apikey', account: info.account_id, scopes: info.scopes };
              return next();
            },
            () => res.status(503).json({ error: 'iam_unavailable' }),
          );
          return;
        }
        (req as any).principal = { type: 'apikey' };
        return next();
      }
      if (mode === 'apikey') return res.status(401).json({ error: 'missing_api_key', message: 'X-API-Key required' });
    }
    return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT and/or X-API-Key' });
  };
}

export async function verifyApiKeyUpstream(
  apiKey: string,
  iamBase?: string,
  internalSecret: string | undefined = INTERNAL_SECRET,
): Promise<{ account_id: string; scopes: string[] } | null> {
  const iam = (iamBase || process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${iam}/v1/keys/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // IAM requires this when SYNAPSEDX_INTERNAL_SECRET is set (same value
        // propagatePrincipal attaches to proxied traffic). Without it,
        // GATEWAY_VERIFY_APIKEY=true + internal secret would fail-closed always.
        ...(internalSecret ? { 'x-synapsedx-internal': internalSecret } : {}),
      },
      body: JSON.stringify({ apiKey }),
      signal: ctl.signal,
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const j: any = await r.json();
    if (!j.valid) return null;
    return { account_id: j.account_id, scopes: j.scopes || [] };
  } catch {
    clearTimeout(to);
    throw new Error('iam_unreachable');
  }
}

/** Xóa x-synapsedx-* do client gửi (chống spoof), ghi lại từ principal đã verify. */
export function propagatePrincipal(req: express.Request): void {
  const h = req.headers as Record<string, string | string[] | undefined>;
  delete h['x-synapsedx-user'];
  delete h['x-synapsedx-org'];
  delete h['x-synapsedx-account'];
  delete h['x-synapsedx-scopes'];
  delete h['x-synapsedx-kind'];
  delete h['x-synapsedx-internal'];
  // Service-to-service credential: downstream (iam/workflow) requires this header
  // when SYNAPSEDX_INTERNAL_SECRET is configured. Set AFTER stripping client input
  // but BEFORE the principal check — unauthenticated routes (/v1/auth/*) need it too.
  if (INTERNAL_SECRET) h['x-synapsedx-internal'] = INTERNAL_SECRET;
  const p = (req as any).principal;
  if (!p) return;
  if (p.type === 'jwt') {
    if (p.sub) h['x-synapsedx-user'] = String(p.sub);
    if (p.org) h['x-synapsedx-org'] = String(p.org);
    if (p.account) h['x-synapsedx-account'] = String(p.account);
    if (Array.isArray(p.scopes) && p.scopes.length) h['x-synapsedx-scopes'] = p.scopes.join(',');
    h['x-synapsedx-kind'] = 'user';
  } else if (p.type === 'apikey') {
    h['x-synapsedx-kind'] = 'apikey';
    if ((p as any).account) h['x-synapsedx-account'] = String((p as any).account);
    if (Array.isArray((p as any).scopes) && (p as any).scopes.length) {
      h['x-synapsedx-scopes'] = (p as any).scopes.join(',');
    }
  }
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Baseline security headers (no extra dep; gateway is a proxy, not a page server).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if ((process.env.HSTS_ENABLED || 'false') === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  // CORS: mở hết theo mặc định (MVP/dev); production BẮT BUỘC set CORS_ORIGIN=a.com,b.com
  const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!corsOrigins.length) {
    console.warn('[gateway][security] CORS_ORIGIN not set — allowing all origins (dev default). Set it in production.');
  }
  app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
  // Log kem request-id de trace gateway -> upstream (header do middleware rid gan ben duoi).
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Request ID: dùng client gửi lên nếu có, else tự sinh; trả về + forward upstream.
  // Sanitize: chỉ giữ token chars (tránh CRLF/header-injection làm crash setHeader).
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  // NOTE: rate limiting đã GỠ khỏi gateway theo quyết định vận hành (từng gây 429
  // oan do share Redis store; đã fix tách keyspace nhưng chủ động tắt để CI và
  // vận hành đơn giản). Muốn bật lại: revert commit này (xem CHANGELOG).
  // Production BẮT BUỘC rate-limit ở tầng ngoài (Ingress/WAF/reverse proxy),
  // đặc biệt cho /v1/auth/* (brute-force login) — xem SECURITY.md.
  // NOTE: không dùng express.json() toàn cục — body-parser sẽ nuốt stream
  // khiến http-proxy-middleware forward body rỗng/bể tới upstream.
  // Gateway là proxy thuần nên giữ nguyên raw body.

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gateway', version: VERSION, time: new Date().toISOString() }));
  app.get('/metrics', async (_req, res) => {
    try {
      res.setHeader('Content-Type', register.contentType);
      res.send(await register.metrics());
    } catch (e: any) {
      res.status(500).json({ error: 'metrics_failed', message: e.message });
    }
  });

  // Aggregate readiness: gateway + các upstream chính (timeout ngắn, không fail hard).
  app.get('/ready', async (_req, res) => {
    async function probe(name: string, url: string): Promise<{ name: string; ok: boolean; status?: number; ms?: number }> {
      const t0 = Date.now();
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: ctl.signal });
        clearTimeout(to);
        return { name, ok: r.ok, status: r.status, ms: Date.now() - t0 };
      } catch {
        return { name, ok: false, ms: Date.now() - t0 };
      }
    }
    const iamUrl = process.env.IAM_SERVICE_URL || 'http://iam:4001';
    const wfUrl = process.env.WORKFLOW_SERVICE_URL || 'http://workflow:4002';
    const [iam, workflow] = await Promise.all([probe('iam', iamUrl), probe('workflow', wfUrl)]);
    const allOk = iam.ok && workflow.ok;
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'degraded', service: 'gateway', upstreams: [iam, workflow], time: new Date().toISOString() });
  });

  const routes = loadRoutes();
  // Fail fast on operator typos: unknown auth mode would 401 everything silently.
  for (const r of routes) {
    if (!['none', 'jwt', 'apikey', 'either'].includes(r.auth)) {
      throw new Error(`[gateway] invalid auth mode '${r.auth}' for path '${r.path}' (want none|jwt|apikey|either)`);
    }
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
      throw new Error(`[gateway] invalid route path '${r.path}' (must start with /)`);
    }
  }
  console.log(`[gateway] loaded ${routes.length} routes: ${routes.map((r) => `${r.path}->${expandEnv(r.target)}[${r.auth}]`).join(', ')}`);

  app.get('/', (_req, res) =>
    res.json({
      name: 'SynapseDX Gateway (Tier-1 PaaS)',
      version: VERSION,
      docs: ['/health', '/ready', '/metrics'],
      auth: 'Bearer JWT | X-API-Key (except /v1/auth/*)',
      routes: routes.map((r) => ({ path: r.path, auth: r.auth })),
    }),
  );

  // Auth resolver toàn cục. KHÔNG dùng app.use(path, proxy): Express strips
  // mount-prefix khỏi req.url (bookkeeping slashAdded/removed); gán lại req.url
  // sẽ tạo URL rác với exact-path. Dùng pathFilter của proxy v3 + mount ở root.
  // Sau khi xác thực, gateway XÓA header x-synapsedx-* do client gửi (chống spoof) và
  // GHI header từ principal đã verify để upstream tin dùng mà không cần re-verify JWT.
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const urlPath = req.path; // pathname, không query
    if (urlPath === '/' || urlPath === '/health' || urlPath === '/metrics' || urlPath === '/ready') return next();
    const route = findRoute(routes, urlPath);
    if (!route) return res.status(404).json({ error: 'not_found', message: 'No gateway route matched' });
    (req as any).synapsedxRoute = route;
    httpCounter.inc({ route: route.path, status: 'incoming' });
    return authMiddleware(route.auth)(req, res, (err?: any) => {
      if (err) return next(err);
      propagatePrincipal(req);
      return next();
    });
  }) as any);

  for (const r of routes) {
    const target = expandEnv(r.target).replace(/\/$/, '');
    const proxyTimeoutMs = (() => {
      const n = Number(process.env.PROXY_TIMEOUT_MS || 30000);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 300000) : 30000;
    })();
    const proxy = createProxyMiddleware({
      pathFilter: r.path,
      target,
      changeOrigin: true,
      logLevel: 'warn',
      // Upstream treo thì 504 sau 30s thay vì treo gateway theo.
      proxyTimeout: proxyTimeoutMs,
      timeout: proxyTimeoutMs,
      // HPM v3: error handling qua `on.error` (KHÔNG phải `onError` v2).
      // Upstream chết giữa chừng (ECONNREFUSED/socket hangup): trả 502 JSON ngay
      // thay vì trang 504 mặc định của proxy.
      on: {
        error: (err: any, _req: any, res: any) => {
          console.error(`[gateway] proxy ${r.path}->${target} failed:`, err?.message || err);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'bad_gateway', message: 'upstream unavailable' }));
        },
      },
    } as any);
    app.use(proxy as any); // không path → proxy tự filter theo pathFilter, forward nguyên req.url
  }

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'No gateway route matched' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'gateway_error', message: err?.message || 'internal error' });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const server = app.listen(PORT, () => console.log(`[gateway] listening on :${PORT}`));
  const shutdown = () => {
    console.log('[gateway] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
