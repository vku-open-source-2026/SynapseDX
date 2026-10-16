/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow service: local built-in engine (Apache-2.0, no external engine).
 * Stores workflows + executions in Postgres (DATABASE_URL) with in-memory
 * fallback for dev/test. Executes webhook/cron/manual/httpRequest/code/
 * set/if/noOp DAGs via ./engine (sandboxed code).
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual, randomUUID } from 'crypto';
import {
  createWorkflowRec, getWorkflowRec, listWorkflowRecs, updateWorkflowRec, deleteWorkflowRec,
  createExecutionRec, getExecutionRec, listExecutionRecs, findActiveWebhookWorkflow,
  listActiveCronWorkflows, ensureTables, useDb, StoredWorkflow,
  createCredentialRec, getCredentialRec, listCredentialRecs, deleteCredentialRec,
  toPublicCredential, decryptSecret,
} from './store';
import { runWorkflow, detectCycle, workflowCronIntervalMs, workflowCronNextRunAt, validateCronParams, isBlockedUrl as engineIsBlockedUrl, isAllowedSelfUrl, selfAllowlist, actorFor } from './engine';
import type { CredentialResolver } from './engine';

/** Server-side credential resolver for node auth (P0-4): nodes reference
 *  credentialIds; secrets are decrypted only here, at run time. */
const credentialResolver: CredentialResolver = async (credentialId: string) => {
  if (!credentialId || typeof credentialId !== 'string') return null;
  const rec = await getCredentialRec(credentialId);
  if (!rec) return null;
  try {
    return { kind: rec.kind, secret: decryptSecret(rec.secret_enc) };
  } catch {
    return null;
  }
};

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
const IS_PROD_WF = process.env.NODE_ENV === 'production';

// In-process metrics (P2 /metrics): run counts by trigger+status, node
// error counts, webhook rejections by reason. Reset on restart.
// Module-level so both createApp routes and the cron loop can record.
const metricRuns = new Map<string, number>();
const metricWebhookRejected = new Map<string, number>();
function recordRun(triggeredBy: string, status: string, nodeRuns?: Array<{ status: string }>): void {
  const k = `${triggeredBy || 'manual'}|${status || 'success'}`;
  metricRuns.set(k, (metricRuns.get(k) || 0) + 1);
  if (nodeRuns) {
    const errs = nodeRuns.filter((r) => r.status === 'error').length;
    if (errs) metricRuns.set(`node-errors|total`, (metricRuns.get(`node-errors|total`) || 0) + errs);
  }
}
function recordWebhookReject(reason: string): void {
  metricWebhookRejected.set(reason, (metricWebhookRejected.get(reason) || 0) + 1);
}
export function __resetMetrics(): void {
  metricRuns.clear();
  metricWebhookRejected.clear();
}

/** SSRF guard: block workflow definitions that make the engine fetch internal targets.
 *  Single implementation lives in ./engine (isBlockedUrl honors the
 *  SYNAPSEDX_SELF_BASE_URLS allowlist); re-exported here for tests. */
const isBlockedUrl = engineIsBlockedUrl;
function findSsrfUrl(definition: any): string | null {
  // Recursive scan (depth-capped) so nested options (headers, bodyParameters,
  // assignments…) can't smuggle an internal URL past save-time validation.
  // Runtime execHttp re-checks the final URL + every redirect hop anyway.
  const seen = new Set<any>();
  const scan = (v: any, depth: number): string | null => {
    if (depth > 4 || v === null || v === undefined) return null;
    if (typeof v === 'string') {
      if (v.length < 2048 && /^https?:\/\//i.test(v) && isBlockedUrl(v)) return v;
      return null;
    }
    if (typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = scan(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const val of Object.values(v)) {
      const hit = scan(val, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  try {
    const nodes = definition?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      const hit = scan((n as any)?.parameters, 0);
      if (hit) return hit;
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
    const names = new Set<string>();
    for (const n of nodes) {
      if (!n || typeof n !== 'object') return 'definition.nodes[] must be objects';
      if (typeof (n as any).type !== 'string' || (n as any).type.length > 128) return 'definition.nodes[].type invalid';
      // m5: the engine keys everything off node names — nameless nodes
      // silently break routing, so require a name (same as console validateGraph).
      const nm = (n as any).name;
      if (typeof nm !== 'string' || !nm || nm.length > 128) {
        return `definition.nodes[].name must be a 1..128 char string (got '${String(nm).slice(0, 32)}')`;
      }
      if (names.has(nm)) return `duplicate node name '${nm}'`;
      names.add(nm);
      const params = (n as any).parameters;
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        return `definition.nodes['${nm}'].parameters must be an object`;
      }
      if ((n as any).type === 'n8n-nodes-base.code') {
        const src = params?.code ?? params?.jsCode ?? params?.js;
        if (typeof src === 'string' && Buffer.byteLength(src, 'utf8') > 50 * 1024) {
          return `definition.nodes['${nm}'].code exceeds 50KB`;
        }
      }
      // M7: webhook trigger contract — path charset + method enum.
      if ((n as any).type === 'n8n-nodes-base.webhook' && params && typeof params === 'object') {
        if (params.path !== undefined && params.path !== null && String(params.path) !== '') {
          const wp = String(params.path).replace(/^\/+|\/+$/g, '');
          if (!wp || wp.length > 128 || !/^[A-Za-z0-9_.\/-]+$/.test(wp) || wp.split('/').includes('..')) {
            return `definition.nodes['${nm}'].webhook path invalid (1..128 chars, [A-Za-z0-9_.\\/ -], no '..'])`;
          }
        }
        if (params.httpMethod !== undefined && params.httpMethod !== null && String(params.httpMethod) !== '') {
          const m = String(params.httpMethod).toUpperCase();
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) {
            return `definition.nodes['${nm}'].webhook httpMethod invalid (GET|POST|PUT|PATCH|DELETE|HEAD)`;
          }
        }
        // P0-5: inbound hardening contract.
        if (params.auth !== undefined && params.auth !== null) {
          if (typeof params.auth !== 'object' || Array.isArray(params.auth)) {
            return `definition.nodes['${nm}'].webhook auth must be an object`;
          }
          const mode = (params.auth as any).mode;
          if (mode !== undefined && !['none', 'secret-header', 'hmac-sha256', 'jwt'].includes(String(mode))) {
            return `definition.nodes['${nm}'].webhook auth.mode invalid (none|secret-header|hmac-sha256|jwt)`;
          }
          if (String(mode) !== 'none' && mode !== undefined) {
            if (typeof (params.auth as any).credentialId !== 'string' || !(params.auth as any).credentialId) {
              return `definition.nodes['${nm}'].webhook auth.credentialId required when mode is '${mode}'`;
            }
          }
          if ((params.auth as any).header !== undefined && (typeof (params.auth as any).header !== 'string' || !/^[A-Za-z0-9-]+$/.test((params.auth as any).header) || (params.auth as any).header.length > 128)) {
            return `definition.nodes['${nm}'].webhook auth.header invalid`;
          }
        }
        if (params.rateLimit !== undefined && params.rateLimit !== null) {
          const rpm = Number((params.rateLimit as any)?.rpm);
          if (!Number.isFinite(rpm) || rpm < 1 || rpm > 60000) {
            return `definition.nodes['${nm}'].webhook rateLimit.rpm must be 1..60000`;
          }
        }
        if (params.idempotency !== undefined && params.idempotency !== null) {
          if (typeof params.idempotency !== 'object' || Array.isArray(params.idempotency)) {
            return `definition.nodes['${nm}'].webhook idempotency must be an object`;
          }
          if (typeof (params.idempotency as any).header !== 'string' || !/^[A-Za-z0-9-]+$/.test((params.idempotency as any).header)) {
            return `definition.nodes['${nm}'].webhook idempotency.header invalid`;
          }
          const ttl = Number((params.idempotency as any).ttlSeconds ?? 3600);
          if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86400) {
            return `definition.nodes['${nm}'].webhook idempotency.ttlSeconds must be 60..86400`;
          }
        }
      }
      // P1-16: httpRequest credential reference shape (secret itself lives
      // in /v1/credentials and is resolved server-side at run time).
      if ((n as any).type === 'n8n-nodes-base.httpRequest' && params && typeof params === 'object') {
        const auth = (params as any).auth;
        if (auth !== undefined && auth !== null) {
          if (typeof auth !== 'object' || Array.isArray(auth)) {
            return `definition.nodes['${nm}'].httpRequest auth must be an object`;
          }
          if (typeof (auth as any).credentialId !== 'string' || !(auth as any).credentialId) {
            return `definition.nodes['${nm}'].httpRequest auth.credentialId required`;
          }
        }
        if ((params as any).retry !== undefined && (params as any).retry !== null) {
          const rt = (params as any).retry;
          if (typeof rt !== 'object' || Array.isArray(rt)) {
            return `definition.nodes['${nm}'].retry must be an object`;
          }
          const a = Number((rt as any).attempts);
          if ((rt as any).attempts !== undefined && (!Number.isFinite(a) || a < 1 || a > 5)) {
            return `definition.nodes['${nm}'].retry.attempts must be 1..5`;
          }
        }
      }
      // M8: reject schedules that would silently never fire.
      if ((n as any).type === 'n8n-nodes-base.cron') {
        const ce = validateCronParams(params || {});
        if (ce) return `definition.nodes['${nm}']: ${ce}`;
      }
    }
    // Cycle check (DAG only).
    try {
      const conns = (definition as any).connections || {};
      const cyc = detectCycle(nodes as any, conns as any);
      if (cyc) return cyc;
    } catch { /* ignore */ }
  }
  try {
    if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 200 * 1024) return 'definition exceeds 200KB';
  } catch { return 'definition is not JSON-serializable'; }
  const bad = findSsrfUrl(definition);
  if (bad) return `definition contains blocked internal URL (${String(bad).slice(0, 80)}) — use an allowlisted public endpoint`;
  // Structural edge checks — messages synced with console validateGraph.
  try {
    const nodesArr: any[] = Array.isArray((definition as any).nodes) ? (definition as any).nodes : [];
    const names = new Set(nodesArr.map((n: any) => (n as any)?.name).filter((x: any) => typeof x === 'string' && x));
    const conns: any = (definition as any).connections || {};
    for (const [from, groups] of Object.entries(conns)) {
      if (!names.has(from)) return `connection from unknown node '${from}'`;
      const mains: any = (groups as any)?.main;
      if (mains !== undefined && !Array.isArray(mains)) return `connections['${from}'].main must be an array`;
      for (const branch of mains || []) {
        for (const e of Array.isArray(branch) ? branch : []) {
          if (!e || typeof e !== 'object' || !names.has((e as any).node)) {
            return `connection from '${from}' points at unknown node '${(e as any)?.node}'`;
          }
          if ((e as any).node === from) return `self-loop on '${from}' is not allowed`;
        }
      }
    }
    if (nodesArr.length > 1) {
      const touched = new Set<string>();
      for (const [from, groups] of Object.entries(conns)) {
        const mains: any = (groups as any)?.main;
        if (!Array.isArray(mains)) continue;
        let has = false;
        for (const branch of mains) {
          for (const e of Array.isArray(branch) ? branch : []) {
            if (e?.node && names.has(e.node)) { touched.add(e.node); has = true; }
          }
        }
        if (has) touched.add(from);
      }
      for (const n of nodesArr) {
        const nm = (n as any)?.name;
        if (typeof nm === 'string' && nm && !touched.has(nm)) return `dangling node '${nm}' has no connections`;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function toApiWorkflow(w: StoredWorkflow): any {
  return {
    id: w.id,
    name: w.name,
    active: w.active,
    nodes: w.nodes,
    connections: w.connections,
    settings: w.settings,
    orgId: w.org_id ?? undefined,
    accountId: w.account_id ?? undefined,
    owner: w.owner_sub ?? undefined,
    runAs: w.run_as ?? undefined,
    revision: w.revision ?? 1,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/** Mask secret-looking values in execution payloads (P0-4): keys matching
 *  authorization/api-key/password/secret/token/cookie are replaced with ***.
 *  Applied at the API boundary so stored node I/O never leaks credentials
 *  to log viewers. Depth-capped, cycle-safe. */
const SECRET_KEY_RE = /^(authorization|.*api[-_]?key.*|.*password.*|.*secret.*|.*token.*|cookie|set-cookie|x-signature)$/i;
export function maskSecrets(v: any, depth = 0, seen: Set<any> = new Set()): any {
  if (depth > 6 || v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (seen.has(v)) return '[circular]';
  if (Array.isArray(v)) {
    seen.add(v);
    const out = v.map((item) => maskSecrets(item, depth + 1, seen));
    seen.delete(v);
    return out;
  }
  seen.add(v);
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = SECRET_KEY_RE.test(k) ? '***' : maskSecrets(val, depth + 1, seen);
  }
  seen.delete(v);
  return out;
}

function toApiExecution(e: any, includeData: boolean): any {
  const base: any = {
    id: e.id,
    workflowId: e.workflow_id,
    workflowName: e.workflow_name,
    status: e.status,
    mode: 'manual',
    triggeredBy: e.triggered_by,
    principal: e.principal ?? undefined,
    actor: e.actor ?? undefined,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    error: e.error,
    output: maskSecrets(e.output),
    input: includeData ? maskSecrets(e.input) : undefined,
  };
  if (includeData) {
    base.data = maskSecrets(e.node_runs);
    base.nodeRuns = maskSecrets(e.node_runs);
  }
  // Strip undefined for clean JSON.
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
}

/** Caller principal from gateway-stamped headers (P0-2). The gateway strips
 *  client-sent x-synapsedx-* and re-stamps from the verified identity, so
 *  these are trusted here. Direct calls carry no principal → anonymous. */
export function principalFromHeaders(req: express.Request): import('./store').Principal | null {
  const h = (n: string): string => {
    const v = req.headers[n];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const sub = h('x-synapsedx-user');
  if (!sub || sub.length > 128) return null;
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  return {
    sub,
    org: clean(h('x-synapsedx-org')),
    account: clean(h('x-synapsedx-account')),
    kind: clean(h('x-synapsedx-kind')),
  };
}

export function createApp(): express.Express {
  if (IS_PROD_WF) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[workflow] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[workflow] DATABASE_URL must be set in production (in-memory fallback would split-brain)');
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
  app.use(express.json({
    limit: '2mb',
    // Keep the raw body for HMAC webhook verification (P0-5).
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));

  // ---- inbound webhook hardening (P0-5): per-workflow auth, rate limit, idempotency ----
  // Node params contract (validated at save time):
  //   auth: { mode: none|secret-header|hmac-sha256|jwt, header?, credentialId? }
  //   rateLimit: { rpm } (default 600, 1..60000) · idempotency: { header, ttlSeconds }
  const webhookRate = new Map<string, { count: number; reset: number }>();
  const webhookDedupe = new Map<string, number>();
  function webhookNodeFor(wf: StoredWorkflow, clean: string): any | null {
    for (const n of wf.nodes || []) {
      if ((n as any)?.type !== 'n8n-nodes-base.webhook') continue;
      if (String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '') === clean) return n;
    }
    return null;
  }
  function webhookAuthOf(node: any): { mode: string; header: string; credentialId?: string } {
    const a = (node as any)?.parameters?.auth;
    const mode = a && typeof a === 'object' && typeof a.mode === 'string' ? a.mode : 'none';
    const defaults: Record<string, string> = { 'secret-header': 'x-webhook-secret', 'hmac-sha256': 'x-signature', jwt: 'authorization' };
    const header = a && typeof a?.header === 'string' && a.header ? String(a.header).toLowerCase().slice(0, 128) : (defaults[mode] || '');
    const credentialId = a && typeof a?.credentialId === 'string' ? a.credentialId : undefined;
    return { mode, header, credentialId };
  }
  function verifyJwtHS256(token: string, secret: string, node: any): boolean {
    try {
      const t = token.startsWith('Bearer ') ? token.slice(7) : token;
      const parts = t.split('.');
      if (parts.length !== 3) return false;
      const crypto = require('crypto');
      const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url' as any);
      const a = Buffer.from(expected);
      const b = Buffer.from(parts[2]);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url' as any).toString('utf8'));
      const nowS = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === 'number' && nowS > payload.exp) return false;
      if (typeof payload.nbf === 'number' && nowS < payload.nbf) return false;
      const auth = (node as any)?.parameters?.auth || {};
      if (typeof auth.issuer === 'string' && auth.issuer && payload.iss !== auth.issuer) return false;
      if (typeof auth.audience === 'string' && auth.audience && payload.aud !== auth.audience) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Public inbound webhooks: ANY /webhook/:path triggers the active
  // workflow whose webhook node declares that path. No internal secret —
  // external systems call this (like any webhook). Per-workflow auth,
  // rate limiting and idempotency are enforced here (P0-5); the payload
  // is capped at 200KB.
  const handleInboundWebhook = async (req: express.Request, res: express.Response) => {
    try {
      const rawPath = String((req.params as any)?.path || req.path.replace(/^\/webhook\/?/, ''));
      const clean = rawPath.replace(/^\/+|\/+$/g, '').split('?')[0].slice(0, 128);
      if (!clean || /[\r\n]/.test(clean)) {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      const wf = await findActiveWebhookWorkflow(clean);
      if (!wf) {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      const node = webhookNodeFor(wf, clean);
      const params = (node as any)?.parameters || {};
      // Rate limit (fixed window per workflow).
      const rpm = Math.min(Math.max(Number(params?.rateLimit?.rpm) || 600, 1), 60000);
      const nowMs = Date.now();
      const bucket = webhookRate.get(wf.id);
      if (!bucket || nowMs >= bucket.reset) webhookRate.set(wf.id, { count: 1, reset: nowMs + 60000 });
      else {
        bucket.count++;
        if (bucket.count > rpm) {
          recordWebhookReject('rate_limited');
          res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.reset - nowMs) / 1000)));
          return res.status(429).json({ error: 'rate_limited', message: `webhook exceeds ${rpm}/min` });
        }
      }
      // Auth.
      const auth = webhookAuthOf(node);
      if (auth.mode !== 'none') {
        let secret: string | null = null;
        if (auth.credentialId) {
          try {
            const rec = await getCredentialRec(auth.credentialId);
            if (rec) secret = decryptSecret(rec.secret_enc);
          } catch { /* fall through to misconfigured */ }
        }
        if (!secret) {
          recordWebhookReject('misconfigured');
          return res.status(500).json({ error: 'misconfigured', message: 'webhook auth misconfigured (unknown credential)' });
        }
        const got = String(req.headers[auth.header] || '');
        let ok = false;
        if (auth.mode === 'secret-header') {
          const a = Buffer.from(got);
          const b = Buffer.from(secret);
          ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
        } else if (auth.mode === 'hmac-sha256') {
          const crypto = require('crypto');
          const raw = ((req as any).rawBody as Buffer) || Buffer.from(JSON.stringify((req as any).body || ''));
          const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
          const norm = got.startsWith('sha256=') ? got.slice(7) : got;
          const a = Buffer.from(norm);
          const b = Buffer.from(expected);
          ok = norm.length > 0 && a.length === b.length && timingSafeEqual(a, b);
        } else if (auth.mode === 'jwt') {
          ok = verifyJwtHS256(got, secret, node);
        } else {
          recordWebhookReject('misconfigured');
          return res.status(500).json({ error: 'misconfigured', message: `unknown webhook auth mode '${auth.mode}'` });
        }
        if (!ok) {
          recordWebhookReject('unauthorized');
          return res.status(401).json({ error: 'unauthorized', message: 'invalid webhook credentials' });
        }
      }
      // Idempotency: replayed delivery keys within TTL are rejected (409).
      const idem = (params as any)?.idempotency;
      if (idem && typeof idem === 'object' && typeof idem.header === 'string' && idem.header) {
        const keyVal = String(req.headers[String(idem.header).toLowerCase()] || '');
        if (keyVal) {
          const ttlMs = Math.min(Math.max(Number(idem.ttlSeconds) || 3600, 60), 86400) * 1000;
          const dk = `${wf.id}:${keyVal.slice(0, 256)}`;
          const seenAt = webhookDedupe.get(dk);
          if (seenAt && nowMs - seenAt < ttlMs) {
            recordWebhookReject('duplicate');
            return res.status(409).json({ error: 'duplicate_delivery', message: 'delivery key already processed' });
          }
          webhookDedupe.set(dk, nowMs);
          if (webhookDedupe.size > 10000) {
            for (const [k, t] of webhookDedupe) {
              if (nowMs - t >= ttlMs) webhookDedupe.delete(k);
              if (webhookDedupe.size <= 8000) break;
            }
          }
        }
      }
      let input: any = {};
      if (req.method === 'GET' || req.method === 'HEAD') {
        input = { query: req.query || {} };
      } else {
        try {
          if (Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8') > 200 * 1024) {
            return res.status(413).json({ error: 'payload_too_large', message: 'webhook body ≤200KB' });
          }
        } catch { return res.status(400).json({ error: 'invalid_body' }); }
        input = (req.body && typeof req.body === 'object' ? req.body : { value: req.body }) || {};
        if (Object.keys(req.query || {}).length) (input as any)._query = req.query;
      }
      const startedAt = new Date().toISOString();
      const r = await runWorkflow(
        { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
        input,
        { triggeredBy: 'webhook', principal: null, credentialResolver },
      );
      const finishedAt = new Date().toISOString();
      recordRun('webhook', r.status, r.nodeRuns);
      const exec = await createExecutionRec({
        workflow_id: wf.id, workflow_name: wf.name, status: r.status,
        input, output: r.output, node_runs: r.nodeRuns as any,
        error: (r as any).error ?? null, triggered_by: 'webhook',
        principal: null, actor: actorFor(wf.id, null), startedAt, finishedAt,
      });
      res.status(r.status === 'success' ? 200 : 500).json({ ok: r.status === 'success', output: r.output, executionId: exec.id, error: (r as any).error ?? undefined });
    } catch (e: any) {
      console.error('[workflow] webhook failed:', e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  };
  app.all('/webhook/:path', handleInboundWebhook as any);
  app.all('/webhook/*', (async (req: express.Request, res: express.Response) => {
    (req.params as any) = { ...(req.params as any), path: String(req.path).replace(/^\/webhook\/?/, '') };
    return handleInboundWebhook(req, res);
  }) as any);

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
    let counts: any = {};
    try {
      const [wfs, execs] = await Promise.all([listWorkflowRecs(), listExecutionRecs({ limit: 1 })]);
      counts = { workflows: wfs.length };
      void execs;
    } catch { /* health never fails on db */ }
    res.json({ status: 'ok', service: 'workflow', version: VERSION, engine: 'local', db: useDb() ? 'postgres' : 'memory', selfAllowlist: selfAllowlist().length, ...counts, time: new Date().toISOString() });
  });

/** Path :id guard shared by the single-workflow routes (length + CRLF). */
function checkId(id: unknown): string | null {
  const s = String(id || '');
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function idGate(req: any, res: any): string | null {
  const id = checkId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid_id' });
    return null;
  }
  return id;
}

/** Tenant read guard (P0-3): tenant-bound rows are invisible outside their
 *  org. Returns false → caller gets 404 (existence not leaked). */
function canAccessWorkflow(w: StoredWorkflow, p: import('./store').Principal | null): boolean {
  if (!w.org_id) return true;
  return !!p?.org && p.org === w.org_id;
}

function cleanTenantField(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

/** Resolve tenant binding for create/update (P0-3). Explicit body values
 *  must stay inside the caller's own org (403 otherwise); anonymous
 *  callers (dev/tests/direct) may set them freely. */
function tenantBinding(
  req: any, body: any, cur?: StoredWorkflow,
): { ok: true; value: { org_id: string | null; account_id: string | null; run_as: string | null } } | { ok: false; status: number; error: string; message: string } {
  const p = principalFromHeaders(req);
  const pick = (key: string, fallback?: string | null): string | null => {
    const raw = (body || {})[key];
    if (raw !== undefined && raw !== null && String(raw) !== '') {
      const c = cleanTenantField(raw);
      if (c === null) throw { status: 400, error: 'invalid_tenant', message: `${key} must be 1..128 chars` };
      return c;
    }
    if (fallback !== undefined) return fallback ?? null;
    return null;
  };
  try {
    const org_id = pick('orgId', p?.org ?? cur?.org_id ?? null);
    const account_id = pick('accountId', p?.account ?? cur?.account_id ?? null);
    const run_as = pick('runAs', cur?.run_as ?? null);
    if (p?.org && org_id && org_id !== p.org) {
      return { ok: false, status: 403, error: 'cross_tenant', message: 'cannot bind a workflow outside your own org' };
    }
    return { ok: true, value: { org_id, account_id, run_as } };
  } catch (e: any) {
    if (e?.status) return { ok: false, status: e.status, error: e.error, message: e.message };
    throw e;
  }
}

  // List workflows. Authenticated callers (gateway-stamped principal) see
  // their own tenant slice plus legacy-global rows (pre-tenancy, org-free);
  // other tenants' rows are hidden. Explicit ?orgId=/accountId= filters
  // exactly. Anonymous direct calls keep the legacy global view (dev/tests).
  app.get('/v1/workflows', async (req, res) => {
    const p = principalFromHeaders(req);
    const q = req.query as any;
    if (typeof q.orgId === 'string' && q.orgId) {
      const all = await listWorkflowRecs({ orgId: q.orgId.slice(0, 128) });
      res.json(all.map(toApiWorkflow));
      return;
    }
    if (typeof q.accountId === 'string' && q.accountId) {
      const all = await listWorkflowRecs({ accountId: q.accountId.slice(0, 128) });
      res.json(all.map(toApiWorkflow));
      return;
    }
    const all = await listWorkflowRecs();
    const visible = p?.org ? all.filter((w) => !w.org_id || w.org_id === p.org) : all;
    res.json(visible.map(toApiWorkflow));
  });

  // Get one workflow
  app.get('/v1/workflows/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const w = await getWorkflowRec(id);
    if (!w || !canAccessWorkflow(w, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    res.json(toApiWorkflow(w));
  });

  // Create workflow from template or raw definition
  app.post('/v1/workflows', async (req, res) => {
    const { name, definition, template, settings } = (req.body || {}) as any;
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
    }
    if (template != null && (typeof template !== 'string' || !/^[a-z0-9-]{1,64}$/.test(template))) {
      return res.status(400).json({ error: 'invalid_template', message: 'unknown template (see GET /v1/templates)' });
    }
    if (template != null && definition != null) {
      return res.status(400).json({ error: 'ambiguous_source', message: 'pass either template or definition, not both' });
    }
    const fromTemplate = Boolean(template && !definition);
    let payload: any = definition;
    if (fromTemplate) {
      payload = buildTemplate(template, (name as string) || template);
      if (!payload) return res.status(400).json({ error: 'unknown_template', available: listTemplates().map((t) => t.name) });
      // Template webhook paths must not collide: two active workflows sharing
      // a path makes /webhook/:path routing ambiguous. Suffix -2, -3, ….
      try {
        const hookIdx = (payload.nodes || []).findIndex((n: any) => (n as any)?.type === 'n8n-nodes-base.webhook');
        if (hookIdx >= 0) {
          const basePath = String(payload.nodes[hookIdx]?.parameters?.path || 'hook').replace(/^\/+|\/+$/g, '') || 'hook';
          const existing = new Set<string>();
          for (const w of await listWorkflowRecs()) {
            for (const n of (w.nodes || []) as any[]) {
              if ((n as any)?.type === 'n8n-nodes-base.webhook') {
                const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
                if (p) existing.add(p);
              }
            }
          }
          let cand = basePath;
          for (let i = 2; existing.has(cand); i++) cand = `${basePath}-${i}`;
          payload.nodes[hookIdx] = {
            ...payload.nodes[hookIdx],
            parameters: { ...(payload.nodes[hookIdx]?.parameters || {}), path: cand },
          };
        }
      } catch { /* uniquify is best-effort */ }
    }
    if (!payload) return res.status(400).json({ error: 'definition or template required' });
    // Built-in templates are trusted (fixed code); custom definitions get full validation.
    const defErr = fromTemplate ? null : validateDefinition(payload);
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    let settingsOut: Record<string, any> = {};
    // m10: explicit top-level settings win; definition.settings carries over
    // (e.g. Duplicate) when no top-level value is given.
    const settingsCand = settings ?? (payload as any).settings;
    if (settingsCand !== undefined && settingsCand !== null) {
      if (typeof settingsCand !== 'object' || Array.isArray(settingsCand)) {
        return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
      }
      try {
        if (Buffer.byteLength(JSON.stringify(settingsCand), 'utf8') > 8 * 1024) {
          return res.status(400).json({ error: 'invalid_settings', message: 'settings ≤8KB' });
        }
      } catch { return res.status(400).json({ error: 'invalid_settings', message: 'settings must be JSON-serializable' }); }
      settingsOut = settingsCand;
    }
    // P0-3: tenant binding — explicit body org/account must stay inside the
    // caller's own org; otherwise inherit from the stamped principal.
    const tenant = tenantBinding(req, req.body || {});
    if (!tenant.ok) return res.status(tenant.status).json({ error: tenant.error, message: tenant.message });
    const w = await createWorkflowRec({
      name: String(name || payload.name || 'synapsedx-workflow').slice(0, 200),
      nodes: payload.nodes || [],
      connections: payload.connections || {},
      settings: settingsOut,
      ...tenant.value,
      owner_sub: principalFromHeaders(req)?.sub ?? null,
    });
    res.status(201).json(toApiWorkflow(w));
  });

  // Update workflow name and/or definition.
  app.put('/v1/workflows/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { name, definition, settings, orgId, accountId, runAs } = (req.body || {}) as any;
    if (name == null && definition == null && settings == null && orgId == null && accountId == null && runAs == null) {
      return res.status(400).json({ error: 'invalid_body', message: 'name and/or definition and/or settings and/or tenant fields required' });
    }
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
    }
    const cur = await getWorkflowRec(id);
    if (!cur || !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    let nodes = cur.nodes;
    let connections = cur.connections;
    if (definition != null) {
      const defErr = validateDefinition(definition);
      if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
      nodes = (definition as any).nodes || [];
      connections = (definition as any).connections || {};
      // A `settings` key inside `definition`, if any, is intentionally ignored.
    }
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify({ nodes, connections }), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (size > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'definition ≤200KB' });
    const tenant = tenantBinding(req, req.body || {}, cur);
    if (!tenant.ok) return res.status(tenant.status).json({ error: tenant.error, message: tenant.message });
    const updated = await updateWorkflowRec(id, {
      ...(name != null ? { name } : {}),
      ...(settings != null ? { settings } : {}),
      ...tenant.value,
      nodes, connections,
    });
    res.json(toApiWorkflow(updated!));
  });

  // Execute workflow: run the local DAG immediately with the given input.
  // Unlike the old n8n proxy (webhook-only + must be active), manual execute
  // via the authenticated API works for ANY trigger type and regardless of
  // the active flag — activating only gates cron + public /webhook/*.
  // This fixes cron/manual workflows being un-runnable from the Console.
  app.post('/v1/workflows/:id/execute', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    let bodySize = 0;
    try { bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (bodySize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'execute body ≤200KB' });
    const wf = await getWorkflowRec(id);
    const principal = principalFromHeaders(req);
    if (!wf || !canAccessWorkflow(wf, principal)) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    const input = (req.body && typeof req.body === 'object' ? req.body : { value: req.body }) || {};
    const startedAt = new Date().toISOString();
    const r = await runWorkflow(
      { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
      input,
      { triggeredBy: 'manual', principal, credentialResolver },
    );
    const finishedAt = new Date().toISOString();
    recordRun('manual', r.status, r.nodeRuns);
    const exec = await createExecutionRec({
      workflow_id: wf.id, workflow_name: wf.name, status: r.status,
      input, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'manual',
      principal, actor: actorFor(wf.id, principal), startedAt, finishedAt,
    });
    res.status(r.status === 'success' ? 200 : 500).json({
      ok: r.status === 'success',
      output: r.output,
      executionId: exec.id,
      status: r.status,
      ...(r.status === 'error' ? { error: (r as any).error } : {}),
    });
  });

  // Activate / deactivate
  app.post('/v1/workflows/:id/activate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (!cur || !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    // Re-validate the stored definition: schedules that never fire and
    // webhook misconfigurations must fail loudly here, not silently.
    const defErr = validateDefinition({ nodes: cur.nodes, connections: cur.connections });
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    // M7: two active workflows sharing a webhook path make /webhook/:path
    // routing ambiguous — refuse with 409 so the clash is explicit.
    try {
      const trig = findWebhookTrigger({ nodes: cur.nodes });
      if (trig) {
        const all = await listWorkflowRecs();
        const clash = all.find((w) => {
          if (w.id === id || !w.active) return false;
          return (w.nodes || []).some((n: any) => {
            if ((n as any)?.type !== 'n8n-nodes-base.webhook') return false;
            return String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '') === trig.path;
          });
        });
        if (clash) {
          return res.status(409).json({
            error: 'webhook_path_conflict',
            message: `webhook path '${trig.path}' already serves active workflow '${clash.name}' (${clash.id}) — change the path or deactivate it first`,
          });
        }
      }
    } catch { /* conflict scan is best-effort */ }
    const w = await updateWorkflowRec(id, { active: true });
    if (!w) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json(toApiWorkflow(w));
  });

  app.post('/v1/workflows/:id/deactivate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (cur && !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    const w = await updateWorkflowRec(id, { active: false });
    if (!w) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json(toApiWorkflow(w));
  });

  // Executions list. Same allowlist contract as before.
  app.get('/v1/executions', async (req, res) => {
    const q = req.query as any;
    let limit = 20;
    let offset = 0;
    if (q.limit !== undefined) {
      if (typeof q.limit !== 'string' || !/^\d{1,4}$/.test(q.limit)) {
        return res.status(400).json({ error: 'invalid_query', message: 'limit must be a 0..9999 integer' });
      }
      limit = Math.min(Number(q.limit), 100) || 20;
    }
    if (q.offset !== undefined) {
      if (typeof q.offset !== 'string' || !/^\d{1,4}$/.test(q.offset)) {
        return res.status(400).json({ error: 'invalid_query', message: 'offset must be a 0..9999 integer' });
      }
      // offset=0 (any spelling) means first page.
      offset = Number(q.offset) === 0 ? 0 : Number(q.offset);
    }
    const workflowId = typeof q.workflowId === 'string' && q.workflowId.length <= 256 ? q.workflowId : undefined;
    if (workflowId && /[\r\n]/.test(workflowId)) return res.status(400).json({ error: 'invalid_query', message: 'bad workflowId' });
    const status = typeof q.status === 'string' && q.status.length <= 32 ? q.status : undefined;
    if (status && !['success', 'error', 'running'].includes(status)) {
      return res.status(400).json({ error: 'invalid_query', message: 'status must be success|error|running' });
    }
    // M10: test runs persist server-side — filterable so history views can
    // include or exclude them (triggeredBy=manual|webhook|cron|test).
    const triggeredBy = typeof q.triggeredBy === 'string' && q.triggeredBy.length <= 32 ? q.triggeredBy : undefined;
    if (triggeredBy && !['manual', 'webhook', 'cron', 'test'].includes(triggeredBy)) {
      return res.status(400).json({ error: 'invalid_query', message: 'triggeredBy must be manual|webhook|cron|test' });
    }
    const includeData = q.includeData === 'true';
    const { items } = await listExecutionRecs({ workflowId, status, triggeredBy, limit, offset });
    const mapped = items.map((e) => toApiExecution(e, includeData));
    // Console accepts both a raw array and {data: []} — return the envelope
    // with data for forward-compat (n8n proxied {data} before).
    res.json({ data: mapped });
  });

  // Get one execution.
  app.get('/v1/executions/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const e = await getExecutionRec(id);
    if (!e) return res.status(404).json({ error: 'not_found', message: 'execution not found' });
    const includeData = (req.query as any).includeData === 'true';
    res.json(toApiExecution(e, includeData));
  });

  // Delete a workflow.
  app.delete('/v1/workflows/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (cur && !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    const ok = await deleteWorkflowRec(id);
    if (!ok) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json({ ok: true, id });
  });

  // ---------- credentials (P0-4): account-scoped secrets, encrypted at rest ----------
  // Nodes store only credentialIds; secrets are resolved server-side at run
  // time and never appear in nodeRuns, params or list responses.
  function credentialAccountScope(req: any, accountId: string): { ok: boolean; status?: number; error?: string; message?: string } {
    const p = principalFromHeaders(req);
    if (p?.account && p.account !== accountId) {
      return { ok: false, status: 403, error: 'cross_account', message: 'credential account is outside your own account' };
    }
    return { ok: true };
  }

  app.get('/v1/credentials', async (req, res) => {
    const q = req.query as any;
    const accountId = typeof q.accountId === 'string' ? q.accountId : principalFromHeaders(req)?.account;
    if (accountId) {
      const scope = credentialAccountScope(req, accountId);
      if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
      const items = await listCredentialRecs(accountId);
      return res.json({ data: items.map(toPublicCredential) });
    }
    // No account scope: anonymous dev view only (never secret material).
    if (principalFromHeaders(req)) {
      return res.status(400).json({ error: 'account_required', message: 'pass ?accountId= (credentials are account-scoped)' });
    }
    const items = await listCredentialRecs();
    res.json({ data: items.map(toPublicCredential) });
  });

  app.post('/v1/credentials', async (req, res) => {
    const { accountId, name, kind, secret } = (req.body || {}) as any;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\r\n]/.test(accountId)) {
      return res.status(400).json({ error: 'invalid_account', message: 'accountId must be 1..128 chars' });
    }
    const scope = credentialAccountScope(req, accountId);
    if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
    if (typeof name !== 'string' || !name || name.length > 100) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 chars' });
    }
    if (!['bearer', 'api-key', 'basic', 'hmac'].includes(kind)) {
      return res.status(400).json({ error: 'invalid_kind', message: 'kind must be bearer|api-key|basic|hmac' });
    }
    if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret, 'utf8') > 8 * 1024) {
      return res.status(400).json({ error: 'invalid_secret', message: 'secret must be 1..8KB' });
    }
    if (kind === 'basic') {
      try {
        const parsed = JSON.parse(secret);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).password !== 'string') {
          return res.status(400).json({ error: 'invalid_secret', message: 'basic secret must be JSON {username, password}' });
        }
      } catch {
        return res.status(400).json({ error: 'invalid_secret', message: 'basic secret must be JSON {username, password}' });
      }
    }
    try {
      const c = await createCredentialRec({ account_id: accountId, name, kind, secret });
      res.status(201).json(toPublicCredential(c));
    } catch (e: any) {
      if ((e as any)?.code === 'conflict') return res.status(409).json({ error: 'conflict', message: (e as any).message });
      throw e;
    }
  });

  app.delete('/v1/credentials/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getCredentialRec(id);
    if (!cur) return res.status(404).json({ error: 'not_found', message: 'credential not found' });
    const scope = credentialAccountScope(req, cur.account_id);
    if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
    await deleteCredentialRec(id);
    res.json({ ok: true, id });
  });

  // ---------- /metrics (P2): Prometheus exposition ----------
  app.get('/metrics', async (_req, res) => {
    const lines = [
      '# HELP synapsedx_workflow_runs_total Workflow executions by trigger and status.',
      '# TYPE synapsedx_workflow_runs_total counter',
      ...[...metricRuns.entries()].map(([k, v]) => {
        const [triggeredBy, status] = k.split('|');
        return `synapsedx_workflow_runs_total{triggered_by="${triggeredBy}",status="${status}"} ${v}`;
      }),
      '# HELP synapsedx_workflow_webhook_rejected_total Rejected inbound webhook calls by reason.',
      '# TYPE synapsedx_workflow_webhook_rejected_total counter',
      ...[...metricWebhookRejected.entries()].map(([reason, v]) => `synapsedx_workflow_webhook_rejected_total{reason="${reason}"} ${v}`),
    ];
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Test-run a definition without saving (validates + executes in sandbox).
  // Powers the editor's "try code/set/if" before Save. Persists as a
  // triggered_by=test execution — pass { workflowId } of a saved workflow
  // to attach it to that workflow's history, otherwise it lands under a
  // synthetic test-* id (visible in unfiltered /v1/executions).
  app.post('/v1/workflows/test-run', async (req, res) => {
    const { definition, input, workflowId } = (req.body || {}) as any;
    if (!definition) return res.status(400).json({ error: 'definition required' });
    const defErr = validateDefinition(definition);
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    let inSize = 0;
    try { inSize = Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (inSize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'input ≤200KB' });
    let attach: StoredWorkflow | null = null;
    if (workflowId !== undefined && workflowId !== null && workflowId !== '') {
      if (typeof workflowId !== 'string' || workflowId.length > 128 || /[\r\n]/.test(workflowId)) {
        return res.status(400).json({ error: 'invalid_workflow_id' });
      }
      attach = await getWorkflowRec(workflowId);
      if (!attach || !canAccessWorkflow(attach, principalFromHeaders(req))) {
        return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
      }
    }
    const principal = principalFromHeaders(req);
    const startedAt = new Date().toISOString();
    const r = await runWorkflow(definition, input ?? {}, { triggeredBy: 'test', principal, credentialResolver });
    const finishedAt = new Date().toISOString();
    recordRun('test', r.status, r.nodeRuns);
    const wfId = attach ? attach.id : `test-${randomUUID().slice(0, 8)}`;
    const exec = await createExecutionRec({
      workflow_id: wfId, workflow_name: attach ? attach.name : 'test-run', status: r.status,
      input: input ?? {}, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'test',
      principal, actor: actorFor(wfId, principal), startedAt, finishedAt,
    });
    res.status(r.status === 'success' ? 200 : 500).json({
      ok: r.status === 'success', output: r.output, nodeRuns: r.nodeRuns,
      executionId: exec.id, error: (r as any).error ?? undefined,
    });
  });

  // Built-in templates (versioned JSON)
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
    if (err?.status === 413 || err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

export function listTemplates() {
  return [
    { name: 'webhook-to-log', description: 'Webhook receives a gateway event -> writes a log -> replies 200' },
    { name: 'cron-etl', description: 'Nightly cron -> fetches API health -> transforms -> logs' },
    { name: 'iam-webhook', description: 'Receives IAM events (user.created) -> calls back into the API' },
    { name: 'code-transform', description: 'Webhook -> sandboxed JS transform -> conditional branch -> set fields' },
    { name: 'manual-starter', description: 'Manual trigger -> code transform -> set fields (click Execute to try)' },
  ];
}

export { isBlockedUrl, validateDefinition, findSsrfUrl };

/** Webhook trigger of a workflow: validated path + declared HTTP method. */
export interface WebhookTrigger {
  path: string;
  method: string;
}

export function findWebhookTrigger(workflow: any): WebhookTrigger | null {
  try {
    const nodes = workflow?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      if ((n as any)?.type !== 'n8n-nodes-base.webhook') continue;
      const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
      if (!p || p.length > 128) continue;
      if (!/^[A-Za-z0-9_.\/-]+$/.test(p)) continue;
      if (p.split('/').includes('..')) continue;
      const raw = String((n as any)?.parameters?.httpMethod || 'POST').toUpperCase();
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(raw) ? raw : 'POST';
      return { path: p, method };
    }
  } catch { /* ignore */ }
  return null;
}

/** First webhook trigger path of a workflow definition, or null. */
export function findWebhookPath(workflow: any): string | null {
  return findWebhookTrigger(workflow)?.path || null;
}

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
  if (name === 'code-transform') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'transform', httpMethod: 'POST' } },
        { id: wid(), name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' } },
        { id: wid(), name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 1, position: [600, 300], parameters: { condition: '$input.doubled > 10' } },
        { id: wid(), name: 'Big', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 220], parameters: { values: { tag: 'big' } } },
        { id: wid(), name: 'Small', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 380], parameters: { values: { tag: 'small' } } },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
        Transform: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
        // if: main[0] = true branch, main[1] = false branch
        Check: { main: [[{ node: 'Big', type: 'main', index: 0 }], [{ node: 'Small', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'manual-starter') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        { id: wid(), name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' } },
        { id: wid(), name: 'Tag', type: 'n8n-nodes-base.set', typeVersion: 1, position: [600, 300], parameters: { values: { tag: 'processed' } } },
      ],
      connections: {
        Manual: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
        Transform: { main: [[{ node: 'Tag', type: 'main', index: 0 }]] },
      },
    };
  }
  return null;
}

// ---- cron scheduler (in-process, production-safe single-replica default) ----
const lastCronRun = new Map<string, number>();
function startCronLoop(): void {
  const everyMs = Math.max(10000, Number(process.env.WORKFLOW_CRON_TICK_MS || 15000));
  const tick = async () => {
    try {
      const actives = await listActiveCronWorkflows();
      const now = Date.now();
      for (const wf of actives) {
        const interval = workflowCronIntervalMs({ nodes: wf.nodes as any });
        const wallClock = !interval ? workflowCronNextRunAt({ nodes: wf.nodes as any }, now) : null;
        if (!interval && !wallClock) continue;
        const last = lastCronRun.get(wf.id) || 0;
        if (interval) {
          if (now - last < interval) continue;
        } else if (!(wallClock && wallClock <= now && last < wallClock)) {
          continue;
        }
        lastCronRun.set(wf.id, now);
        try {
          const startedAt = new Date().toISOString();
          const r = await runWorkflow(
            { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
            { scheduledAt: startedAt },
            { triggeredBy: 'cron', principal: null, credentialResolver },
          );
          const finishedAt = new Date().toISOString();
          recordRun('cron', r.status, r.nodeRuns);
          await createExecutionRec({
            workflow_id: wf.id, workflow_name: wf.name, status: r.status,
            input: { scheduledAt: startedAt }, output: r.output, node_runs: r.nodeRuns as any,
            error: (r as any).error ?? null, triggered_by: 'cron',
            principal: null, actor: actorFor(wf.id, null), startedAt, finishedAt,
          });
          console.log(`[workflow][cron] ${wf.name} (${wf.id}) -> ${r.status}`);
        } catch (e: any) {
          console.error(`[workflow][cron] ${wf.id} failed:`, e?.message || e);
        }
      }
    } catch (e: any) {
      console.error('[workflow][cron] tick failed:', e?.message || e);
    }
  };
  setInterval(tick, everyMs).unref?.();
  // Jittered first tick so a fresh deploy doesn't thundering-herd crons.
  setTimeout(tick, Math.min(everyMs, 5000)).unref?.();
}

if (require.main === module) {
  ensureTables().catch(() => undefined).finally(() => {
    const app = createApp();
    startCronLoop();
    const server = app.listen(PORT, () => console.log(`[workflow] listening on :${PORT} engine=local db=${useDb() ? 'postgres' : 'memory'}`));
    const shutdown = () => {
      console.log('[workflow] shutting down...');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

// Exported for tests (start loop only under main).
export { detectCycle, ensureTables, startCronLoop };
