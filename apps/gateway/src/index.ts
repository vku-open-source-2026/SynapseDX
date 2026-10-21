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
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[gateway] SYNAPSEDX_INTERNAL_SECRET must be set in production');
  }
  console.warn('[gateway][security] SYNAPSEDX_INTERNAL_SECRET not set — downstream services cannot tell gateway traffic apart (dev default). Set it in production.');
}

/** Fail-closed API-key verification: default true; explicit false only allowed in dev. */
export function isVerifyApiKeyEnabled(): boolean {
  const raw = process.env.GATEWAY_VERIFY_APIKEY;
  if (raw === undefined || raw === '') return true;
  return raw === 'true';
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
  /** Per-route proxy timeout (ms). LLM-backed routes legitimately need longer
   *  than the 30s default (retried model calls); unset = global default. */
  timeoutMs?: number;
  /** Compiled matcher cache (set by loadRoutes / createApp validation). */
  compiled?: { match: (pathname: string) => boolean; specificity: number };
}

export function expandEnv(s: string): string {
  return s.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '');
}

/**
 * Route path syntax:
 *  - static prefixes match exactly or as prefix (`/v1/orgs` + `/v1/orgs/...`,
 *    không khớp `/v1/organizations`);
 *  - a `*` segment matches exactly one non-empty path segment (slash-free);
 *  - a trailing slash-star matches any remainder, including none, so the LDS
 *    public rule covers both the export collection path and the single-entity
 *    path below it — but never sibling resources like records or attributes.
 * Specificity: more literal characters win, so static rules always shadow the
 * shorter prefix they overlap with and wildcard rules shadow `/v1/lds` for
 * their exact shape only.
 */
export function compileRoutePath(path: string): { match: (pathname: string) => boolean; specificity: number } {
  if (!path.includes('*')) {
    const match = (p: string) => p === path || p.startsWith(path + '/');
    return { match, specificity: path.length };
  }
  if (/\/\//.test(path) || !path.startsWith('/')) throw new Error(`[gateway] invalid wildcard route path '${path}'`);
  const segments = path.split('/');
  let literal = 0;
  let pattern = '^';
  segments.forEach((seg, i) => {
    if (i === 0) return;
    if (seg === '*' && i === segments.length - 1) {
      pattern += '(?:/.*)?';
      literal += 1; // the slash itself
    } else if (seg === '*') {
      pattern += '/[^/]+';
      literal += 1;
    } else {
      if (!seg) throw new Error(`[gateway] invalid wildcard route path '${path}' (empty segment)`);
      pattern += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      literal += seg.length;
    }
  });
  pattern += '$';
  const re = new RegExp(pattern);
  return { match: (p) => re.test(p), specificity: literal };
}

export function findRoute(routes: RouteRule[], pathname: string): RouteRule | undefined {
  let best: RouteRule | undefined;
  let bestScore = -1;
  for (const r of routes) {
    const m = r.compiled || (r.compiled = compileRoutePath(r.path)); // compiled at load; lazily here for legacy callers
    if (!m.match(pathname)) continue;
    if (m.specificity > bestScore) {
      best = r;
      bestScore = m.specificity;
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
    if (mode === 'none') {
      // Public routes are anonymous, BUT a Bearer token that verifies is
      // honoured as optional auth: LDS same-tenant restricted queries and
      // tenant tools reuse the same export paths. An invalid/absent token
      // stays anonymous (the upstream sees the anon marker) — public flows
      // can never break on a stray Authorization header.
      const h = String(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization || ''));
      if (h.startsWith('Bearer ')) {
        try {
          const decoded: any = jwt.verify(h.slice(7), JWT_SECRET, { issuer: 'synapsedx-iam', algorithms: ['HS256'] });
          (req as any).principal = { type: 'jwt', sub: decoded.sub, org: decoded.org, account: decoded.account, scopes: decoded.scopes || [] };
        } catch { /* anonymous */ }
      }
      return next();
    }
    const h = String(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization || ''));
    const hasBearer = h.startsWith('Bearer ');
    const apiKeyRaw = req.headers['x-api-key'] as string | string[] | undefined;
    const apiKey = Array.isArray(apiKeyRaw) ? (apiKeyRaw[0] || '') : (apiKeyRaw || '');
    if (mode === 'jwt' || mode === 'either') {
      if (hasBearer) {
        const token = h.slice(7);
        try {
          const decoded: any = jwt.verify(token, JWT_SECRET, { issuer: 'synapsedx-iam', algorithms: ['HS256'] });
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
        // Fail-closed by default: verify API keys against IAM.
        // GATEWAY_VERIFY_APIKEY=false is dev-only (presence check) and forbidden in prod.
        if (isVerifyApiKeyEnabled()) {
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
        if (process.env.NODE_ENV === 'production') {
          return res.status(500).json({ error: 'misconfigured', message: 'GATEWAY_VERIFY_APIKEY=false is forbidden in production' });
        }
        console.warn('[gateway][security] accepting unverified X-API-Key (GATEWAY_VERIFY_APIKEY=false, dev only)');
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

/** Xóa x-synapsedx-* do client gửi (chống spoof), ghi lại từ principal đã verify.
 *  Auth:none routes: đánh dấu `x-synapsedx-anon: 1` để upstream phân biệt
 *  khách ẩn danh công khai (public LDS export) với platform context nội bộ —
 *  cả hai đều không có principal. Marker chỉ do gateway gắn, client gửi thêm
 *  sẽ bị xóa trước. */
export function propagatePrincipal(req: express.Request): void {
  const h = req.headers as Record<string, string | string[] | undefined>;
  delete h['x-synapsedx-user'];
  delete h['x-synapsedx-org'];
  delete h['x-synapsedx-account'];
  delete h['x-synapsedx-scopes'];
  delete h['x-synapsedx-kind'];
  delete h['x-synapsedx-internal'];
  delete h['x-synapsedx-anon'];
  // Service-to-service credential: downstream (iam/workflow) requires this header
  // when SYNAPSEDX_INTERNAL_SECRET is configured. Set AFTER stripping client input
  // but BEFORE the principal check — unauthenticated routes (/v1/auth/*) need it too.
  if (INTERNAL_SECRET) h['x-synapsedx-internal'] = INTERNAL_SECRET;
  const p = (req as any).principal;
  if (p?.type === 'jwt') {
    if (p.sub) h['x-synapsedx-user'] = String(p.sub);
    if (p.org) h['x-synapsedx-org'] = String(p.org);
    if (p.account) h['x-synapsedx-account'] = String(p.account);
    if (Array.isArray(p.scopes) && p.scopes.length) h['x-synapsedx-scopes'] = p.scopes.join(',');
    h['x-synapsedx-kind'] = 'user';
  } else if (p?.type === 'apikey') {
    h['x-synapsedx-kind'] = 'apikey';
    if ((p as any).account) h['x-synapsedx-account'] = String((p as any).account);
    if (Array.isArray((p as any).scopes) && (p as any).scopes.length) {
      h['x-synapsedx-scopes'] = (p as any).scopes.join(',');
    }
  } else if ((req as any).synapsedxRoute?.auth === 'none') {
    // Unauthenticated call on a public route → anonymous visitor marker.
    // Platform context (internal ops, no marker) stays marker-less.
    h['x-synapsedx-anon'] = '1';
  }
}

export function createApp(): express.Express {
  if (process.env.NODE_ENV === 'production' && !isVerifyApiKeyEnabled()) {
    throw new Error('[gateway] GATEWAY_VERIFY_APIKEY=false is forbidden in production (auth bypass). Set true.');
  }
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
  // In-memory edge rate limiting (per-IP; outer Ingress/WAF still required in prod
  // for DDoS, but this stops single-IP brute-force / /ready fan-out amplification).
  const hits = new Map<string, { n: number; reset: number }>();
  const WINDOW_MS = 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, WINDOW_MS).unref?.();
  function edgeLimit(max: number) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const ip = String(req.ip || req.socket?.remoteAddress || 'anon').slice(0, 64);
      const now = Date.now();
      const cur = hits.get(ip + ':' + max);
      if (!cur || cur.reset < now) { hits.set(ip + ':' + max, { n: 1, reset: now + WINDOW_MS }); return next(); }
      cur.n++;
      if (cur.n > max) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down' });
      return next();
    };
  }
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
  // Rate-limited: mỗi hit quạt 1:2 upstream nên phải giới hạn.
  app.get('/ready', edgeLimit(30) as any, async (_req, res) => {
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
    const aiUrl = process.env.AI_SERVICE_URL || 'http://ai:4003';
    const ldsUrl = process.env.LDS_SERVICE_URL || 'http://lds:4004';
    const baseUrl = process.env.BASE_SERVICE_URL || 'http://base:4005';
    const faststoreUrl = process.env.FASTSTORE_SERVICE_URL || 'http://faststore:4006';
    const queueUrl = process.env.QUEUE_SERVICE_URL || 'http://queue:4007';
    const [iam, workflow, ai, lds, base, faststore, queue] = await Promise.all([
      probe('iam', iamUrl), probe('workflow', wfUrl), probe('ai', aiUrl), probe('lds', ldsUrl),
      probe('base', baseUrl), probe('faststore', faststoreUrl), probe('queue', queueUrl),
    ]);
    const upstreams = [iam, workflow, ai, lds, base, faststore, queue];
    const allOk = upstreams.every((u) => u.ok);
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'ready' : 'degraded', service: 'gateway', upstreams, time: new Date().toISOString() });
  });

  const routes = loadRoutes();
  // Precompile matchers + fail fast on operator typos: unknown auth mode would
  // 401 everything silently; malformed wildcard paths would throw mid-request.
  for (const r of routes) {
    if (!['none', 'jwt', 'apikey', 'either'].includes(r.auth)) {
      throw new Error(`[gateway] invalid auth mode '${r.auth}' for path '${r.path}' (want none|jwt|apikey|either)`);
    }
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
      throw new Error(`[gateway] invalid route path '${r.path}' (must start with /)`);
    }
    try {
      r.compiled = compileRoutePath(r.path);
    } catch (e: any) {
      throw new Error(`[gateway] ${e?.message || 'invalid route path'}`);
    }
    if (r.timeoutMs !== undefined && (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1000 || r.timeoutMs > 300000)) {
      throw new Error(`[gateway] invalid timeoutMs '${r.timeoutMs}' for path '${r.path}' (want 1000..300000)`);
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
  // Auth endpoints (/v1/auth/*) đi thẳng nhưng vẫn giới hạn brute-force.
  app.use('/v1/auth/' as any, edgeLimit(120) as any);
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
      if (r.timeoutMs !== undefined) return r.timeoutMs;
      const n = Number(process.env.PROXY_TIMEOUT_MS || 30000);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 300000) : 30000;
    })();
    // pathFilter = chuẩn theo cùng logic findRoute: mỗi request đúng MỘT proxy
    // (exclusive match) — wildcard routes phải chiếm đúng shape của chúng mà
    // không bị proxy prefix tổng ('/v1/lds') nhốt hết.
    const routeMatcher = (pathname: string) => findRoute(routes, pathname) === r;
    const proxy = createProxyMiddleware({
      pathFilter: routeMatcher as any,
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
          try {
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
            }
            if (!res.writableEnded) res.end(JSON.stringify({ error: 'bad_gateway', message: 'upstream unavailable' }));
          } catch { /* socket already dead */ }
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
    if (res.headersSent || res.writableEnded) return;
    res.status(500).json({ error: 'gateway_error' });
  });
  return app;
}

if (require.main === module) {
  // 19+ routes → every proxy registers a close listener on the server; the
  // default EventEmitter cap of 10 turns that into a scary warning per boot.
  require('node:events').EventEmitter.defaultMaxListeners = 60;
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
