/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Synapse Faststore — tenant-scoped cache and data-structure service backed by
 * Redis (in-memory fallback for dev/test). It exposes string keys with TTL and
 * NX/XX semantics, atomic counters, hashes, lists, sets, sorted sets, batch
 * operations, key scanning and distributed locks.
 *
 * Auth matches the rest of the platform: gateway-stamped x-synapseone-* headers
 * and the shared SYNAPSEONE_INTERNAL_SECRET for direct service-to-service calls.
 */
import './env-compat';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import {
  FaststoreError, useRedis, initStore, closeStore,
  setValue, getValue, deleteKey, expireKey, ttlKey, incrValue, scanKeys, tenantStats,
  hSetFields, hGetAll, hGetField, hDelField, hIncrField, hLen,
  lPush, lPop, lRange, lLen, lTrim,
  sAdd, sRem, sMembers, sIsMember, sCard,
  zAdd, zRem, zRange, zScore, zRank, zIncrBy, zCard,
  acquireLock, releaseLock, extendLock, newLockToken, ZMember,
} from './store';

dotenv.config();
const PORT = Number(process.env.PORT || 4006);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_KEY_LENGTH = 512;
const MAX_FIELD_LENGTH = 256;
const MAX_BATCH_OPS = 100;

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
    // Accept the legacy x-synapsedx-* prefix during the rebrand window.
    const legacy = n.startsWith('x-synapseone-') ? n.replace('x-synapseone-', 'x-synapsedx-') : n;
    const v = req.headers[n] ?? req.headers[legacy];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  const user = h('x-synapseone-user');
  if (user) {
    if (user.length > 128) return null;
    return { sub: user, org: clean(h('x-synapseone-org')), account: clean(h('x-synapseone-account')), kind: clean(h('x-synapseone-kind')) };
  }
  // API keys are machine identities: the gateway stamps kind=apikey + account
  // but no user (keys carry no user claim). Without this fallback they would
  // look unauthenticated and fall through to `platform` — a cross-tenant
  // superuser. Any tenant marker means "authenticated principal", never
  // internal/platform; synthesize a non-user subject so scoping applies.
  const kind = clean(h('x-synapseone-kind'));
  const account = clean(h('x-synapseone-account'));
  const org = clean(h('x-synapseone-org'));
  if (kind || account || org) {
    return { sub: account ? `apikey:${account}` : `${kind || 'principal'}:unknown`, org, account, kind: kind || 'apikey' };
  }
  return null;
}

export function resolveCaller(req: express.Request): Caller {
  const p = principalFromHeaders(req);
  if (p) return { kind: 'principal', principal: p };
  const raw = (req.headers['x-synapseone-anon'] ?? req.headers['x-synapsedx-anon']);
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

/** Tenant key namespace: org-wide when present, else account-wide, else per user. */
function tenantFor(req: express.Request): string | null {
  const caller = resolveCaller(req);
  if (caller.kind === 'principal') {
    const p = caller.principal!;
    if (p.org) return `org:${p.org}`;
    if (p.account) return `account:${p.account}`;
    return `user:${p.sub}`;
  }
  if (caller.kind === 'platform') {
    const header = (req.headers['x-synapseone-tenant'] ?? req.headers['x-synapsedx-tenant']);
    const raw = Array.isArray(header) ? header[0] : header;
    const t = cleanTenant(raw || req.query.tenant);
    return t ? `tenant:${t}` : null;
  }
  return null;
}

function requireTenant(req: express.Request, res: express.Response): string | null {
  const caller = resolveCaller(req);
  if (caller.kind === 'anon') {
    res.status(401).json({ error: 'auth_required', message: 'Synapse Faststore requires an authenticated caller' });
    return null;
  }
  const tenant = tenantFor(req);
  if (!tenant) {
    res.status(400).json({ error: 'tenant_required', message: 'platform callers must pass x-synapseone-tenant or ?tenant=' });
    return null;
  }
  return tenant;
}

function cleanKeyOrThrow(v: unknown): string {
  const s = String(v ?? '');
  if (!s || s.length > MAX_KEY_LENGTH || /[\r\n\x00-\x1F\x7F/\\]/.test(s)) {
    throw new RequestError(400, 'invalid_key', `key must be 1..${MAX_KEY_LENGTH} printable characters without '/' or '\\\\'`);
  }
  return s;
}

function cleanFieldOrThrow(v: unknown): string {
  const s = String(v ?? '');
  if (!s || s.length > MAX_FIELD_LENGTH || /[\r\n\x00-\x1F\x7F]/.test(s)) {
    throw new RequestError(400, 'invalid_field', `field must be 1..${MAX_FIELD_LENGTH} printable characters`);
  }
  return s;
}

function cleanLockNameOrThrow(v: unknown): string {
  const s = String(v ?? '');
  if (!s || s.length > 256 || /[\r\n\x00-\x1F\x7F/\\]/.test(s)) {
    throw new RequestError(400, 'invalid_lock_name', 'lock name must be 1..256 printable characters without \'/\' or \'\\\\\'');
  }
  return s;
}

function ttlOrThrow(v: unknown, opts: { allowZero?: boolean } = {}): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  const min = opts.allowZero ? 0 : 1;
  if (!Number.isInteger(n) || n < min || n > MAX_TTL_SECONDS) {
    throw new RequestError(400, 'invalid_ttl', `ttlSeconds must be an integer ${min}..${MAX_TTL_SECONDS}`);
  }
  return n;
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

function valuesObjectOrThrow(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new RequestError(400, 'invalid_request', 'values must be an object of field/value pairs');
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length || entries.length > 500) {
    throw new RequestError(400, 'invalid_request', 'values must contain 1..500 fields');
  }
  for (const [f] of entries) cleanFieldOrThrow(f);
  return v as Record<string, unknown>;
}

function writeOptions(body: Record<string, any>): { ttlSeconds?: number; ifNotExists?: boolean; ifExists?: boolean } {
  if (bool(body.ifNotExists) && bool(body.ifExists)) {
    throw new RequestError(400, 'invalid_request', 'use either ifNotExists or ifExists, not both');
  }
  return {
    ttlSeconds: ttlOrThrow(body.ttlSeconds, { allowZero: true }),
    ifNotExists: bool(body.ifNotExists),
    ifExists: bool(body.ifExists),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toApiError(e: any): { status: number; body: any } {
  if (e instanceof RequestError) return { status: e.status, body: { error: e.code, message: e.message } };
  if (e instanceof FaststoreError) {
    const status = e.code === 'not_found' ? 404
      : e.code === 'key_exists' || e.code === 'wrong_type' ? 409
        : e.code === 'storage_unavailable' ? 503
          : 400;
    return { status, body: { error: e.code, message: e.message } };
  }
  return { status: 500, body: { error: 'internal', message: 'unexpected error' } };
}

export function createApp(): express.Express {
  if (IS_PROD) {
    if (!process.env.SYNAPSEONE_INTERNAL_SECRET) {
      throw new Error('[faststore] SYNAPSEONE_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.FASTSTORE_REDIS_URL && !process.env.REDIS_URL) {
      throw new Error('[faststore] FASTSTORE_REDIS_URL/REDIS_URL must be set in production (in-memory fallback would split-brain)');
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
      console.warn('[faststore][security] CORS_ORIGIN not set — allowing all origins (dev default).');
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
  app.use(express.json({ limit: '2mb' }));

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
      '# HELP synapseone_faststore_up Synapse Faststore service up.',
      '# TYPE synapseone_faststore_up gauge',
      'synapseone_faststore_up 1',
      '# HELP synapseone_faststore_backend_info Active backend (1 = active).',
      '# TYPE synapseone_faststore_backend_info gauge',
      `synapseone_faststore_backend_info{backend="${useRedis() ? 'redis' : 'memory'}"} 1`,
      '# HELP synapseone_faststore_process_uptime_seconds Process uptime in seconds.',
      '# TYPE synapseone_faststore_process_uptime_seconds gauge',
      `synapseone_faststore_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '# HELP synapseone_faststore_http_requests_total HTTP requests by key = method|route|status.',
      '# TYPE synapseone_faststore_http_requests_total counter',
      ...[...METRIC_REQUESTS.entries()].map(([k, v]) => `synapseone_faststore_http_requests_total{key="${k}"} ${v}`),
    ];
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Internal secret gate: every /v1/* call must carry it when configured.
  const INTERNAL_SECRET = process.env.SYNAPSEONE_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[faststore][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default).');
  }
  app.use('/v1/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!INTERNAL_SECRET) {
      if (IS_PROD) return res.status(500).json({ error: 'misconfigured', message: 'internal secret required in production' });
      return next();
    }
    const raw = (req.headers['x-synapseone-internal'] ?? req.headers['x-synapsedx-internal']) as string | string[] | undefined;
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
      status: 'ok', service: 'faststore', version: VERSION,
      backend: useRedis() ? 'redis' : 'memory', time: new Date().toISOString(),
    });
  });

  // ---- stats and scans ----
  app.get('/v1/faststore/stats', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const stats = await tenantStats(tenant);
    res.json({ backend: useRedis() ? 'redis' : 'memory', tenant: tenant.split(':').slice(0, 2).join(':'), ...stats });
  });

  app.get('/v1/faststore/keys', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const prefix = req.query.prefix === undefined ? '' : String(req.query.prefix);
    if (prefix.length > 256) throw new RequestError(400, 'invalid_prefix', 'prefix must be at most 256 characters');
    const limit = intOrThrow(req.query.limit, 'limit', 1, 500, 100);
    const cursor = req.query.cursor === undefined ? undefined : String(req.query.cursor);
    if (cursor !== undefined && (!/^\d{1,9}$/.test(cursor))) {
      throw new RequestError(400, 'invalid_cursor', 'cursor must be a non-negative integer');
    }
    const result = await scanKeys(tenant, { prefix, limit, cursor });
    res.json(result);
  });

  // ---- key/value ----
  app.get('/v1/faststore/keys/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const found = await getValue(tenant, key);
    if (!found) return res.status(404).json({ error: 'not_found', message: `key '${key}' not found` });
    res.json({ key, ...found });
  });

  const putKey = async (req: express.Request, res: express.Response) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
      throw new RequestError(400, 'invalid_request', 'value is required');
    }
    const result = await setValue(tenant, key, body.value, writeOptions(body));
    res.status(result.created ? 201 : 200).json({ ok: true, key, created: result.created });
  };
  app.put('/v1/faststore/keys/:key', putKey);
  app.post('/v1/faststore/keys/:key', putKey);

  app.delete('/v1/faststore/keys/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, deleted: await deleteKey(tenant, key) });
  });

  app.get('/v1/faststore/keys/:key/ttl', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const ttl = await ttlKey(tenant, key);
    if (ttl === null) return res.status(404).json({ error: 'not_found', message: `key '${key}' not found` });
    res.json({ key, ttlSeconds: ttl });
  });

  app.post('/v1/faststore/keys/:key/expire', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    if (body.ttlSeconds === undefined) throw new RequestError(400, 'invalid_ttl', 'ttlSeconds is required');
    const ttlSeconds = ttlOrThrow(body.ttlSeconds, { allowZero: true })!;
    const ok = await expireKey(tenant, key, ttlSeconds);
    if (!ok) return res.status(404).json({ error: 'not_found', message: `key '${key}' not found` });
    res.json({ ok: true, key, ttlSeconds });
  });

  app.post('/v1/faststore/keys/:key/incr', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const by = intOrThrow(body.by, 'by', -1_000_000_000, 1_000_000_000, 1);
    const ttlSeconds = ttlOrThrow(body.ttlSeconds, { allowZero: true });
    const value = await incrValue(tenant, key, by, ttlSeconds);
    res.json({ key, value });
  });

  // ---- batch (key/value operations) ----
  app.post('/v1/faststore/batch', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const body = bodyOf(req);
    const operations = arrayOrThrow(body.operations, 'operations', 1, MAX_BATCH_OPS);
    const results: any[] = [];
    for (const raw of operations) {
      const opName = typeof raw?.op === 'string' ? raw.op : 'unknown';
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestError(400, 'invalid_operation', 'operation must be an object');
        const key = cleanKeyOrThrow(raw.key);
        if (opName === 'set') {
          if (!Object.prototype.hasOwnProperty.call(raw, 'value')) throw new RequestError(400, 'invalid_request', 'value is required');
          const r = await setValue(tenant, key, raw.value, writeOptions(raw));
          results.push({ ok: true, op: 'set', key, created: r.created });
        } else if (opName === 'get') {
          const r = await getValue(tenant, key);
          results.push(r
            ? { ok: true, op: 'get', key, found: true, type: r.type, value: r.value, ttlSeconds: r.ttlSeconds }
            : { ok: true, op: 'get', key, found: false });
        } else if (opName === 'delete') {
          results.push({ ok: true, op: 'delete', key, deleted: await deleteKey(tenant, key) });
        } else if (opName === 'incr') {
          const by = intOrThrow(raw.by, 'by', -1_000_000_000, 1_000_000_000, 1);
          results.push({ ok: true, op: 'incr', key, value: await incrValue(tenant, key, by, ttlOrThrow(raw.ttlSeconds, { allowZero: true })) });
        } else if (opName === 'expire') {
          const ttlSeconds = ttlOrThrow(raw.ttlSeconds, { allowZero: true })!;
          if (ttlSeconds === undefined) throw new RequestError(400, 'invalid_ttl', 'ttlSeconds is required');
          results.push({ ok: true, op: 'expire', key, expired: await expireKey(tenant, key, ttlSeconds) });
        } else {
          results.push({ ok: false, op: opName, key, error: 'unsupported_op' });
        }
      } catch (e: any) {
        const mapped = toApiError(e);
        results.push({ ok: false, op: opName, error: mapped.body.error, message: mapped.body.message });
      }
    }
    res.json({ results, ok: results.every((r) => r.ok) });
  });

  // ---- hashes ----
  app.get('/v1/faststore/hashes/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const found = await hGetAll(tenant, key);
    if (!found) return res.status(404).json({ error: 'not_found', message: `hash '${key}' not found` });
    res.json({ key, ...found });
  });

  app.put('/v1/faststore/hashes/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const values = valuesObjectOrThrow(body.values);
    const result = await hSetFields(tenant, key, values, writeOptions(body));
    res.status(result.created ? 201 : 200).json({ ok: true, key, created: result.created });
  });

  app.delete('/v1/faststore/hashes/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, deleted: await deleteKey(tenant, key) });
  });

  app.get('/v1/faststore/hashes/:key/length', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, length: await hLen(tenant, key) });
  });

  app.get('/v1/faststore/hashes/:key/:field', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const field = cleanFieldOrThrow(req.params.field);
    const found = await hGetField(tenant, key, field);
    if (!found.found) return res.status(404).json({ error: 'not_found', message: `field '${field}' not found` });
    res.json({ key, field, value: found.value, ttlSeconds: found.ttlSeconds });
  });

  app.put('/v1/faststore/hashes/:key/:field', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const field = cleanFieldOrThrow(req.params.field);
    const body = bodyOf(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'value')) throw new RequestError(400, 'invalid_request', 'value is required');
    const result = await hSetFields(tenant, key, { [field]: body.value }, { ttlSeconds: ttlOrThrow(body.ttlSeconds, { allowZero: true }) });
    res.status(result.created ? 201 : 200).json({ ok: true, key, field });
  });

  app.delete('/v1/faststore/hashes/:key/:field', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const field = cleanFieldOrThrow(req.params.field);
    res.json({ key, field, deleted: await hDelField(tenant, key, field) });
  });

  app.post('/v1/faststore/hashes/:key/incr', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const field = cleanFieldOrThrow(body.field);
    const by = intOrThrow(body.by, 'by', -1_000_000_000, 1_000_000_000, 1);
    const value = await hIncrField(tenant, key, field, by, ttlOrThrow(body.ttlSeconds, { allowZero: true }));
    res.json({ key, field, value });
  });

  // ---- lists ----
  app.get('/v1/faststore/lists/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const start = intOrThrow(req.query.start, 'start', -1_000_000, 1_000_000, 0);
    const stop = intOrThrow(req.query.stop, 'stop', -1_000_000, 1_000_000, -1);
    const values = await lRange(tenant, key, start, stop);
    res.json({ key, values, length: await lLen(tenant, key) });
  });

  app.delete('/v1/faststore/lists/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, deleted: await deleteKey(tenant, key) });
  });

  app.post('/v1/faststore/lists/:key/push', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const values = arrayOrThrow(body.values, 'values', 1, 1000);
    const side = body.side === undefined ? 'right' : String(body.side);
    if (side !== 'left' && side !== 'right') throw new RequestError(400, 'invalid_request', "side must be 'left' or 'right'");
    const length = await lPush(tenant, key, values, side, ttlOrThrow(body.ttlSeconds, { allowZero: true }));
    res.json({ ok: true, key, side, length });
  });

  app.post('/v1/faststore/lists/:key/pop', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const side = body.side === undefined ? 'left' : String(body.side);
    if (side !== 'left' && side !== 'right') throw new RequestError(400, 'invalid_request', "side must be 'left' or 'right'");
    const count = intOrThrow(body.count, 'count', 1, 1000, 1);
    const values = await lPop(tenant, key, side, count);
    res.json({ key, side, values, length: await lLen(tenant, key) });
  });

  app.post('/v1/faststore/lists/:key/trim', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const start = intOrThrow(body.start, 'start', -1_000_000, 1_000_000, 0);
    const stop = intOrThrow(body.stop, 'stop', -1_000_000, 1_000_000, -1);
    res.json({ ok: await lTrim(tenant, key, start, stop), key, start, stop });
  });

  app.get('/v1/faststore/lists/:key/length', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, length: await lLen(tenant, key) });
  });

  // ---- sets ----
  app.get('/v1/faststore/sets/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const members = await sMembers(tenant, key);
    res.json({ key, members, card: members.length });
  });

  app.delete('/v1/faststore/sets/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, deleted: await deleteKey(tenant, key) });
  });

  app.post('/v1/faststore/sets/:key/add', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const members = arrayOrThrow(body.members, 'members', 1, 1000);
    const added = await sAdd(tenant, key, members, ttlOrThrow(body.ttlSeconds, { allowZero: true }));
    res.json({ ok: true, key, added, card: await sCard(tenant, key) });
  });

  app.post('/v1/faststore/sets/:key/remove', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const members = arrayOrThrow(body.members, 'members', 1, 1000);
    res.json({ key, removed: await sRem(tenant, key, members), card: await sCard(tenant, key) });
  });

  app.post('/v1/faststore/sets/:key/contains', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'member')) throw new RequestError(400, 'invalid_request', 'member is required');
    res.json({ key, member: body.member, contains: await sIsMember(tenant, key, body.member) });
  });

  app.get('/v1/faststore/sets/:key/card', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, card: await sCard(tenant, key) });
  });

  // ---- sorted sets ----
  app.get('/v1/faststore/zsets/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const start = intOrThrow(req.query.start, 'start', -1_000_000, 1_000_000, 0);
    const stop = intOrThrow(req.query.stop, 'stop', -1_000_000, 1_000_000, -1);
    const withScores = bool(req.query.withScores);
    const members = await zRange(tenant, key, start, stop, { rev: bool(req.query.rev), withScores });
    res.json({ key, members, card: await zCard(tenant, key) });
  });

  app.delete('/v1/faststore/zsets/:key', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, deleted: await deleteKey(tenant, key) });
  });

  app.post('/v1/faststore/zsets/:key/add', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const raw = arrayOrThrow(body.members, 'members', 1, 1000) as any[];
    const members: ZMember[] = raw.map((m) => {
      if (!m || typeof m !== 'object' || Array.isArray(m) || !Object.prototype.hasOwnProperty.call(m, 'member')) {
        throw new RequestError(400, 'invalid_request', 'each member must be {member, score}');
      }
      const score = Number(m.score);
      if (!Number.isFinite(score)) throw new RequestError(400, 'invalid_request', 'score must be a finite number');
      return { member: m.member, score };
    });
    const added = await zAdd(tenant, key, members, ttlOrThrow(body.ttlSeconds, { allowZero: true }));
    res.json({ ok: true, key, added, card: await zCard(tenant, key) });
  });

  app.post('/v1/faststore/zsets/:key/incr', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'member')) throw new RequestError(400, 'invalid_request', 'member is required');
    const by = Number(body.by === undefined ? 1 : body.by);
    if (!Number.isFinite(by)) throw new RequestError(400, 'invalid_request', 'by must be a finite number');
    const score = await zIncrBy(tenant, key, body.member, by, ttlOrThrow(body.ttlSeconds, { allowZero: true }));
    res.json({ key, member: body.member, score });
  });

  app.post('/v1/faststore/zsets/:key/remove', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    const members = arrayOrThrow(body.members, 'members', 1, 1000);
    res.json({ key, removed: await zRem(tenant, key, members), card: await zCard(tenant, key) });
  });

  app.post('/v1/faststore/zsets/:key/score', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'member')) throw new RequestError(400, 'invalid_request', 'member is required');
    res.json({ key, member: body.member, score: await zScore(tenant, key, body.member) });
  });

  app.post('/v1/faststore/zsets/:key/rank', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    const body = bodyOf(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'member')) throw new RequestError(400, 'invalid_request', 'member is required');
    res.json({ key, member: body.member, rank: await zRank(tenant, key, body.member, bool(body.rev)) });
  });

  app.get('/v1/faststore/zsets/:key/card', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const key = cleanKeyOrThrow(req.params.key);
    res.json({ key, card: await zCard(tenant, key) });
  });

  // ---- distributed locks ----
  app.post('/v1/faststore/locks/:name/acquire', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanLockNameOrThrow(req.params.name);
    const body = bodyOf(req);
    const ttlSeconds = ttlOrThrow(body.ttlSeconds === undefined ? 30 : body.ttlSeconds, { allowZero: false })!;
    const waitMs = intOrThrow(body.waitMs, 'waitMs', 0, 10_000, 0);
    const token = body.token === undefined ? newLockToken() : String(body.token);
    if (!token || token.length > 256 || /[\r\n]/.test(token)) throw new RequestError(400, 'invalid_token', 'token must be 1..256 characters');
    const deadline = Date.now() + waitMs;
    let acquired = await acquireLock(tenant, name, token, ttlSeconds * 1000);
    while (!acquired && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      acquired = await acquireLock(tenant, name, token, ttlSeconds * 1000);
    }
    if (!acquired) {
      return res.json({ acquired: false, lock: name, retryAfterMs: 50, ttlSeconds });
    }
    res.json({ acquired: true, lock: name, token, ttlSeconds, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() });
  });

  app.post('/v1/faststore/locks/:name/release', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanLockNameOrThrow(req.params.name);
    const body = bodyOf(req);
    const token = String(body.token ?? '');
    if (!token) throw new RequestError(400, 'invalid_token', 'token is required');
    res.json({ lock: name, released: await releaseLock(tenant, name, token) });
  });

  app.post('/v1/faststore/locks/:name/extend', async (req, res) => {
    const tenant = requireTenant(req, res);
    if (!tenant) return;
    const name = cleanLockNameOrThrow(req.params.name);
    const body = bodyOf(req);
    const token = String(body.token ?? '');
    if (!token) throw new RequestError(400, 'invalid_token', 'token is required');
    const ttlSeconds = ttlOrThrow(body.ttlSeconds === undefined ? 30 : body.ttlSeconds, { allowZero: false })!;
    res.json({ lock: name, extended: await extendLock(tenant, name, token, ttlSeconds * 1000) });
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
    if (e instanceof RequestError || e instanceof FaststoreError) {
      const mapped = toApiError(e);
      return res.status(mapped.status).json(mapped.body);
    }
    if (e?.status === 400) return res.status(400).json({ error: 'bad_request', message: 'malformed request' });
    console.error('[faststore] unhandled:', e?.message || e);
    res.status(500).json({ error: 'internal', message: 'unexpected error' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  initStore()
    .then((ok) => {
      if (!ok && IS_PROD) {
        console.error('[faststore] Redis is required in production');
        process.exit(1);
      }
    })
    .finally(() => {
      app.listen(PORT, () => console.log(`[faststore] Synapse Faststore listening on :${PORT} (backend=${useRedis() ? 'redis' : 'memory'})`));
    });

  const shutdown = async () => {
    await closeStore();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
