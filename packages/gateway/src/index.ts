/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import yaml from 'js-yaml';
import client from 'prom-client';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT || process.env.GATEWAY_PORT || 8080);
const IAM_SERVICE_URL = process.env.IAM_SERVICE_URL || 'http://iam:4001';
const JWT_SECRET = process.env.IAM_JWT_SECRET || 'change_me_super_secret_32chars_min';

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const httpCounter = new client.Counter({
  name: 'gateway_requests_total',
  help: 'Total proxied requests',
  labelNames: ['route', 'status'],
  registers: [register],
});

interface RouteRule {
  path: string;
  target: string;
  auth: 'none' | 'jwt' | 'apikey' | 'either';
  stripPrefix?: boolean;
}

function expandEnv(s: string): string {
  return s.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '');
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
          const decoded: any = jwt.verify(token, JWT_SECRET);
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
        (req as any).principal = { type: 'apikey' };
        return next();
      }
      if (mode === 'apikey') return res.status(401).json({ error: 'missing_api_key', message: 'X-API-Key required' });
    }
    return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT and/or X-API-Key' });
  };
}

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(morgan('combined'));
  // NOTE: không dùng express.json() toàn cục — body-parser sẽ nuốt stream
  // khiến http-proxy-middleware forward body rỗng/bể tới upstream.
  // Gateway là proxy thuần nên giữ nguyên raw body.

  const limiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'gateway', time: new Date().toISOString() }));
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  const routes = loadRoutes();
  console.log(`[gateway] loaded ${routes.length} routes: ${routes.map((r) => `${r.path}->${expandEnv(r.target)}[${r.auth}]`).join(', ')}`);

  // QUAN TRỌNG: không dùng app.use(path, ...) để mount proxy.
  // Express strips mount-prefix khỏi req.url và giữ bookkeeping slashAdded/removed;
  // tự gán req.url bên trong middleware sẽ làm hỏng bookkeeping (exact-path
  // như /v1/orgs bị biến thành /v1/orgsv1/orgs → 404 oan).
  // Cách đúng với http-proxy-middleware v3: mount ở root (không path) và dùng
  // pathFilter nội bộ của proxy — req.url giữ nguyên full path /v1/*.
  function findRoute(pathname: string): RouteRule | undefined {
    // longest-prefix match để /v1/n8n... không bị /v1/n... nuốt (nếu có)
    let best: RouteRule | undefined;
    for (const r of routes) {
      if (pathname === r.path || pathname.startsWith(r.path + '/')) {
        if (!best || r.path.length > best.path.length) best = r;
      }
    }
    return best;
  }

  // Auth resolver toàn cục (không mount path → không strip URL)
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const urlPath = req.path; // pathname, không query
    if (urlPath === '/health' || urlPath === '/metrics') return next();
    const route = findRoute(urlPath);
    if (!route) return res.status(404).json({ error: 'not_found', message: 'No gateway route matched' });
    (req as any).olpRoute = route;
    httpCounter.inc({ route: route.path, status: 'incoming' });
    return authMiddleware(route.auth)(req, res, next);
  }) as any);

  for (const r of routes) {
    const target = expandEnv(r.target).replace(/\/$/, '');
    const proxy = createProxyMiddleware({
      pathFilter: r.path,
      target,
      changeOrigin: true,
      logLevel: 'warn',
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
  app.listen(PORT, () => console.log(`[gateway] listening on :${PORT}`));
}
