/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseBase — self-managed document database (Firebase-like) with
 * collections, typed object<->data mapping, queries, optimistic versions,
 * atomic counters, batch writes and a change feed.
 *
 * Postgres persistence with in-memory fallback (dev/test). Internal-service
 * auth matches the rest of the platform: gateway-stamped x-synapsedx-* headers
 * plus the shared SYNAPSEDX_INTERNAL_SECRET on direct calls.
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import {
  createCollectionRec, findCollectionRec, getCollectionRec, listCollectionRecs, updateCollectionRec, deleteCollectionRec,
  createDocumentRec, getDocumentRec, listDocumentRecs, setDocumentRec, deleteDocumentRec, incrementDocumentRec,
  documentStatsRec, ensureTables, useDb, StoreError, StoredCollection,
} from './store';
import {
  normalizeMapping, hasMapping, objectToData, dataToObject, normalizeDocumentData, validateDocumentData,
  validateDataAgainstMapping, deepMerge, unsetPath, cloneJson, MappingError, BaseMapping,
} from './mapping';
import { parseQuerySpec, applyQuery, parseVectorSearchSpec, applyVectorSearch, QueryError } from './query';

dotenv.config();
const PORT = Number(process.env.PORT || 4005);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_DOCUMENT_BYTES = Math.min(Math.max(Number(process.env.BASE_MAX_DOCUMENT_BYTES || 262144), 1024), 4 * 1024 * 1024);
const QUERY_SCAN_LIMIT = Math.min(Math.max(Number(process.env.BASE_QUERY_SCAN_LIMIT || 10000), 100), 100000);

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
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  const user = h('x-synapsedx-user');
  if (user) {
    if (user.length > 128) return null;
    return { sub: user, org: clean(h('x-synapsedx-org')), account: clean(h('x-synapsedx-account')), kind: clean(h('x-synapsedx-kind')) };
  }
  // API keys are machine identities: the gateway stamps kind=apikey + account
  // but no user (keys carry no user claim). Without this fallback they would
  // look unauthenticated and fall through to `platform` — a cross-tenant
  // superuser. Any tenant marker means "authenticated principal", never
  // internal/platform; synthesize a non-user subject so scoping applies.
  const kind = clean(h('x-synapsedx-kind'));
  const account = clean(h('x-synapsedx-account'));
  const org = clean(h('x-synapsedx-org'));
  if (kind || account || org) {
    return { sub: account ? `apikey:${account}` : `${kind || 'principal'}:unknown`, org, account, kind: kind || 'apikey' };
  }
  return null;
}

export function resolveCaller(req: express.Request): Caller {
  const p = principalFromHeaders(req);
  if (p) return { kind: 'principal', principal: p };
  const raw = req.headers['x-synapsedx-anon'];
  const anon = (Array.isArray(raw) ? raw[0] : raw) === '1';
  return anon ? { kind: 'anon', principal: null } : { kind: 'platform', principal: null };
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DOC_ID_RE = /^[A-Za-z0-9_@.:+-]{1,256}$/;

function cleanName(v: unknown): string | null {
  const s = String(v || '');
  return NAME_RE.test(s) ? s : null;
}

function cleanDocId(v: unknown): string | null {
  const s = String(v ?? '');
  if (!s || s.length > 256 || s === '.' || s === '..' || /[\r\n/\\]/.test(s)) return null;
  return DOC_ID_RE.test(s) ? s : null;
}

function cleanTenant(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function toApiCollection(c: StoredCollection): any {
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? undefined,
    mapping: c.mapping,
    orgId: c.org_id ?? undefined,
    accountId: c.account_id ?? undefined,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function toApiDocument(d: { id: string; data: Record<string, unknown>; version: number; created_at: string; updated_at: string }, as: 'data' | 'object', mapping: BaseMapping): any {
  return {
    id: d.id,
    ...(as === 'object' ? { object: dataToObject(d.data, mapping) } : { data: d.data }),
    version: d.version,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Collection visibility: platform = all; org-bound = same org; account-bound = same account. */
function canAccessCollection(c: StoredCollection, caller: Caller): boolean {
  if (caller.kind === 'platform') return true;
  if (caller.kind !== 'principal') return false;
  const p = caller.principal!;
  if (c.org_id) return !!p.org && p.org === c.org_id;
  if (c.account_id) return !!p.account && p.account === c.account_id;
  return false;
}

function collectionScope(caller: Caller, req: express.Request): { org_id?: string | null; account_id?: string | null; platform?: boolean } {
  if (caller.kind === 'platform') {
    const q = req.query as any;
    const org = cleanTenant(q.orgId);
    const acc = cleanTenant(q.accountId);
    if (org || acc) return { org_id: org, account_id: acc, platform: false };
    return { platform: true };
  }
  const p = caller.principal!;
  return p.org ? { org_id: p.org, account_id: p.account ?? null } : { org_id: null, account_id: p.account ?? null };
}

function etagVersion(req: express.Request, body?: any): number | undefined {
  const raw = req.headers['if-match'] ?? body?.ifVersion;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 0) throw new QueryError('ifVersion must be a non-negative integer');
  return n;
}

function parseDataBody(
  body: any,
  mapping: BaseMapping,
  opts: { partial?: boolean } = {},
): Record<string, unknown> {
  const b = body || {};
  const hasData = b.data !== undefined;
  const hasObject = b.object !== undefined;
  if (hasData === hasObject) throw new MappingError('provide exactly one of data or object');
  if (hasObject) return objectToData(b.object, mapping, { partial: opts.partial });
  if (opts.partial) {
    const data = validateDocumentData(b.data, MAX_DOCUMENT_BYTES);
    validateDataAgainstMapping(data, mapping, { partial: true });
    return data;
  }
  return normalizeDocumentData(b.data, mapping, MAX_DOCUMENT_BYTES);
}

export function createApp(): express.Express {
  if (IS_PROD) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[base] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[base] DATABASE_URL must be set in production (in-memory fallback would split-brain)');
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
      console.warn('[base][security] CORS_ORIGIN not set — allowing all origins (dev default).');
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
  app.get('/metrics', async (_req, res) => {
    const lines: string[] = [
      '# HELP synapsedx_base_up SynapseBase service up.',
      '# TYPE synapsedx_base_up gauge',
      'synapsedx_base_up 1',
      '# HELP synapsedx_base_process_uptime_seconds Process uptime in seconds.',
      '# TYPE synapsedx_base_process_uptime_seconds gauge',
      `synapsedx_base_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '# HELP synapsedx_base_http_requests_total HTTP requests by key = method|route|status.',
      '# TYPE synapsedx_base_http_requests_total counter',
      ...[...METRIC_REQUESTS.entries()].map(([k, v]) => `synapsedx_base_http_requests_total{key="${k}"} ${v}`),
    ];
    try {
      const collections = await listCollectionRecs();
      lines.push(
        '# HELP synapsedx_base_collections_total Collection count.',
        '# TYPE synapsedx_base_collections_total gauge',
        `synapsedx_base_collections_total ${collections.length}`,
      );
    } catch { /* scrape never fails on db blips */ }
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Internal secret gate: every /v1/* call must carry it when configured.
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[base][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default).');
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

  app.get('/health', async (_req, res) => {
    let collections = 0;
    try { collections = (await listCollectionRecs()).length; } catch { /* health never fails on db */ }
    res.json({
      status: 'ok', service: 'base', version: VERSION, db: useDb() ? 'postgres' : 'memory',
      collections, time: new Date().toISOString(),
    });
  });

  /** Resolve collection + caller or write the error response. */
  async function loadCollection(req: express.Request, res: express.Response): Promise<{ collection: StoredCollection; caller: Caller } | null> {
    const caller = resolveCaller(req);
    if (caller.kind === 'anon') {
      res.status(401).json({ error: 'auth_required', message: 'SynapseBase requires an authenticated caller' });
      return null;
    }
    const name = cleanName(req.params.collection);
    if (!name) {
      res.status(400).json({ error: 'invalid_collection', message: 'collection must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
      return null;
    }
    let collection: StoredCollection | null;
    try {
      collection = await findCollectionRec(name, collectionScope(caller, req));
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'conflict') {
        res.status(409).json({ error: 'ambiguous_collection', message: e.message });
        return null;
      }
      throw e;
    }
    if (!collection || !canAccessCollection(collection, caller)) {
      res.status(404).json({ error: 'not_found', message: `collection '${name}' not found` });
      return null;
    }
    return { collection, caller };
  }

  // ---- collections ----
  app.get('/v1/base/collections', async (req, res) => {
    const caller = resolveCaller(req);
    if (caller.kind === 'anon') return res.status(401).json({ error: 'auth_required', message: 'SynapseBase requires an authenticated caller' });
    const q = req.query as any;
    let cols = (await listCollectionRecs()).filter((c) => canAccessCollection(c, caller));
    if (typeof q.orgId === 'string' && q.orgId) cols = cols.filter((c) => (c.org_id || '') === q.orgId);
    if (typeof q.accountId === 'string' && q.accountId) cols = cols.filter((c) => (c.account_id || '') === q.accountId);
    res.json(cols.map(toApiCollection));
  });

  app.post('/v1/base/collections', async (req, res) => {
    const caller = resolveCaller(req);
    if (caller.kind === 'anon') return res.status(401).json({ error: 'auth_required', message: 'SynapseBase requires an authenticated caller' });
    const p = caller.principal;
    const b = (req.body || {}) as any;
    const name = cleanName(b.name);
    if (!name) return res.status(400).json({ error: 'invalid_name', message: 'name must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
    if (b.description !== undefined && b.description !== null && String(b.description).length > 500) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    let mapping: BaseMapping;
    try {
      mapping = normalizeMapping(b.mapping);
    } catch (e: any) {
      if (e instanceof MappingError) return res.status(400).json({ error: 'invalid_mapping', message: e.message, details: e.details });
      throw e;
    }
    const bodyOrg = b.orgId !== undefined && b.orgId !== null && String(b.orgId) !== '' ? cleanTenant(b.orgId) : null;
    const bodyAcc = b.accountId !== undefined && b.accountId !== null && String(b.accountId) !== '' ? cleanTenant(b.accountId) : null;
    if ((b.orgId !== undefined && String(b.orgId) !== '' && bodyOrg === null) || (b.accountId !== undefined && String(b.accountId) !== '' && bodyAcc === null)) {
      return res.status(400).json({ error: 'invalid_tenant', message: 'orgId/accountId must be 1..128 chars' });
    }
    let reqOrg: string | null;
    let reqAcc: string | null;
    if (p?.org) {
      if (bodyOrg && bodyOrg !== p.org) return res.status(403).json({ error: 'cross_tenant', message: 'cannot create a collection outside your own org' });
      reqOrg = p.org;
      reqAcc = bodyAcc ?? p.account ?? null;
    } else if (p) {
      if (bodyOrg) return res.status(403).json({ error: 'cross_tenant', message: 'account-scoped principals cannot create org-bound collections' });
      if (bodyAcc && bodyAcc !== p.account) return res.status(403).json({ error: 'cross_tenant', message: 'cannot create a collection outside your own account' });
      reqOrg = null;
      reqAcc = p.account ?? null;
    } else {
      reqOrg = bodyOrg;
      reqAcc = bodyAcc;
    }
    try {
      const col = await createCollectionRec({
        name, description: b.description === undefined ? null : (b.description === null ? null : String(b.description)),
        mapping, org_id: reqOrg, account_id: reqAcc, created_by: p?.sub ?? null,
      });
      res.status(201).json(toApiCollection(col));
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'conflict') return res.status(409).json({ error: 'collection_exists', message: e.message });
      throw e;
    }
  });

  app.get('/v1/base/collections/:collection', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const stats = await documentStatsRec(loaded.collection.id);
    res.json({ ...toApiCollection(loaded.collection), stats });
  });

  app.patch('/v1/base/collections/:collection', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const b = (req.body || {}) as any;
    const patch: any = {};
    if (b.name !== undefined) {
      const name = cleanName(b.name);
      if (!name) return res.status(400).json({ error: 'invalid_name', message: 'name must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
      patch.name = name;
    }
    if (b.description !== undefined) {
      if (b.description !== null && String(b.description).length > 500) {
        return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
      }
      patch.description = b.description === null ? null : String(b.description);
    }
    if (b.mapping !== undefined) {
      try {
        patch.mapping = normalizeMapping(b.mapping);
      } catch (e: any) {
        if (e instanceof MappingError) return res.status(400).json({ error: 'invalid_mapping', message: e.message, details: e.details });
        throw e;
      }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'invalid_body', message: 'no updatable fields provided' });
    try {
      const updated = await updateCollectionRec(loaded.collection.id, patch);
      res.json(toApiCollection(updated!));
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'conflict') return res.status(409).json({ error: 'collection_exists', message: e.message });
      throw e;
    }
  });

  app.delete('/v1/base/collections/:collection', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    await deleteCollectionRec(loaded.collection.id);
    res.json({ ok: true, id: loaded.collection.id, name: loaded.collection.name });
  });

  app.get('/v1/base/collections/:collection/stats', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    res.json({ id: loaded.collection.id, name: loaded.collection.name, ...(await documentStatsRec(loaded.collection.id)) });
  });

  // ---- documents ----
  app.post('/v1/base/collections/:collection/documents', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const b = (req.body || {}) as any;
    let id: string;
    if (b.id !== undefined && b.id !== null && String(b.id) !== '') {
      const cleaned = cleanDocId(b.id);
      if (!cleaned) return res.status(400).json({ error: 'invalid_document_id', message: 'id must match [A-Za-z0-9_@.:+-]{1,256}' });
      id = cleaned;
    } else {
      id = randomUUID();
    }
    let data: Record<string, unknown>;
    try {
      data = parseDataBody(b, loaded.collection.mapping);
    } catch (e: any) {
      if (e instanceof MappingError) return res.status(400).json({ error: 'mapping_error', message: e.message, details: e.details });
      throw e;
    }
    try {
      const doc = await createDocumentRec(loaded.collection.id, id, data);
      res.status(201).json({ ...toApiDocument(doc, 'data', loaded.collection.mapping), collection: loaded.collection.name });
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'conflict') return res.status(409).json({ error: 'document_exists', message: e.message });
      throw e;
    }
  });

  app.get('/v1/base/collections/:collection/documents/:id', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const id = cleanDocId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_document_id' });
    const as = req.query.as === undefined ? 'data' : String(req.query.as);
    if (as !== 'data' && as !== 'object') return res.status(400).json({ error: 'invalid_view', message: "as must be 'data' or 'object'" });
    const doc = await getDocumentRec(loaded.collection.id, id);
    if (!doc) return res.status(404).json({ error: 'not_found', message: `document '${id}' not found` });
    res.json({ ...toApiDocument(doc, as, loaded.collection.mapping), collection: loaded.collection.name });
  });

  app.put('/v1/base/collections/:collection/documents/:id', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const id = cleanDocId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_document_id' });
    const b = (req.body || {}) as any;
    let data: Record<string, unknown>;
    try {
      data = parseDataBody(b, loaded.collection.mapping);
    } catch (e: any) {
      if (e instanceof MappingError) return res.status(400).json({ error: 'mapping_error', message: e.message, details: e.details });
      throw e;
    }
    let ifVersion: number | undefined;
    let merge: boolean;
    try {
      ifVersion = etagVersion(req, b);
      merge = b.merge === true;
    } catch (e: any) {
      return res.status(400).json({ error: 'invalid_version', message: e.message });
    }
    try {
      const out = await setDocumentRec(loaded.collection.id, id, data, { merge, ifVersion });
      res.status(out.created ? 201 : 200).json({ ...toApiDocument(out.doc, 'data', loaded.collection.mapping), collection: loaded.collection.name });
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'version_conflict') return res.status(409).json({ error: 'version_conflict', message: e.message });
      if (e instanceof StoreError && e.code === 'conflict') return res.status(409).json({ error: 'document_exists', message: e.message });
      throw e;
    }
  });

  // PATCH merges data (deep) and/or removes dot paths via `unset`.
  app.patch('/v1/base/collections/:collection/documents/:id', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const id = cleanDocId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_document_id' });
    const b = (req.body || {}) as any;
    const unset: string[] = Array.isArray(b.unset) ? b.unset.map((x: any) => String(x)).slice(0, 100) : [];
    if (!unset.every((p) => /^[A-Za-z_$][A-Za-z0-9_$.-]{0,255}$/.test(p) && !p.split('.').some((s) => ['__proto__', 'prototype', 'constructor'].includes(s)))) {
      return res.status(400).json({ error: 'invalid_unset', message: 'unset must contain valid dot paths' });
    }
    const hasData = b.data !== undefined || b.object !== undefined;
    if (!hasData && !unset.length) return res.status(400).json({ error: 'invalid_body', message: 'provide data/object and/or unset' });
    let patchData: Record<string, unknown> = {};
    if (hasData) {
      try {
        patchData = parseDataBody(b, loaded.collection.mapping, { partial: true });
      } catch (e: any) {
        if (e instanceof MappingError) return res.status(400).json({ error: 'mapping_error', message: e.message, details: e.details });
        throw e;
      }
    }
    let ifVersion: number | undefined;
    try {
      ifVersion = etagVersion(req, b);
    } catch (e: any) {
      return res.status(400).json({ error: 'invalid_version', message: e.message });
    }
    const cur = await getDocumentRec(loaded.collection.id, id);
    if (!cur) return res.status(404).json({ error: 'not_found', message: `document '${id}' not found` });
    if (ifVersion !== undefined && cur.version !== ifVersion) {
      return res.status(409).json({ error: 'version_conflict', message: `document version is ${cur.version}, expected ${ifVersion}` });
    }
    const next = deepMerge(cur.data, patchData);
    for (const path of unset) unsetPath(next, path);
    try {
      validateDataAgainstMapping(next, loaded.collection.mapping);
    } catch (e: any) {
      if (e instanceof MappingError) return res.status(400).json({ error: 'mapping_error', message: e.message });
      throw e;
    }
    const out = await setDocumentRec(loaded.collection.id, id, next, { merge: false, ifVersion: cur.version });
    res.json({ ...toApiDocument(out.doc, 'data', loaded.collection.mapping), collection: loaded.collection.name });
  });

  app.delete('/v1/base/collections/:collection/documents/:id', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const id = cleanDocId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_document_id' });
    let ifVersion: number | undefined;
    try {
      ifVersion = etagVersion(req, req.body || {});
      if (ifVersion === undefined && req.query.ifVersion !== undefined) {
        const n = Number(req.query.ifVersion);
        if (!Number.isInteger(n) || n < 0) throw new Error('ifVersion must be a non-negative integer');
        ifVersion = n;
      }
    } catch (e: any) {
      return res.status(400).json({ error: 'invalid_version', message: e.message });
    }
    try {
      const ok = await deleteDocumentRec(loaded.collection.id, id, { ifVersion });
      if (!ok) return res.status(404).json({ error: 'not_found', message: `document '${id}' not found` });
      res.json({ ok: true, id, collection: loaded.collection.name });
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'version_conflict') return res.status(409).json({ error: 'version_conflict', message: e.message });
      if (e instanceof StoreError && e.code === 'not_found') return res.status(404).json({ error: 'not_found', message: e.message });
      throw e;
    }
  });

  // ---- query (filter tree + ordering + cursor pagination) ----
  app.post('/v1/base/collections/:collection/query', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    let spec;
    try {
      spec = parseQuerySpec(req.body || {}, loaded.collection.mapping);
    } catch (e: any) {
      if (e instanceof QueryError) return res.status(400).json({ error: 'invalid_query', message: e.message });
      throw e;
    }
    const docs = await listDocumentRecs(loaded.collection.id, { scanLimit: QUERY_SCAN_LIMIT + 1 });
    if (docs.length > QUERY_SCAN_LIMIT) {
      return res.status(413).json({
        error: 'collection_too_large',
        message: `query scan limit is ${QUERY_SCAN_LIMIT} documents; narrow the collection or raise BASE_QUERY_SCAN_LIMIT`,
      });
    }
    const views = docs.map((d) => ({ id: d.id, data: d.data, version: d.version, created_at: d.created_at, updated_at: d.updated_at }));
    res.json(applyQuery(views, spec, loaded.collection.mapping));
  });

  // ---- vector search (semantic / similarity search) ----
  app.post('/v1/base/collections/:collection/vector-search', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    let spec;
    try {
      spec = parseVectorSearchSpec(req.body || {}, loaded.collection.mapping);
    } catch (e: any) {
      if (e instanceof QueryError) return res.status(400).json({ error: 'invalid_query', message: e.message });
      throw e;
    }
    const docs = await listDocumentRecs(loaded.collection.id, { scanLimit: QUERY_SCAN_LIMIT + 1 });
    if (docs.length > QUERY_SCAN_LIMIT) {
      return res.status(413).json({
        error: 'collection_too_large',
        message: `query scan limit is ${QUERY_SCAN_LIMIT} documents; narrow the collection or raise BASE_QUERY_SCAN_LIMIT`,
      });
    }
    const views = docs.map((d) => ({ id: d.id, data: d.data, version: d.version, created_at: d.created_at, updated_at: d.updated_at }));
    res.json(applyVectorSearch(views, spec, loaded.collection.mapping));
  });

  // ---- atomic increment ----
  app.post('/v1/base/collections/:collection/documents/:id/increment', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const id = cleanDocId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_document_id' });
    const b = (req.body || {}) as any;
    const field = String(b.field || '');
    if (!/^[A-Za-z_$][A-Za-z0-9_$.-]{0,255}$/.test(field) || field.split('.').some((s) => ['__proto__', 'prototype', 'constructor'].includes(s))) {
      return res.status(400).json({ error: 'invalid_field', message: 'field must be a valid dot path' });
    }
    const by = b.by === undefined ? 1 : Number(b.by);
    if (!Number.isFinite(by)) return res.status(400).json({ error: 'invalid_increment', message: 'by must be a finite number' });
    let ifVersion: number | undefined;
    try { ifVersion = etagVersion(req, b); } catch (e: any) { return res.status(400).json({ error: 'invalid_version', message: e.message }); }
    try {
      const doc = await incrementDocumentRec(loaded.collection.id, id, field, by, { ifVersion });
      res.json({ ...toApiDocument(doc, 'data', loaded.collection.mapping), collection: loaded.collection.name });
    } catch (e: any) {
      if (e instanceof StoreError && e.code === 'version_conflict') return res.status(409).json({ error: 'version_conflict', message: e.message });
      if (e instanceof StoreError && e.code === 'invalid') return res.status(400).json({ error: 'invalid_field', message: e.message });
      throw e;
    }
  });

  // ---- batch writes ----
  app.post('/v1/base/collections/:collection/documents:batch', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const ops = (req.body || {}).operations;
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) {
      return res.status(400).json({ error: 'invalid_batch', message: 'operations must contain 1..100 entries' });
    }
    const results: any[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] || {};
      try {
        if (op.op === 'create') {
          const id = op.id ? cleanDocId(op.id) : randomUUID();
          if (!id) throw new StoreError('invalid', 'invalid document id');
          const data = parseDataBody(op, loaded.collection.mapping);
          const doc = await createDocumentRec(loaded.collection.id, id, data);
          results.push({ index: i, ok: true, op: 'create', document: toApiDocument(doc, 'data', loaded.collection.mapping) });
        } else if (op.op === 'set' || op.op === 'update') {
          const id = cleanDocId(op.id);
          if (!id) throw new StoreError('invalid', 'id is required');
          const data = parseDataBody(op, loaded.collection.mapping, { partial: op.op === 'update' });
          const out = await setDocumentRec(loaded.collection.id, id, data, { merge: op.op === 'update' });
          results.push({ index: i, ok: true, op: op.op, created: out.created, document: toApiDocument(out.doc, 'data', loaded.collection.mapping) });
        } else if (op.op === 'delete') {
          const id = cleanDocId(op.id);
          if (!id) throw new StoreError('invalid', 'id is required');
          const ok = await deleteDocumentRec(loaded.collection.id, id, { ifVersion: op.ifVersion === undefined ? undefined : Number(op.ifVersion) });
          results.push({ index: i, ok, op: 'delete', id });
        } else if (op.op === 'increment') {
          const id = cleanDocId(op.id);
          if (!id) throw new StoreError('invalid', 'id is required');
          const doc = await incrementDocumentRec(loaded.collection.id, id, String(op.field || ''), Number(op.by ?? 1));
          results.push({ index: i, ok: true, op: 'increment', document: toApiDocument(doc, 'data', loaded.collection.mapping) });
        } else {
          throw new StoreError('invalid', `unknown op '${String(op.op).slice(0, 40)}'`);
        }
      } catch (e: any) {
        const code = e instanceof StoreError ? e.code : e instanceof MappingError ? 'mapping_error' : 'error';
        results.push({ index: i, ok: false, op: op.op, error: code, message: String(e?.message || e).slice(0, 300) });
      }
    }
    res.json({ results, ok: results.every((r) => r.ok) });
  });

  // ---- change feed (upserts and updates; deletes are not emitted) ----
  app.get('/v1/base/collections/:collection/changes', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const since = String(req.query.since || '');
    if (!since || Number.isNaN(Date.parse(since))) {
      return res.status(400).json({ error: 'invalid_since', message: 'since must be an ISO-8601 timestamp' });
    }
    const rawLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
      return res.status(400).json({ error: 'invalid_limit', message: 'limit must be an integer 1..1000' });
    }
    const as = req.query.as === undefined ? 'data' : String(req.query.as);
    if (as !== 'data' && as !== 'object') return res.status(400).json({ error: 'invalid_view', message: "as must be 'data' or 'object'" });
    const docs = await listDocumentRecs(loaded.collection.id, { since, scanLimit: rawLimit });
    const changes = docs.map((d) => ({ ...toApiDocument(d, as as 'data' | 'object', loaded.collection.mapping), deleted: false }));
    res.json({
      changes,
      nextSince: changes.length ? changes[changes.length - 1].updatedAt : since,
      hasMore: docs.length === rawLimit,
    });
  });

  app.get('/v1/base/collections/:collection/documents', async (req, res) => {
    const loaded = await loadCollection(req, res);
    if (!loaded) return;
    const rawLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    const rawOffset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000 || !Number.isInteger(rawOffset) || rawOffset < 0) {
      return res.status(400).json({ error: 'invalid_pagination', message: 'limit 1..1000 and offset >= 0 required' });
    }
    const docs = await listDocumentRecs(loaded.collection.id, { scanLimit: rawOffset + rawLimit });
    const page = docs.slice(rawOffset, rawOffset + rawLimit);
    res.json(page.map((d) => toApiDocument(d, 'data', loaded.collection.mapping)));
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
    if (e instanceof MappingError) return res.status(400).json({ error: 'mapping_error', message: e.message, details: e.details });
    if (e instanceof QueryError) return res.status(400).json({ error: 'invalid_query', message: e.message });
    if (e?.status === 400) return res.status(400).json({ error: 'bad_request', message: 'malformed request' });
    console.error('[base] unhandled:', e?.message || e);
    res.status(500).json({ error: 'internal', message: 'unexpected error' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  ensureTables()
    .catch(() => {})
    .finally(() => {
      app.listen(PORT, () => console.log(`[base] SynapseBase listening on :${PORT} (db=${useDb() ? 'postgres' : 'memory'})`));
    });
}
