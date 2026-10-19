/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseLDS — Linked Data Service (NGSI-LD open data gateway).
 * Datasources with licensed, policy-filtered NGSI-LD exports built by a
 * structural-allowlist projector (see ./projector). Postgres persistence
 * with in-memory fallback (dev/test). Internal-service auth like the rest
 * of the platform (SYNAPSEDX_INTERNAL_SECRET + gateway-stamped principal).
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import {
  createDatasourceRec, getDatasourceRec, listDatasourceRecs, updateDatasourceRec, deleteDatasourceRec,
  getAttributesRec, replaceAttributesRec, upsertRecordRec, getRecordRec, listRecordRecs,
  datasourceStatsRec, ensureTables, useDb, StoredDatasource,
} from './store';
import {
  ingestRecord, projectEntity, validateAttributeRegistry, resolveIdentity, LDS_RESERVED_ATTRIBUTES,
  NGSI_LD_CORE_CONTEXT,
} from './projector';
import type { RegistryAttribute } from './projector';
import { LDS_LICENSES, findLicense, isCustomLicenseId } from './licenses';

dotenv.config();
const PORT = Number(process.env.PORT || 4004);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD = process.env.NODE_ENV === 'production';

/** Caller principal from gateway-stamped headers (same contract as the other
 *  services). No-principal callers resolve via resolveCaller(): anonymous on
 *  public routes, platform for internal ops. */
export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

/** Three caller classes:
 *  - `principal`: gateway-verified user/org or API-key/account — full tenanted
 *    access (read public+restricted inside tenant, manage datasets);
 *  - `anon`: anonymous visitor on a PUBLIC route (gateway auth:none) — only the
 *    public NGSI-LD export + license catalog; no tenant existence leaks;
 *  - `platform`: internal ops (internal secret, no principal, direct call) —
 *    superuser, for services/ops/debugging; never exposed through the edge. */
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
  // The marker is stamped by the gateway for public routes; clients cannot
  // spoof it past the gateway (stripped) and a principal always wins.
  const anon = (Array.isArray(raw) ? raw[0] : raw) === '1';
  return anon ? { kind: 'anon', principal: null } : { kind: 'platform', principal: null };
}

function cleanId(v: unknown, max = 128): string | null {
  const s = String(v || '');
  if (!s || s.length > max || /[\r\n]/.test(s)) return null;
  return s;
}

function toApiDatasource(d: StoredDatasource): any {
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    entityType: d.entity_type,
    license: d.license,
    licenseUrl: d.license_url ?? undefined,
    contexts: d.contexts,
    defaultVisibility: d.default_visibility,
    description: d.description ?? undefined,
    orgId: d.org_id ?? undefined,
    accountId: d.account_id ?? undefined,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Tenancy rules (existence is never leaked — outsiders get 404):
 *  - platform (internal ops): everything;
 *  - org-bound rows: principals inside the same org;
 *  - account-bound rows (org-less): principals carrying that account;
 *  - unbound rows (legacy/platform-created): platform only;
 *  - anonymous callers: never full access — they read only the public
 *    projection through the export routes. */
function canAccessDatasource(d: StoredDatasource, c: Caller): boolean {
  if (c.kind === 'platform') return true;
  if (c.kind !== 'principal') return false;
  const p = c.principal;
  if (d.org_id) return !!p?.org && p.org === d.org_id;
  if (d.account_id) return !!p?.account && p.account === d.account_id;
  return false;
}

/** Anonymous calls are limited to the public read surface by design. */
function isAnonymous(c: Caller): boolean {
  return c.kind === 'anon';
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTEXT_URL_RE = /^https?:\/\/[^\s]{1,400}$/;

function slugify(name: string): string {
  const s = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s || 'dataset';
}

function cleanContexts(v: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.length > 10) return { ok: false, message: 'contexts must be an array of ≤10 URL strings' };
  const out: string[] = [];
  for (const c of v) {
    const s = String(c || '');
    if (!CONTEXT_URL_RE.test(s)) return { ok: false, message: `context URL invalid: '${s.slice(0, 80)}'` };
    out.push(s);
  }
  return { ok: true, value: out };
}

/** Resolve the license selection: built-in SPDX id or a namespaced custom
 *  LicenseRef-* (custom requires an explicit licenseUrl). */
function cleanLicense(id: unknown, url: unknown): { ok: true; license: string; licenseUrl: string | null } | { ok: false; message: string } {
  const lic = typeof id === 'string' ? id.trim() : '';
  if (!lic) return { ok: false, message: 'license is required (see GET /v1/lds/licenses)' };
  const builtin = findLicense(lic);
  if (builtin) {
    const customUrl = typeof url === 'string' && url.trim() ? url.trim() : null;
    if (customUrl && !CONTEXT_URL_RE.test(customUrl)) return { ok: false, message: 'licenseUrl must be an http(s) URL' };
    return { ok: true, license: builtin.id, licenseUrl: customUrl || builtin.url };
  }
  if (!isCustomLicenseId(lic)) {
    return { ok: false, message: `unknown license '${lic.slice(0, 64)}' (use a built-in SPDX id or LicenseRef-<name> with licenseUrl)` };
  }
  const customUrl = typeof url === 'string' ? url.trim() : '';
  if (!CONTEXT_URL_RE.test(customUrl)) return { ok: false, message: 'custom licenses require an http(s) licenseUrl' };
  return { ok: true, license: lic, licenseUrl: customUrl };
}

export function createApp(): express.Express {
  if (IS_PROD) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[lds] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[lds] DATABASE_URL must be set in production (in-memory fallback would split-brain)');
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
      // No wildcard CORS in production (the gateway front-ends the service
      // there); dev keeps the permissive default for local tooling.
      if (IS_PROD) return { origin: false } as any;
      console.warn('[lds][security] CORS_ORIGIN not set — allowing all origins (dev default).');
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

  // ---- Prometheus metrics (best-effort counter; bounded cardinality) ----
  const METRIC_REQUESTS: Map<string, number> = new Map();
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.on('finish', () => {
      try {
        // Route pattern when the request matched (no ids in labels); fall back
        // to first path segments; unbounded junk falls into a single bucket.
        let route: string = (req.route?.path as string) || '';
        if (!route) {
          const seg = (req.path || '/').split('/').filter(Boolean).slice(0, 3);
          route = '/' + seg.join('/');
        }
        if (METRIC_REQUESTS.size < 300) route = route.slice(0, 64);
        else route = '**';
        const key = `${req.method}|${route}|${res.statusCode}`;
        METRIC_REQUESTS.set(key, (METRIC_REQUESTS.get(key) || 0) + 1);
      } catch { /* metrics are best-effort */ }
    });
    next();
  }) as any);
  app.get('/metrics', async (_req, res) => {
    const lines: string[] = [
      '# HELP synapsedx_lds_up LDS service up.',
      '# TYPE synapsedx_lds_up gauge',
      'synapsedx_lds_up 1',
      '# HELP synapsedx_lds_process_uptime_seconds Process uptime in seconds.',
      '# TYPE synapsedx_lds_process_uptime_seconds gauge',
      `synapsedx_lds_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '# HELP synapsedx_lds_http_requests_total HTTP requests by key = method|route|status.',
      '# TYPE synapsedx_lds_http_requests_total counter',
      ...[...METRIC_REQUESTS.entries()].map(([k, v]) => `synapsedx_lds_http_requests_total{key="${k}"} ${v}`),
    ];
    try {
      const all = await listDatasourceRecs();
      let records = 0;
      for (const d of all) {
        try { records += (await datasourceStatsRec(d.id)).records || 0; } catch { /* best-effort */ }
      }
      lines.push(
        '# HELP synapsedx_lds_datasources_total Datasource count.',
        '# TYPE synapsedx_lds_datasources_total gauge',
        `synapsedx_lds_datasources_total ${all.length}`,
        '# HELP synapsedx_lds_records_total Stored records across all datasources.',
        '# TYPE synapsedx_lds_records_total gauge',
        `synapsedx_lds_records_total ${records}`,
      );
    } catch { /* scrape never fails on db blips */ }
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Service-to-service gate: when the internal secret is set, every /v1/*
  // call must carry it (the gateway stamps it after verifying the caller).
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[lds][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default).');
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
    let counts: any = {};
    try {
      const ds = await listDatasourceRecs();
      counts = { datasources: ds.length };
    } catch { /* health never fails on db */ }
    res.json({
      status: 'ok', service: 'lds', version: VERSION, db: useDb() ? 'postgres' : 'memory',
      licenses: LDS_LICENSES.length, reservedAttributes: LDS_RESERVED_ATTRIBUTES.length,
      ...counts, time: new Date().toISOString(),
    });
  });

  // ---- license catalog ----
  app.get('/v1/lds/licenses', (_req, res) => {
    res.json(LDS_LICENSES);
  });

  // ---- datasources ----
  app.get('/v1/lds/datasources', async (req, res) => {
    const c = resolveCaller(req);
    if (isAnonymous(c)) {
      return res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports (GET /v1/lds/licenses, GET /v1/lds/datasources/:id/entities)' });
    }
    const p = c.principal;
    const q = req.query as any;
    const all = await listDatasourceRecs();
    // Same visibility rule as every other route (single read, registry,
    // ingest, delete). Query params may only NARROW within what the principal
    // can see — never widen it (a tenant principal asking for another org
    // gets an empty list).
    let visible = all.filter((d) => canAccessDatasource(d, c));
    if (typeof q.orgId === 'string' && q.orgId) {
      const want = q.orgId.slice(0, 128);
      visible = visible.filter((d) => (d.org_id || '') === want);
    }
    if (typeof q.accountId === 'string' && q.accountId) {
      const want = q.accountId.slice(0, 128);
      visible = visible.filter((d) => (d.account_id || '') === want);
    }
    res.json(visible.map(toApiDatasource));
  });

  app.post('/v1/lds/datasources', async (req, res) => {
    const c = resolveCaller(req);
    if (isAnonymous(c)) {
      return res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports' });
    }
    const p = c.principal;
    const b = (req.body || {}) as any;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 200) return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    const entityType = typeof b.entityType === 'string' ? b.entityType.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entityType)) {
      return res.status(400).json({ error: 'invalid_entity_type', message: 'entityType must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
    }
    const slug = b.slug !== undefined && b.slug !== null && String(b.slug) !== '' ? String(b.slug).trim() : slugify(name);
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match [a-z0-9][a-z0-9-]{0,63}' });
    }
    const lic = cleanLicense(b.license, b.licenseUrl);
    if (!lic.ok) return res.status(400).json({ error: 'invalid_license', message: lic.message });
    const ctx = cleanContexts(b.contexts);
    if (!ctx.ok) return res.status(400).json({ error: 'invalid_contexts', message: ctx.message });
    const dv = b.defaultVisibility === undefined ? 'internal' : String(b.defaultVisibility);
    if (!['public', 'internal'].includes(dv)) {
      return res.status(400).json({ error: 'invalid_visibility', message: 'defaultVisibility must be public|internal' });
    }
    if (b.description !== undefined && String(b.description).length > 500) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    // Tenancy: the principal decides where a datasource lives — a caller can
    // never create a row in an org/account they do not control.
    const bodyOrg = b.orgId !== undefined && b.orgId !== null && String(b.orgId) !== '' ? cleanId(b.orgId) : null;
    const bodyAcc = b.accountId !== undefined && b.accountId !== null && String(b.accountId) !== '' ? cleanId(b.accountId) : null;
    if ((b.orgId !== undefined && String(b.orgId) !== '' && bodyOrg === null) || (b.accountId !== undefined && String(b.accountId) !== '' && bodyAcc === null)) {
      return res.status(400).json({ error: 'invalid_tenant', message: 'orgId/accountId must be 1..128 chars' });
    }
    let reqOrg: string | null;
    let reqAcc: string | null;
    if (p?.org) {
      if (bodyOrg && bodyOrg !== p.org) {
        return res.status(403).json({ error: 'cross_tenant', message: 'cannot create a datasource outside your own org' });
      }
      reqOrg = p.org;
      reqAcc = bodyAcc ?? p.account ?? null;
    } else if (p) {
      // Account-scoped principals (API keys / service accounts) may only
      // create inside their own account — never into an org.
      if (bodyOrg) {
        return res.status(403).json({ error: 'cross_tenant', message: 'account-scoped principals cannot create org-bound datasources' });
      }
      reqOrg = null;
      reqAcc = p.account ?? null;
      if (bodyAcc && bodyAcc !== reqAcc) {
        return res.status(403).json({ error: 'cross_tenant', message: 'cannot create a datasource outside your own account' });
      }
    } else {
      // Platform context (internal service calls without a principal).
      reqOrg = bodyOrg;
      reqAcc = bodyAcc;
    }
    let ds: StoredDatasource;
    try {
      ds = await createDatasourceRec({
        slug, name, entity_type: entityType, license: lic.license, license_url: lic.licenseUrl,
        contexts: ctx.value, default_visibility: dv as 'public' | 'internal',
        description: b.description !== undefined ? String(b.description) : null,
        org_id: reqOrg, account_id: reqAcc, created_by: p?.sub ?? null,
      });
    } catch (e: any) {
      if (e?.code === 'conflict') return res.status(409).json({ error: 'slug_conflict', message: String(e.message) });
      throw e;
    }
    res.status(201).json(toApiDatasource(ds));
  });

  app.get('/v1/lds/datasources/:id', async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const c = resolveCaller(req);
    if (isAnonymous(c)) return res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports' });
    const ds = await getDatasourceRec(id);
    if (!ds || !canAccessDatasource(ds, c)) {
      return res.status(404).json({ error: 'not_found', message: 'datasource not found' });
    }
    const [attributes, stats] = await Promise.all([getAttributesRec(id), datasourceStatsRec(id)]);
    res.json({ ...toApiDatasource(ds), attributes, stats });
  });

  app.patch('/v1/lds/datasources/:id', async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const c = resolveCaller(req);
    if (isAnonymous(c)) return res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports' });
    const cur = await getDatasourceRec(id);
    if (!cur || !canAccessDatasource(cur, c)) {
      return res.status(404).json({ error: 'not_found', message: 'datasource not found' });
    }
    const b = (req.body || {}) as any;
    const patch: any = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name || name.length > 200) return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
      patch.name = name;
    }
    if (b.slug !== undefined) {
      const slug = String(b.slug).trim();
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'invalid_slug', message: 'slug must match [a-z0-9][a-z0-9-]{0,63}' });
      patch.slug = slug;
    }
    if (b.license !== undefined) {
      const lic = cleanLicense(b.license, b.licenseUrl);
      if (!lic.ok) return res.status(400).json({ error: 'invalid_license', message: lic.message });
      patch.license = lic.license;
      patch.license_url = lic.licenseUrl;
    } else if (b.licenseUrl !== undefined) {
      const url = String(b.licenseUrl).trim();
      if (!CONTEXT_URL_RE.test(url)) return res.status(400).json({ error: 'invalid_license', message: 'licenseUrl must be an http(s) URL' });
      patch.license_url = url;
    }
    if (b.contexts !== undefined) {
      const ctx = cleanContexts(b.contexts);
      if (!ctx.ok) return res.status(400).json({ error: 'invalid_contexts', message: ctx.message });
      patch.contexts = ctx.value;
    }
    if (b.defaultVisibility !== undefined) {
      const dv = String(b.defaultVisibility);
      if (!['public', 'internal'].includes(dv)) {
        return res.status(400).json({ error: 'invalid_visibility', message: 'defaultVisibility must be public|internal' });
      }
      patch.default_visibility = dv;
    }
    if (b.entityType !== undefined) {
      const et = String(b.entityType).trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(et)) {
        return res.status(400).json({ error: 'invalid_entity_type', message: 'entityType must match [A-Za-z][A-Za-z0-9_-]{0,63}' });
      }
      patch.entity_type = et;
    }
    if (b.description !== undefined) {
      const d = b.description === null ? null : String(b.description);
      if (d !== null && d.length > 500) return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
      patch.description = d;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'invalid_body', message: 'no updatable fields provided' });
    let updated: StoredDatasource | null;
    try {
      updated = await updateDatasourceRec(id, patch);
    } catch (e: any) {
      if (e?.code === 'conflict') return res.status(409).json({ error: 'slug_conflict', message: String(e.message) });
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        return res.status(409).json({ error: 'slug_conflict', message: 'datasource slug already exists in this scope' });
      }
      throw e;
    }
    res.json(toApiDatasource(updated!));
  });

  app.delete('/v1/lds/datasources/:id', async (req, res) => {
    const id = cleanId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const c = resolveCaller(req);
    if (isAnonymous(c)) return res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports' });
    const cur = await getDatasourceRec(id);
    if (!cur || !canAccessDatasource(cur, c)) {
      return res.status(404).json({ error: 'not_found', message: 'datasource not found' });
    }
    await deleteDatasourceRec(id);
    res.json({ ok: true, id });
  });

  // ---- attribute registry (schema) ----
  async function loadDatasource(req: express.Request, res: express.Response): Promise<StoredDatasource | null> {
    const id = cleanId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'invalid_id' });
      return null;
    }
    const c = resolveCaller(req);
    if (isAnonymous(c)) {
      res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports (GET /v1/lds/licenses, GET /v1/lds/datasources/:id/entities)' });
      return null;
    }
    const ds = await getDatasourceRec(id);
    if (!ds || !canAccessDatasource(ds, c)) {
      res.status(404).json({ error: 'not_found', message: 'datasource not found' });
      return null;
    }
    return ds;
  }

  app.get('/v1/lds/datasources/:id/attributes', async (req, res) => {
    const ds = await loadDatasource(req, res);
    if (!ds) return;
    res.json(await getAttributesRec(ds.id));
  });

  app.put('/v1/lds/datasources/:id/attributes', async (req, res) => {
    const ds = await loadDatasource(req, res);
    if (!ds) return;
    // Entries that omit visibility inherit the datasource's defaultVisibility
    // (which itself defaults to the safe 'internal').
    const bodyAttrs = (req.body || {}).attributes;
    const withDefaults = Array.isArray(bodyAttrs)
      ? bodyAttrs.map((a: any) =>
          a && typeof a === 'object' && !Array.isArray(a) && a.visibility === undefined
            ? { ...a, visibility: ds.default_visibility === 'public' ? 'public' : 'internal' }
            : a,
        )
      : bodyAttrs;
    const v = validateAttributeRegistry(withDefaults);
    if (!v.ok) {
      return res.status(400).json({ error: v.error, message: v.message, ...(v.reserved ? { reserved: v.reserved } : {}) });
    }
    const saved = await replaceAttributesRec(ds.id, v.value);
    res.json(saved);
  });

  // ---- record ingest ----
  app.post('/v1/lds/datasources/:id/records', async (req, res) => {
    const ds = await loadDatasource(req, res);
    if (!ds) return;
    const b = (req.body || {}) as any;
    let records: any[];
    if (Array.isArray(b.records)) records = b.records;
    else if (b.record && typeof b.record === 'object' && !Array.isArray(b.record) && Object.keys(b).length === 1) records = [b.record];
    else records = [b];
    if (!records.length || records.length > 1000) {
      return res.status(400).json({ error: 'invalid_records', message: '1..1000 records per call' });
    }
    const p = resolveCaller(req).principal;
    const registry = await getAttributesRec(ds.id);
    const entities: any[] = [];
    const quarantined: Array<{ field: string; reason: string; record?: string }> = [];
    let created = 0;
    let updated = 0;
    for (let i = 0; i < records.length; i++) {
      const raw = records[i];
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('record must be a JSON object');
        if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 256 * 1024) throw new Error('record exceeds 256KB');
        let prev = null;
        try {
          const ident = resolveIdentity({ id: ds.id, entity_type: ds.entity_type }, raw);
          prev = await getRecordRec(ds.id, ident.entityId);
        } catch { /* identity errors surface below with full context */ }
        const r = ingestRecord({ id: ds.id, entity_type: ds.entity_type }, registry, raw, p, prev);
        const up = await upsertRecordRec(r.record);
        if (up.created) created++;
        else updated++;
        for (const q of r.quarantined) quarantined.push({ ...q, record: r.record.sourceRecordId ? String(r.record.sourceRecordId).slice(0, 64) : undefined });
        // `_core` (incl. internalId) never leaves the service — the ingest
        // summary reports only the public identity + version.
        entities.push({ entityId: up.record.entityId, sourceRecordId: up.record.sourceRecordId, version: up.record.version });
      } catch (e: any) {
        quarantined.push({ field: `records[${i}]`, reason: String(e?.message || e).slice(0, 200) });
      }
    }
    res.status(created + updated ? 201 : 400).json({
      ingested: created + updated, created, updated,
      quarantined, entities,
    });
  });

  // ---- NGSI-LD export (structural-allowlist projection) ----
  // Export visibility matrix (spec: public = "anyone reaching the API"):
  //  - anon (gateway public route): public projection only; ?visibility=restricted
  //    or any write → 401 auth_required; unknown dataset → uniform 404;
  //  - principal: existence-hidden — foreign tenant rows 404 (dataset catalog is
  //    tenant-private; public sharing goes through the anonymous route);
  //  - platform: full read (internal ops).
  async function exportEntities(req: express.Request, res: express.Response, single?: string) {
    const c = resolveCaller(req);
    if (c.kind === 'anon' && req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(401).json({ error: 'auth_required', message: 'anonymous callers may only read public exports' });
    }
    const id = cleanId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const ds = await getDatasourceRec(id);
    if (!ds) return res.status(404).json({ error: 'not_found', message: 'datasource not found' });
    if (c.kind === 'principal' && !canAccessDatasource(ds, c)) {
      return res.status(404).json({ error: 'not_found', message: 'datasource not found' });
    }
    const q = req.query as any;
    const visibility = q.visibility === undefined ? 'public' : String(q.visibility);
    if (!['public', 'restricted'].includes(visibility)) {
      return res.status(400).json({ error: 'invalid_visibility', message: 'visibility must be public|restricted' });
    }
    if (visibility === 'restricted') {
      const p = c.principal;
      const tenanted =
        c.kind === 'platform' ||
        (!!p?.org && !!ds.org_id && p.org === ds.org_id) ||
        (!!p?.account && !!ds.account_id && p.account === ds.account_id);
      if (!tenanted) {
        return res
          .status(c.kind === 'anon' ? 401 : 404)
          .json(c.kind === 'anon' ? { error: 'auth_required', message: 'restricted visibility requires an authenticated caller inside the datasource tenant' } : { error: 'not_found', message: 'datasource not found' });
      }
    }
    const registry = await getAttributesRec(ds.id);
    // License metadata rides on every export (3-place surfacing): Link header,
    // X-LDS-License, and the license URL inside @context (per the spec).
    const contextUrls = [...(ds.license_url ? [ds.license_url] : []), ...(ds.contexts || [])];
    if (ds.license_url) res.setHeader('Link', `<${ds.license_url}>; rel="license"`);
    res.setHeader('X-LDS-License', ds.license);
    res.setHeader('X-LDS-Datasource', ds.slug);
    res.setHeader('X-LDS-Context', NGSI_LD_CORE_CONTEXT);
    // Restricted payloads are principal-dependent: never shared-cache them.
    res.setHeader('Cache-Control', visibility === 'restricted' ? 'private, no-store' : 'public, max-age=60');
    if (single) {
      const entityId = cleanId(String(req.params.entityId || ''), 512);
      if (!entityId) return res.status(400).json({ error: 'invalid_entity_id' });
      const rec = await getRecordRec(ds.id, entityId);
      if (!rec) return res.status(404).json({ error: 'not_found', message: 'entity not found' });
      return res.json(projectEntity(rec, { registry, contextUrls, mode: visibility === 'restricted' ? 'restricted' : 'public' }));
    }
    // Contract: ?limit 1..500, ?offset >= 0 — invalid values are a 400, not a
    // silent clamp (clients must know their pagination intent was ignored).
    const rawLimit = q.limit;
    if (rawLimit !== undefined && !/^\d{1,4}$/.test(String(rawLimit))) {
      return res.status(400).json({ error: 'invalid_limit', message: 'limit must be an integer 1..500' });
    }
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'invalid_limit', message: 'limit must be an integer 1..500' });
    }
    const rawOffset = q.offset;
    if (rawOffset !== undefined && !/^\d{1,9}$/.test(String(rawOffset))) {
      return res.status(400).json({ error: 'invalid_offset', message: 'offset must be an integer >= 0' });
    }
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    const { items, total } = await listRecordRecs(ds.id, { limit, offset });
    const entities = items.map((rec) => projectEntity(rec, { registry, contextUrls, mode: visibility === 'restricted' ? 'restricted' : 'public' }));
    res.setHeader('X-LDS-Total', String(total));
    res.json(entities);
  }

  app.get('/v1/lds/datasources/:id/entities', async (req, res) => exportEntities(req, res));
  app.get('/v1/lds/datasources/:id/entities/:entityId', async (req, res) => exportEntities(req, res, String(req.params.entityId)));

  app.get('/v1/lds/datasources/:id/stats', async (req, res) => {
    const ds = await loadDatasource(req, res);
    if (!ds) return;
    res.json({ id: ds.id, slug: ds.slug, ...(await datasourceStatsRec(ds.id)) });
  });

  // Final error handler (async wrapper funnels here).
  app.use((e: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    // Malformed JSON body → 400 (express.json emits entity.parse.failed).
    if (e?.type === 'entity.parse.failed' || (e instanceof SyntaxError && /JSON/i.test(String(e?.message)))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (e?.type === 'entity.too.large' || e?.status === 413) {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    // Express tags malformed URL escapes (URIError) with status 400.
    if (e?.status === 400) {
      return res.status(400).json({ error: 'bad_request', message: 'malformed request' });
    }
    console.error('[lds] unhandled:', e?.message || e);
    res.status(500).json({ error: 'internal', message: 'unexpected error' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  ensureTables()
    .catch(() => {})
    .finally(() => {
      app.listen(PORT, () => console.log(`[lds] SynapseLDS listening on :${PORT} (db=${useDb() ? 'postgres' : 'memory'})`));
    });
}
