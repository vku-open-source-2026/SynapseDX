/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow service: thin control-plane over n8n REST API.
 * Không fork n8n — gọi n8n như engine ngoài qua N8N_BASE_URL + N8N_API_KEY.
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';

dotenv.config();
const PORT = Number(process.env.PORT || 4002);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'http://n8n:5678').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
if (!N8N_API_KEY) {
  console.warn('[workflow][security] N8N_API_KEY not set — n8n calls go unauthenticated (dev default). Set it in production.');
} else if (N8N_API_KEY.includes('change_me')) {
  console.warn('[workflow][security] N8N_API_KEY looks like a default placeholder — rotate it.');
}
const IS_PROD_WF = process.env.NODE_ENV === 'production';

async function n8nFetch(path: string, init?: RequestInit, timeoutMs = 15000): Promise<{ status: number; body: any }> {
  const url = `${N8N_BASE_URL}${path}`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...init,
      signal: (init as any)?.signal || ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_API_KEY ? { 'X-N8N-API-KEY': N8N_API_KEY } : {}),
        ...((init?.headers as any) || {}),
      },
    });
    clearTimeout(to);
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: r.status, body };
  } catch (e: any) {
    clearTimeout(to);
    const msg = e?.name === 'AbortError' ? `n8n request timed out after ${timeoutMs}ms` : 'n8n unreachable (no endpoint detail)';
    return { status: 502, body: { error: 'n8n_unreachable', message: msg, hint: 'kiểm tra N8N_BASE_URL + mạng docker' } };
  }
}

/** SSRF guard: block workflow definitions that make n8n fetch internal targets. */
const BLOCKED_HOST_RES = [/^169\.254\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./, /^0\.0\.0\.0$/, /localhost/i, /\.local$/i, /^(iam|gateway|workflow|postgres|redis|n8n|s3|authentik|minio|metadata\.google)/i];
function isBlockedUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true; // only http(s) allowed
  if (u.username || u.password) return true;
  const host = u.hostname.replace(/\.$/, '');
  return BLOCKED_HOST_RES.some((re) => re.test(host));
}
function findSsrfUrl(definition: any): string | null {
  try {
    const nodes = definition?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      const params = (n as any)?.parameters;
      if (!params || typeof params !== 'object') continue;
      const candidates = [params.url, params.webhookUrl, params.resource, params.operation];
      for (const c of candidates) {
        if (typeof c === 'string' && c && isBlockedUrl(c)) return c;
      }
      // Deep-scan string values one level (covers httpRequest node options).
      for (const v of Object.values(params)) {
        if (typeof v === 'string' && v.length < 2048 && /^https?:\/\//i.test(v) && isBlockedUrl(v)) return v;
      }
    }
  } catch { /* ignore */ }
  return null;
}
function validateDefinition(definition: any): string | null {
  if (!definition || typeof definition !== 'object') return 'definition must be an object';
  const nodes = (definition as any).nodes;
  if (nodes !== undefined) {
    if (!Array.isArray(nodes)) return 'definition.nodes must be an array';
    if (nodes.length > 50) return 'definition.nodes exceeds 50 nodes';
    for (const n of nodes) {
      if (!n || typeof n !== 'object') return 'definition.nodes[] must be objects';
      if (typeof (n as any).type !== 'string' || (n as any).type.length > 128) return 'definition.nodes[].type invalid';
    }
  }
  try {
    if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 200 * 1024) return 'definition exceeds 200KB';
  } catch { return 'definition is not JSON-serializable'; }
  const bad = findSsrfUrl(definition);
  if (bad) return `definition contains blocked internal URL (${String(bad).slice(0, 80)}) — use an allowlisted public endpoint`;
  return null;
}

export function createApp(): express.Express {
  if (IS_PROD_WF) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[workflow] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!N8N_API_KEY) {
      throw new Error('[workflow] N8N_API_KEY must be set in production (else n8n is unauthenticated)');
    }
  }
  const app = express();
  app.disable('x-powered-by');
  // Baseline security headers (no extra dep; API-only service).
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
  app.use(cors((() => {
    const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      if (!IS_PROD_WF) console.warn('[workflow][security] CORS_ORIGIN not set — allowing all origins (dev default).');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Echo/propagate x-request-id (see iam-service for rationale).
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({ limit: '2mb' }));

  // Defense-in-depth: workflow KHÔNG tin gateway mù quáng. Khi SYNAPSEDX_INTERNAL_SECRET
  // được set (cùng giá trị ở gateway), mọi /v1/* (trừ /health) phải mang header
  // x-synapsedx-internal khớp — chặn truy cập trực tiếp :4002 vượt mặt gateway.
  // Client KHÔNG bao giờ được gửi header này (gateway strip + set lại sau khi verify).
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[workflow][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production.');
  }
  app.use('/v1/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!INTERNAL_SECRET) {
      if (IS_PROD_WF) return res.status(500).json({ error: 'misconfigured', message: 'internal secret required in production' });
      return next();
    }
    const raw = req.headers['x-synapsedx-internal'] as string | string[] | undefined;
    const got = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
    // Constant-time compare to avoid leaking secret prefix via timing.
    const a = Buffer.from(got);
    const b = Buffer.from(INTERNAL_SECRET);
    const ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
    next();
  }) as any);

  // Bọc async handler (Express 4 không catch async throw).
  for (const m of ['get', 'post', 'put', 'delete', 'patch'] as const) {
    const orig = ((app as any)[m] as Function).bind(app);
    (app as any)[m] = (path: string, ...handlers: any[]) =>
      orig(
        path,
        ...handlers.map((h: any) =>
          typeof h === 'function' && h.length < 4
            ? (req: express.Request, res: express.Response, next: express.NextFunction) =>
                Promise.resolve(h(req, res, next)).catch(next)
            : h,
        ),
      );
  }

  app.get('/health', async (_req, res) => {
    const n8n = await n8nFetch('/healthz').catch(() => ({ status: 0, body: null }));
    res.json({ status: 'ok', service: 'workflow', version: VERSION, ...(IS_PROD_WF ? {} : { n8n: N8N_BASE_URL }), n8nStatus: (n8n as any).status, time: new Date().toISOString() });
  });

  // List workflows (proxy)
  app.get('/v1/workflows', async (_req, res) => {
    const r = await n8nFetch('/api/v1/workflows');
    res.status(r.status).json(r.body);
  });

  // Get one workflow (proxy)
  app.get('/v1/workflows/:id', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}`);
    res.status(r.status).json(r.body);
  });

  // Create workflow from template or raw definition
  app.post('/v1/workflows', async (req, res) => {
    const { name, definition, template } = (req.body || {}) as any;
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (template != null && (typeof template !== 'string' || !/^[a-z0-9-]{1,64}$/.test(template))) {
      return res.status(400).json({ error: 'invalid_template', message: 'unknown template (see GET /v1/templates)' });
    }
    const fromTemplate = Boolean(template && !definition);
    let payload: any = definition;
    if (fromTemplate) {
      payload = buildTemplate(template, (name as string) || template);
      if (!payload) return res.status(400).json({ error: 'unknown_template', available: listTemplates().map((t) => t.name) });
    }
    if (!payload) return res.status(400).json({ error: 'definition or template required' });
    // Built-in templates are trusted (fixed code); custom definitions get full SSRF validation.
    const defErr = fromTemplate ? null : validateDefinition(payload);
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    const r = await n8nFetch('/api/v1/workflows', { method: 'POST', body: JSON.stringify({ name: String(name || 'synapsedx-workflow').slice(0, 200), nodes: payload.nodes || [], connections: payload.connections || {}, settings: {} }) });
    res.status(r.status).json(r.body);
  });

  // Execute workflow (n8n webhook or manual trigger proxy)
  app.post('/v1/workflows/:id/execute', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    let bodySize = 0;
    try { bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (bodySize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'execute body ≤200KB' });
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(id)}/execute`, {
      method: 'POST',
      body: JSON.stringify(req.body || {}),
    });
    res.status(r.status).json(r.body);
  });

  // Activate / deactivate (proxy)
  app.post('/v1/workflows/:id/activate', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}/activate`, { method: 'POST' });
    res.status(r.status).json(r.body);
  });

  app.post('/v1/workflows/:id/deactivate', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}/deactivate`, { method: 'POST' });
    res.status(r.status).json(r.body);
  });

  // Proxy executions list. Query allowlist: caller chỉ được truyền các param đã biết
  // của n8n executions API — chặn query-injection (vd ?url=, ?path=) forward tới engine.
  app.get('/v1/executions', async (req, res) => {
    const allow = ['limit', 'offset', 'workflowId', 'status', 'includeData'];
    const qs = new URLSearchParams();
    for (const k of allow) {
      const v = req.query[k];
      if (typeof v === 'string' && v.length <= 256) qs.set(k, v);
    }
    const suffix = [...qs].length ? `?${qs.toString()}` : '';
    const r = await n8nFetch(`/api/v1/executions${suffix}`);
    res.status(r.status).json(r.body);
  });

  // Get one execution (proxy)
  app.get('/v1/executions/:id', async (req, res) => {
    const r = await n8nFetch(`/api/v1/executions/${encodeURIComponent(req.params.id)}`);
    res.status(r.status).json(r.body);
  });

  // Built-in templates (versioned JSON, dùng khi n8n chưa có workflow)
  app.get('/v1/templates', (_req, res) => res.json(listTemplates()));
  app.get('/v1/templates/:name', (req, res) => {
    const t = buildTemplate(req.params.name, req.params.name);
    if (!t) return res.status(404).json({ error: 'template_not_found' });
    res.json(t);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[workflow] unhandled:', err?.message || err);
    if (res.headersSent) return;
    // Malformed JSON body: 400, not 500.
    if (err?.status === 400 || err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && /JSON/i.test(err.message))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

export function listTemplates() {
  return [
    { name: 'webhook-to-log', description: 'Webhook receives a gateway event -> writes a log -> replies 200' },
    { name: 'cron-etl', description: 'Nightly cron -> fetches IAM health -> transforms -> logs' },
    { name: 'iam-webhook', description: 'Receives IAM events (user.created) -> calls back into the synapsedx API' },
  ];
}

export { isBlockedUrl, validateDefinition, findSsrfUrl };

export function buildTemplate(name: string, workflowName?: string): any | null {
  const wname = workflowName || name;
  const wid = () => (globalThis.crypto as any)?.randomUUID?.() || Math.random().toString(36).slice(2);
  if (name === 'webhook-to-log') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'synapsedx-event', httpMethod: 'POST' } },
        { id: wid(), name: 'Log', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 300], parameters: {} },
      ],
      connections: { Webhook: { main: [[{ node: 'Log', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'cron-etl') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Cron', type: 'n8n-nodes-base.cron', typeVersion: 1, position: [200, 300], parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } } },
        { id: wid(), name: 'FetchAPI', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 300], parameters: { url: 'https://api.example.com/health', method: 'GET' } },
      ],
      connections: { Cron: { main: [[{ node: 'FetchAPI', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'iam-webhook') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'IAMEvent', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'iam-event', httpMethod: 'POST' } },
        { id: wid(), name: 'CallAPI', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [420, 300], parameters: { url: 'https://api.example.com/v1/orgs', method: 'GET' } },
      ],
      connections: { IAMEvent: { main: [[{ node: 'CallAPI', type: 'main', index: 0 }]] } },
    };
  }
  return null;
}

if (require.main === module) {
  const app = createApp();
  const server = app.listen(PORT, () => console.log(`[workflow] listening on :${PORT} n8n=${N8N_BASE_URL}`));
  const shutdown = () => {
    console.log('[workflow] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
