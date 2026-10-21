/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseQueue — tenant-scoped message queue with delayed and deduplicated
 * publishing, visibility-timeout consumption, receipts, ack/nack/heartbeat,
 * retries, dead-letter queues and replay.
 *
 * Redis is the production backend; an in-memory fallback keeps local
 * development and tests dependency-free. Auth matches the platform:
 * gateway-stamped x-synapsedx-* headers plus SYNAPSEDX_INTERNAL_SECRET.
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import {
  QueueError, useRedis, initStore, closeStore,
  ensureQueue, getQueue, listQueues, deleteQueue, purgeQueue,
  publishMessage, consumeMessages, ackMessage, nackMessage, heartbeatMessage,
  peekMessages, deadMessages, replayDeadMessage, deleteDeadMessage, queueStats,
  InternalMessage, QueueConfig, PublishInput,
} from './store';

dotenv.config();
const PORT = Number(process.env.PORT || 4007);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_PAYLOAD_BYTES = Math.min(Math.max(Number(process.env.QUEUE_MAX_PAYLOAD_BYTES || 262144), 1024), 1024 * 1024);
const MAX_HEADERS_BYTES = 8192;
const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_VISIBILITY_SECONDS = 3600;
const MAX_MESSAGES_PER_CONSUME = 100;
const MAX_BATCH = 100;
const QUEUE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_@.:+-]{1,128}$/;

export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

export interface Caller {
  kind: 'anon' | 'principal' | 'platform';
  principal: Principal | null;
}

export function principalFromHeaders(req: express.Request): Principal | null {
  const h = (n: string): string => {
    const v = req.headers[n];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const sub = h('x-synapsedx-user');
  if (!sub || sub.length > 128) return null;
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  return { sub, org: clean(h('x-synapsedx-org')), account: clean(h('x-synapsedx-account')), kind: clean(h('x-synapsedx-kind')) };
}

export function resolveCaller(req: express.Request): Caller {
  const p = principalFromHeaders(req);
  if (p) return { kind: 'principal', principal: p };
  const raw = req.headers['x-synapsedx-anon'];
  const anon = (Array.isArray(raw) ? raw[0] : raw) === '1';
  return anon ? { kind: 'anon', principal: null } : { kind: 'platform', principal: null };
}

class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'RequestError';
  }
}

function cleanTenant(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > 128 || /[\r\n\x00-\x1F\x7F]/.test(s)) return null;
  return s;
}

function tenantFor(req: express.Request): string | null {
  const caller = resolveCaller(req);
  if (caller.kind === 'principal') {
    const p = caller.principal!;
    if (p.org) return `org:${p.org}`;
    if (p.account) return `account:${p.account}`;
    return `user:${p.sub}`;
  }
  if (caller.kind === 'platform') {
    const header = req.headers['x-synapsedx-tenant'];
    const raw = Array.isArray(header) ? header[0] : header;
    const t = cleanTenant(raw || req.query.tenant);
    return t ? `tenant:${t}` : null;
  }
  return null;
}

function requireTenant(req: express.Request, res: express.Response): string | null {
  const caller = resolveCaller(req);
  if (caller.kind === 'anon') {
    res.status(401).json({ error: 'auth_required', message: 'SynapseQueue requires an authenticated caller' });
    return null;
  }
  const tenant = tenantFor(req);
  if (!tenant) {
    res.status(400).json({ error: 'tenant_required', message: 'platform callers must pass x-synapsedx-tenant or ?tenant=' });
    return null;
  }
  return tenant;
}

function cleanQueueOrThrow(v: unknown): string {
  const s = String(v ?? '');
  if (!QUEUE_RE.test(s)) {
    throw new RequestError(400, 'invalid_queue', 'queue must match [A-Za-z][A-Za-z0-9_-]{0,63}');
  }
  return s;
}

function cleanMessageIdOrThrow(v: unknown): string {
  const s = String(v ?? '');
  if (!MESSAGE_ID_RE.test(s)) {
    throw new RequestError(400, 'invalid_message_id', 'message id must be 1..128 characters from [A-Za-z0-9_@.:+-]');
  }
  return s;
}

function cleanReceiptOrThrow(v: unknown): string {
  const s = String(v ?? '');
  if (!s || s.length > 512 || /[\r\n\x00-\x1F\x7F]/.test(s)) {
    throw new RequestError(400, 'invalid_receipt', 'receipt must be 1..512 printable characters');
  }
  return s;
}

function intOrThrow(v: unknown, name: string, min: number, max: number, def: number): number {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RequestError(400, 'invalid_request', `${name} must be an integer ${min}..${max}`);
  }
  return n;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function bodyOf(req: express.Request): Record<string, any> {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new RequestError(400, 'invalid_body', 'request body must be a JSON object');
  }
  return b as Record<string, any>;
}

function arrayOrThrow(v: unknown, name: string, min: number, max: number): any[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    throw new RequestError(400, 'invalid_request', `${name} must be an array with ${min}..${max} items`);
  }
  return v;
}

function headersOrThrow(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new RequestError(400, 'invalid_headers', 'headers must be an object');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 50) throw new RequestError(400, 'invalid_headers', 'headers supports at most 50 entries');
  for (const [k] of entries) {
    if (!k || k.length > 64 || /[\r\n\x00-\x1F\x7F]/.test(k)) {
      throw new RequestError(400, 'invalid_headers', 'header names must be 1..64 printable characters');
    }
  }
  if (Buffer.byteLength(JSON.stringify(v)) > MAX_HEADERS_BYTES) {
    throw new RequestError(400, 'invalid_headers', `headers exceed ${MAX_HEADERS_BYTES} bytes`);
  }
  return v as Record<string, unknown>;
}

function delayOrThrow(v: unknown): number {
  return intOrThrow(v, 'delaySeconds', 0, MAX_DELAY_SECONDS, 0);
}

function visibilityOrThrow(v: unknown, def: number): number {
  return intOrThrow(v, 'visibilityTimeoutSeconds', 1, MAX_VISIBILITY_SECONDS, def);
}

function iso(ms?: number): string | undefined {
  return ms === undefined || ms === null || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();
}

function apiConfig(c: QueueConfig): any {
  return {
    name: c.name,
    maxAttempts: c.maxAttempts,
    visibilityTimeoutSeconds: c.visibilityTimeoutSeconds,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

function apiMessage(m: InternalMessage): any {
  return {
    id: m.id,
    payload: m.payload,
    ...(m.headers ? { headers: m.headers } : {}),
    publishedAt: iso(m.published_at),
    ...(m.available_at !== undefined ? { availableAt: iso(m.available_at) } : {}),
    attempts: m.attempts,
    maxAttempts: m.max_attempts,
    ...(m.dedupe_key ? { dedupeKey: m.dedupe_key } : {}),
    ...(m.last_error ? { lastError: m.last_error } : {}),
    dead: m.dead,
    ...(m.dead_at !== undefined ? { deadAt: iso(m.dead_at) } : {}),
    ...(m.consumer ? { consumer: m.consumer } : {}),
  };
}

function publishInputFrom(body: Record<string, any>): PublishInput {
  if (!Object.prototype.hasOwnProperty.call(body, 'payload')) {
    throw new RequestError(400, 'invalid_payload', 'payload is required');
  }
  let payloadBytes: number;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(body.payload ?? null));
  } catch {
    throw new RequestError(400, 'invalid_payload', 'payload must be JSON-serializable');
  }
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new RequestError(413, 'payload_too_large', `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const options: PublishInput = {
    payload: body.payload,
    delaySeconds: delayOrThrow(body.delaySeconds),
    ...(body.maxAttempts !== undefined ? { maxAttempts: intOrThrow(body.maxAttempts, 'maxAttempts', 1, 100, 5) } : {}),
    ...(body.headers !== undefined ? { headers: headersOrThrow(body.headers) } : {}),
  };
  if (body.id !== undefined) options.id = cleanMessageIdOrThrow(body.id);
  if (body.dedupeKey !== undefined) {
    const key = String(body.dedupeKey);
    if (!key || key.length > 256 || /[\r\n\x00-\x1F\x7F]/.test(key)) {
      throw new RequestError(400, 'invalid_dedupe_key', 'dedupeKey must be 1..256 printable characters');
    }
    options.dedupeKey = key;
  }
  return options;
}

function toApiError(e: any): { status: number; body: any } {
  if (e instanceof RequestError) return { status: e.status, body: { error: e.code, message: e.message } };
  if (e instanceof QueueError) {
    const status = e.code === 'not_found' ? 404
      : e.code === 'conflict' ? 409
        : e.code === 'storage_unavailable' ? 503 : 400;
    return { status, body: { error: e.code, message: e.message } };
  }
  return { status: 500, body: { error: 'internal', message: 'unexpected error' } };
}

export function createApp(): express.Express {
  if (IS_PROD) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[queue] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.QUEUE_REDIS_URL && !process.env.REDIS_URL) {
      throw new Error('[queue] QUEUE_REDIS_URL/REDIS_URL must be set in production (in-memory fallback would split-brain)');
    }
  }
  const app = express();
  app.disable('x-powered-by');
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
      if (IS_PROD) return { origin: false } as any;
      console.warn('[queue][security] CORS_ORIGIN not set — allowing all origins (dev default).');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({ limit: '5mb' }));

  // ---- Prometheus metrics (bounded cardinality) ----
  const METRIC_REQUESTS: Map<string, number> = new Map();
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.on('finish', () => {
      try {
        let route: string = (req.route?.path as string) || '';
        if (!route) {
          const seg = (req.path || '/').split('/').filter(Boolean).slice(0, 3);
          route = '/' + seg.join('/');
        }
        if (METRIC_REQUESTS.size >= 300) route = '**';
        else route = route.slice(0, 64);
        const key = `${req.method}|${route}|${res.statusCode}`;
        METRIC_REQUESTS.set(key, (METRIC_REQUESTS.get(key) || 0) + 1);
      } catch { /* best effort */ }
    });
    next();
  }) as any);
  app.get('/metrics', (_req, res) => {
    const lines = [
      '# HELP synapsedx_queue_up SynapseQueue service up.',
      '# TYPE synapsedx_queue_up gauge',
      'synapsedx_queue_up 1',
      '# HELP synapsedx_queue_backend_info Active backend (1 = active).',
      '# TYPE synapsedx_queue_backend_info gauge',
      `synapsedx_queue_backend_info{backend="${useRedis() ? 'redis' : 'memory'}"} 1`,
      '# HELP synapsedx_queue_process_uptime_seconds Process uptime in seconds.',
      '# TYPE synapsedx_queue_process_uptime_seconds gauge',
      `synapsedx_queue_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '# HELP synapsedx_queue_http_requests_total HTTP requests by key = method|route|status.',
      '# TYPE synapsedx_queue_http_requests_total counter',
      ...[...METRIC_REQUESTS.entries()].map(([k, v]) => `synapsedx_queue_http_requests_total{key="${k}"} ${v}`),
    ];
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Internal secret gate: every /v1/* call must carry it when configured.
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[queue][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default).');
  }
  app.use('/v1/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!INTERNAL_SECRET) {
      if (IS_PROD) return res.status(500).json({ error: 'misconfigured', message: 'internal secret required in production' });
      return next();
    }
    const raw = req.headers['x-synapsedx-internal'] as string | string[] | undefined;
    const got = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
    const a = Buffer.from(got);
    const b = Buffer.from(INTERNAL_SECRET);
    const ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
    next();
  }) as any);

  // Async wrapper (Express 4 doesn't catch async throws).
  for (const m of ['get', 'post', 'put', 'delete', 'patch'] as const) {
    const orig = ((app as any)[m] as Function).bind(app);
    (app as any)[m] = (path: string, ...handlers: any[]) =>
      orig(path, ...handlers.map((h: any) =>
        typeof h === 'function' && h.length < 4
          ? (req: express.Request, res: express.Response, next: express.NextFunction) => Promise.resolve(h(req, res, next)).catch(next)
          : h,
      ));
  }

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok', service: 'queue', version: VERSION,
      backend: useRedis() ? 'redis' : 'memory', time: new Date().toISOString(),
    });
  });

  // ---- queues ----
  app.get('/v1/queue/queues', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    res.json((await listQueues(tenant)).map(apiConfig));
  });

  app.put('/v1/queue/queues/:queue', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const body = bodyOf(req);
    const opts: { maxAttempts?: number; visibilityTimeoutSeconds?: number } = {};
    if (body.maxAttempts !== undefined) opts.maxAttempts = intOrThrow(body.maxAttempts, 'maxAttempts', 1, 100, 5);
    if (body.visibilityTimeoutSeconds !== undefined) opts.visibilityTimeoutSeconds = intOrThrow(body.visibilityTimeoutSeconds, 'visibilityTimeoutSeconds', 1, MAX_VISIBILITY_SECONDS, 30);
    const existed = !!(await getQueue(tenant, name));
    const config = await ensureQueue(tenant, name, opts);
    res.status(existed ? 200 : 201).json(apiConfig(config));
  });

  app.get('/v1/queue/queues/:queue', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const config = await getQueue(tenant, name);
    if (!config) return res.status(404).json({ error: 'not_found', message: `queue '${name}' not found` });
    const stats = await queueStats(tenant, name);
    res.json({ ...apiConfig(config), stats });
  });

  app.delete('/v1/queue/queues/:queue', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    res.json({ queue: name, deleted: await deleteQueue(tenant, name) });
  });

  app.post('/v1/queue/queues/:queue/purge', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const purged = await purgeQueue(tenant, name);
    if (!purged) return res.status(404).json({ error: 'not_found', message: `queue '${name}' not found` });
    res.json({ ok: true, queue: name, purged: true });
  });

  app.get('/v1/queue/queues/:queue/stats', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const stats = await queueStats(tenant, name);
    if (!stats) return res.status(404).json({ error: 'not_found', message: `queue '${name}' not found` });
    res.json(stats);
  });

  // ---- publish ----
  app.post('/v1/queue/queues/:queue/messages', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const input = publishInputFrom(bodyOf(req));
    const result = await publishMessage(tenant, name, input);
    res.status(result.duplicate ? 200 : 201).json({
      ok: true, queue: name, id: result.id, duplicate: result.duplicate, message: apiMessage(result.message),
    });
  });

  app.post('/v1/queue/queues/:queue/messages:batch', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const body = bodyOf(req);
    const items = arrayOrThrow(body.messages, 'messages', 1, MAX_BATCH);
    const results: any[] = [];
    for (const raw of items) {
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestError(400, 'invalid_request', 'message must be an object');
        const input = publishInputFrom(raw);
        const result = await publishMessage(tenant, name, input);
        results.push({ ok: true, id: result.id, duplicate: result.duplicate, message: apiMessage(result.message) });
      } catch (e: any) {
        const mapped = toApiError(e);
        results.push({ ok: false, error: mapped.body.error, message: mapped.body.message });
      }
    }
    res.json({ queue: name, results, ok: results.every((r) => r.ok) });
  });

  // ---- consume / ack / nack / heartbeat ----
  app.post('/v1/queue/queues/:queue/consume', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const body = bodyOf(req);
    const maxMessages = intOrThrow(body.maxMessages, 'maxMessages', 1, MAX_MESSAGES_PER_CONSUME, 1);
    const config = await ensureQueue(tenant, name);
    const visibility = visibilityOrThrow(body.visibilityTimeoutSeconds, config.visibilityTimeoutSeconds);
    const caller = resolveCaller(req);
    const consumer = body.consumer !== undefined
      ? String(body.consumer).slice(0, 128)
      : (caller.principal?.sub || 'worker');
    if (!consumer || /[\r\n\x00-\x1F\x7F]/.test(consumer)) {
      throw new RequestError(400, 'invalid_consumer', 'consumer must be a printable string');
    }
    const consumed = await consumeMessages(tenant, name, { maxMessages, visibilityTimeoutSeconds: visibility, consumer });
    res.json({
      queue: name,
      count: consumed.length,
      visibilityTimeoutSeconds: visibility,
      messages: consumed.map((c) => ({
        ...apiMessage(c.message),
        receipt: c.receipt,
        leaseExpiresAt: iso(c.leaseExpiresAt),
      })),
    });
  });

  app.post('/v1/queue/queues/:queue/ack', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const body = bodyOf(req);
    if (body.receipts !== undefined) {
      const receipts = arrayOrThrow(body.receipts, 'receipts', 1, MAX_BATCH).map(cleanReceiptOrThrow);
      const results = [];
      for (const receipt of receipts) {
        const id = await ackMessage(tenant, name, receipt);
        results.push(id ? { ok: true, receipt, id } : { ok: false, receipt, error: 'receipt_not_found' });
      }
      return res.json({ queue: name, results, ok: results.every((r) => r.ok) });
    }
    const receipt = cleanReceiptOrThrow(body.receipt);
    const id = await ackMessage(tenant, name, receipt);
    if (!id) return res.status(404).json({ error: 'receipt_not_found', message: 'receipt is unknown or already acknowledged' });
    res.json({ ok: true, queue: name, receipt, id });
  });

  app.post('/v1/queue/queues/:queue/nack', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const body = bodyOf(req);
    const receipt = cleanReceiptOrThrow(body.receipt);
    const delaySeconds = delayOrThrow(body.delaySeconds);
    const error = body.error === undefined ? undefined : String(body.error).slice(0, 1024);
    const result = await nackMessage(tenant, name, receipt, {
      requeue: body.requeue === undefined ? true : bool(body.requeue),
      delaySeconds,
      error,
    });
    if (!result) return res.status(404).json({ error: 'receipt_not_found', message: 'receipt is unknown or already acknowledged' });
    res.json({
      ok: true, queue: name, id: result.id, state: result.state, attempts: result.attempts,
      ...(result.availableAt !== undefined ? { availableAt: iso(result.availableAt) } : {}),
      ...(result.deadAt !== undefined ? { deadAt: iso(result.deadAt) } : {}),
    });
  });

  app.post('/v1/queue/queues/:queue/heartbeat', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const body = bodyOf(req);
    const receipt = cleanReceiptOrThrow(body.receipt);
    const config = await ensureQueue(tenant, name);
    const visibility = visibilityOrThrow(body.visibilityTimeoutSeconds, config.visibilityTimeoutSeconds);
    const deadline = await heartbeatMessage(tenant, name, receipt, visibility);
    if (deadline === null) return res.status(404).json({ error: 'receipt_not_found', message: 'receipt is unknown or already acknowledged' });
    res.json({ ok: true, queue: name, receipt, leaseExpiresAt: iso(deadline), visibilityTimeoutSeconds: visibility });
  });

  // ---- inspection and dead letters ----
  app.get('/v1/queue/queues/:queue/messages', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const config = await getQueue(tenant, name);
    if (!config) return res.status(404).json({ error: 'not_found', message: `queue '${name}' not found` });
    const limit = intOrThrow(req.query.limit, 'limit', 1, 500, 100);
    let messages = await peekMessages(tenant, name, limit);
    if (bool(req.query.ready)) {
      const now = Date.now();
      messages = messages.filter((m) => m.available_at !== undefined && m.available_at <= now);
    }
    res.json({ queue: name, count: messages.length, messages: messages.map(apiMessage) });
  });

  app.get('/v1/queue/queues/:queue/dead', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const config = await getQueue(tenant, name);
    if (!config) return res.status(404).json({ error: 'not_found', message: `queue '${name}' not found` });
    const limit = intOrThrow(req.query.limit, 'limit', 1, 500, 100);
    const messages = await deadMessages(tenant, name, limit);
    res.json({ queue: name, count: messages.length, messages: messages.map(apiMessage) });
  });

  app.post('/v1/queue/queues/:queue/dead/:id/replay', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const id = cleanMessageIdOrThrow(req.params.id);
    const body = bodyOf(req);
    const message = await replayDeadMessage(tenant, name, id, {
      delaySeconds: delayOrThrow(body.delaySeconds),
      resetAttempts: bool(body.resetAttempts),
    });
    if (!message) return res.status(404).json({ error: 'dead_message_not_found', message: `dead message '${id}' not found` });
    res.json({ ok: true, queue: name, message: apiMessage(message) });
  });

  app.delete('/v1/queue/queues/:queue/dead/:id', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanQueueOrThrow(req.params.queue);
    const id = cleanMessageIdOrThrow(req.params.id);
    res.json({ queue: name, id, deleted: await deleteDeadMessage(tenant, name, id) });
  });

  // Final error handler.
  app.use((e: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (e?.type === 'entity.parse.failed' || (e instanceof SyntaxError && /JSON/i.test(String(e?.message)))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (e?.type === 'entity.too.large' || e?.status === 413) {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    if (e instanceof RequestError || e instanceof QueueError) {
      const mapped = toApiError(e);
      return res.status(mapped.status).json(mapped.body);
    }
    if (e?.status === 400) return res.status(400).json({ error: 'bad_request', message: 'malformed request' });
    console.error('[queue] unhandled:', e?.message || e);
    res.status(500).json({ error: 'internal', message: 'unexpected error' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  initStore()
    .then((ok) => {
      if (!ok && IS_PROD) {
        console.error('[queue] Redis is required in production');
        process.exit(1);
      }
    })
    .finally(() => {
      app.listen(PORT, () => console.log(`[queue] SynapseQueue listening on :${PORT} (backend=${useRedis() ? 'redis' : 'memory'})`));
    });

  const shutdown = async () => {
    await closeStore();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
