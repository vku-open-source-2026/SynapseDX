/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { z } from 'zod';
import {
  createOrganization, listOrganizations, getOrgBySlug,
  createAccount, listAccounts, upsertUser, listUsers, getUserById, createRole, createPolicy,
  attachPolicy, assignRole, detachPolicy, unassignRole, policiesForUser, useDb, deleteRole, deletePolicy,
  createServiceAccount, listServiceAccounts, getServiceAccount,
  listRoles, listPolicies, logAudit, listAudit, purgeAudit,
  getRoleById, getPolicyById, getAccountById, accountsForUser, getOrgById,
  policiesForRole, rolesForUser,
} from './db';
import { evaluatePolicies, validatePolicyDocument } from './policy';
import { signAccess, newRefreshToken, storeRefresh, consumeRefresh, revokeRefresh, revokeAllRefresh, consumeAndRevokeRefresh, findRefreshOwner, refreshExpiry, revokeApiKey, createApiKeyRecord, verifyApiKey, verifyAccess, listApiKeys, findApiKeyById } from './tokens';
import { secretsEqual } from './db';
import { signState, exchangeCode, oidcSettings, OidcError } from './oidc';

dotenv.config();
const PORT = Number(process.env.PORT || 4001);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const IS_PROD = process.env.NODE_ENV === 'production';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean { return UUID_RE.test(s || ''); }
function firstHeader(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] || '') : (v || '');
}
/** Strip control chars / angle brackets to blunt stored-XSS via display names. */
function sanitizeName(s: string, max = 200): string {
  return String(s || '').trim().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, max);
}
/** Cap caller-supplied audit context (DoS via 1mb JSON body full of context). */
function capContext(ctx: any, maxBytes = 8192): any {
  if (!ctx || typeof ctx !== 'object') return {};
  try {
    let raw = JSON.stringify(ctx);
    if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return ctx;
    const out: any = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (Buffer.byteLength(JSON.stringify(out), 'utf8') > maxBytes) break;
      const vs = String(JSON.stringify(v) || '').slice(0, 512);
      try { out[String(k).slice(0, 64)] = JSON.parse(vs); } catch { out[String(k).slice(0, 64)] = vs.slice(0, 512); }
    }
    return out;
  } catch { return {}; }
}
function noStore(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store');
}
/** Tenant membership of the caller: account ids they may act for.
 *  Prefers the gateway-stamped header (verified principal) — but ONLY when
 *  the internal secret is configured (prod): without it, direct callers could
 *  spoof any x-synapsedx-* header, so stamped values are ignored and the
 *  presented credential is always verified directly. Null = unresolvable. */
async function resolveCallerAccounts(req: express.Request, trustStamped: boolean): Promise<string[] | null> {
  if (trustStamped) {
    const stamped = firstHeader(req.headers['x-synapsedx-account'] as any);
    if (stamped) return [stamped];
  }
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    try {
      const claims = verifyAccess(h.slice(7));
      if (claims.account) return [claims.account];
      if (claims.sub) return await accountsForUser(claims.sub);
      return [];
    } catch {
      return null;
    }
  }
  const apiKey = firstHeader(req.headers['x-api-key'] as any);
  if (apiKey) {
    try {
      const rec = await verifyApiKey(apiKey);
      return rec?.account_id ? [rec.account_id] : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Owning org of the caller (same stamped-trust rule as accounts).
 *  Service-account (machine) tokens are strictly account-bound → null. */
async function resolveCallerOrg(req: express.Request, trustStamped: boolean): Promise<string | null> {
  if (trustStamped) {
    const so = firstHeader(req.headers['x-synapsedx-org'] as any);
    if (so) return so;
  }
  const h = firstHeader(req.headers.authorization as any);
  if (h.startsWith('Bearer ')) {
    try {
      const claims = verifyAccess(h.slice(7));
      if (claims.kind === 'service-account') return null;
      if (!claims.sub) return null;
      const user = await getUserById(claims.sub);
      return user?.org_id || null;
    } catch {
      return null;
    }
  }
  const apiKey = firstHeader(req.headers['x-api-key'] as any);
  if (apiKey) {
    try {
      const rec = await verifyApiKey(apiKey);
      if (!rec?.account_id) return null;
      const acc = await getAccountById(rec.account_id);
      return acc?.org_id || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** May the caller act for `accountId`? Role-based account membership first,
 *  then same-org fallback (login JWTs carry org but no account, and fresh
 *  users hold no roles yet — without this the bootstrap flow could never mint
 *  its first token). Tenant boundary stays the org. Machine
 *  (service-account) tokens are account-bound: no org fallback. */
async function canActForAccount(req: express.Request, trustStamped: boolean, accountId: string): Promise<boolean> {
  const accounts = await resolveCallerAccounts(req, trustStamped);
  if (accounts && accounts.includes(accountId)) return true;
  const org = await resolveCallerOrg(req, trustStamped);
  if (!org) return false;
  const acc = await getAccountById(accountId);
  return !!acc && acc.org_id === org;
}

/** May the caller act for `orgId`? Same stamped-trust rule; service-account
 *  tokens are account-scoped, never org-scoped. */
async function canActForOrg(req: express.Request, trustStamped: boolean, orgId: string): Promise<boolean> {
  const org = await resolveCallerOrg(req, trustStamped);
  return !!org && org === orgId;
}
export function isDevLoginEnabled(): boolean {
  if (IS_PROD) return false; // fail-closed in production regardless of env
  return (process.env.IAM_ALLOW_DEV_LOGIN || 'true') === 'true';
}
export function isDemoCallbackEnabled(): boolean {
  if (IS_PROD) return false;
  return (process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK || 'true') === 'true';
}
/** Tiny in-memory rate limiter (no Redis dep): per-IP token bucket. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref?.();
  void timer;
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = String(req.ip || req.socket?.remoteAddress || 'anon').slice(0, 64);
    const now = Date.now();
    const cur = hits.get(ip);
    if (!cur || cur.reset < now) { hits.set(ip, { n: 1, reset: now + windowMs }); return next(); }
    cur.n++;
    if (cur.n > max) return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down' });
    return next();
  };
}

export function createApp(): express.Express {
  // Fail-closed production guards (checked at boot, before serving anything).
  if (IS_PROD) {
    if ((process.env.IAM_ALLOW_DEV_LOGIN || 'false') === 'true') {
      throw new Error('[iam] IAM_ALLOW_DEV_LOGIN=true is forbidden in production (passwordless mint). Set false.');
    }
    if ((process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK || 'false') === 'true') {
      throw new Error('[iam] IAM_ALLOW_OIDC_DEMO_CALLBACK=true is forbidden in production (impersonation). Set false.');
    }
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[iam] SYNAPSEDX_INTERNAL_SECRET must be set in production (else :4001 is reachable directly).');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[iam] DATABASE_URL must be set in production (in-memory fallback would split-brain).');
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
      if (!IS_PROD) console.warn('[iam][security] CORS_ORIGIN not set — allowing all origins (dev default). Set it in production.');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Echo/propagate x-request-id (gateway sets it; direct callers get one generated
  // here so every response is traceable). Sanitized like the gateway.
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({ limit: '1mb' }));

  // Defense-in-depth: IAM KHÔNG tin gateway một cách mù quáng.
  // - SYNAPSEDX_INTERNAL_SECRET (khi được set ở cả gateway + iam): mọi /v1/* (trừ
  //   /health và /v1/auth/*) phải mang header x-synapsedx-internal khớp secret.
  //   Chặn truy cập trực tiếp vào :4001 vượt mặt gateway khi secret đã cấu hình.
  // - Kể cả khi secret chưa set (dev), các route còn lại vẫn tự verify Bearer/API key.
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[iam][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production so only the gateway can reach IAM.');
  }
  // Stamped x-synapsedx-* headers are trusted ONLY when the secret is set:
  // without it, direct callers could spoof any tenant header (dev default).
  const TRUST_STAMPED = INTERNAL_SECRET.length > 0;
  // Audit retention (opt-in): hourly purge of rows older than N days.
  // Default 0 = disabled (zero behavior change); prod sets e.g. 180.
  const RETENTION_DAYS = (() => {
    const n = Number(process.env.AUDIT_RETENTION_DAYS || 0);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 3650) : 0;
  })();
  if (RETENTION_DAYS > 0) {
    const sweep = () => {
      purgeAudit(RETENTION_DAYS).then(
        (n) => {
          if (n > 0) console.log(`[iam] audit retention: purged ${n} rows older than ${RETENTION_DAYS}d`);
        },
        (e) => console.error('[iam] audit retention failed:', e?.message || e),
      );
    };
    setInterval(sweep, 60 * 60 * 1000).unref?.();
    setTimeout(sweep, 30_000).unref?.();
  }
  const PUBLIC_PREFIXES = ['/v1/auth/'];
  const PUBLIC_EXACT = new Set(['/v1/auth']);
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const p = req.path;
    if (p === '/health' || PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p.startsWith(x))) return next();
    if (INTERNAL_SECRET) {
      const got = firstHeader(req.headers['x-synapsedx-internal'] as any);
      if (!got || !secretsEqual(got, INTERNAL_SECRET)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
      }
      // Defense-in-depth: internal secret alone is NOT enough — also require a
      // valid caller credential (gateway forwards the original Authorization).
      // /v1/keys/verify is the sole exception (gateway calls it with internal only).
      if (p === '/v1/keys/verify') return next();
      const h = firstHeader(req.headers.authorization as any);
      if (h.startsWith('Bearer ')) {
        try { verifyAccess(h.slice(7)); return next(); } catch { /* fall through */ }
      }
      const apiKey = firstHeader(req.headers['x-api-key'] as any);
      if (apiKey) {
        verifyApiKey(apiKey).then(
          (rec) => (rec ? next() : res.status(401).json({ error: 'invalid_api_key' })),
          () => res.status(503).json({ error: 'iam_unavailable', message: 'credential store unreachable' }),
        );
        return;
      }
      return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT or X-API-Key' });
    }
    // Dev fallback (no internal secret): verify caller credential directly.
    const h = firstHeader(req.headers.authorization as any);
    if (h.startsWith('Bearer ')) {
      try {
        verifyAccess(h.slice(7));
        return next();
      } catch { /* fall through to apikey */ }
    }
    const apiKey = firstHeader(req.headers['x-api-key'] as any);
    if (apiKey) {
      verifyApiKey(apiKey).then(
        (rec) => (rec ? next() : res.status(401).json({ error: 'invalid_api_key' })),
        () => res.status(503).json({ error: 'iam_unavailable', message: 'credential store unreachable' }),
      );
      return;
    }
    // /v1/keys/verify is gateway-internal: in dev (no secret) still allow it so
    // GATEWAY_VERIFY_APIKEY=true keeps working without extra config.
    if (p === '/v1/keys/verify') return next();
    return res.status(401).json({ error: 'unauthorized', message: 'Provide Bearer JWT or X-API-Key' });
  }) as any);

  // Bọc mọi async handler: Express 4 không catch async throw (treo request /
  // unhandledRejection khi lỗi DB như slug trùng). Map unique-violation → 409.
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

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'iam', version: VERSION, ...(IS_PROD ? {} : { db: useDb() ? 'postgres' : 'memory' }), time: new Date().toISOString() }));

  if (isDevLoginEnabled()) {
    console.warn('[iam][security] IAM_ALLOW_DEV_LOGIN=true — passwordless dev login ENABLED (any email gets a token). Set false in production.');
  }
  if (isDemoCallbackEnabled()) {
    console.warn('[iam][security] IAM_ALLOW_OIDC_DEMO_CALLBACK=true — OIDC callback trusts caller-supplied email (impersonation possible). Set false in production.');
  }

  // Brute-force guard for credential endpoints (in-memory; edge WAF still required in prod).
  const authLimiter = rateLimit(60, 60_000);
  app.use('/v1/auth/', authLimiter as any);

  // ---------- OIDC discovery (Authentik, Keycloak, or any OIDC IdP) ----------
  app.get('/v1/auth/oidc/config', (_req, res) => {
    const cfg = oidcSettings();
    res.json({
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      provider: cfg.provider,
      codeExchange: true,
      demoCallback: isDemoCallbackEnabled(),
      note: 'Federated OIDC upstream. IAM keeps the shadow user + org/account/role/policy authorization.',
    });
  });

  app.get('/v1/auth/oidc/start', (req, res) => {
    const cfg = oidcSettings();
    const org = typeof req.query.org === 'string' && /^[a-z0-9-]{1,64}$/.test(req.query.org) ? req.query.org : 'acme';
    // HMAC-signed state binds the org + a 10-minute expiry (verified in /callback).
    const state = signState(org);
    const url = `${cfg.issuer.replace(/\/*$/, '')}/authorize?client_id=${encodeURIComponent(cfg.clientId)}&response_type=code&scope=${encodeURIComponent('openid email profile')}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&state=${state}`;
    res.json({ authorizeUrl: url, state });
  });

  // Callback: two modes.
  // 1. Real Authorization Code flow (`code` + signed `state`): exchanged at the
  //    IdP token endpoint and the ID token is signature-verified against the
  //    IdP JWKS. Works in every environment, including production.
  // 2. Demo email callback (dev only): trusts the caller-supplied email, hence
  //    impersonation-prone. Disable in production with
  //    IAM_ALLOW_OIDC_DEMO_CALLBACK=false.
  app.post('/v1/auth/oidc/callback', async (req, res) => {
    try {
      const demoAllowed = isDemoCallbackEnabled();
      const { email, sub, displayName, orgSlug, code, state } = (req.body || {}) as any;
      if (typeof code === 'string' && code) {
        if (typeof state !== 'string' || !state) {
          return res.status(400).json({ error: 'oidc_state_required', message: 'Signed `state` from /v1/auth/oidc/start is required with `code`.' });
        }
        try {
          const id = await exchangeCode(code, state);
          const org = (await getOrgBySlug(id.org)) || (await createOrganization(id.org, id.org));
          const user = await upsertUser(org.id, id.email, id.displayName, id.sub);
          const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: org.id });
          const rt = newRefreshToken();
          await storeRefresh(user.id, rt.hash, refreshExpiry());
          noStore(res);
          return res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user });
        } catch (e: any) {
          if (e instanceof OidcError) {
            return res.status(e.status).json({ error: e.code, message: e.message });
          }
          throw e;
        }
      }
      if (!demoAllowed) {
        return res.status(501).json({
          error: 'oidc_code_required',
          message: 'Demo email callback is disabled (IAM_ALLOW_OIDC_DEMO_CALLBACK=false). Provide an authorization `code` (+ signed `state`) for real IdP exchange.',
        });
      }
      const schema = z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        orgSlug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).nullish(),
      });
      const parsed = schema.safeParse({ email, orgSlug });
      if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
      const normEmail = parsed.data.email;
      const slug = parsed.data.orgSlug || 'acme';
      const safeName = sanitizeName(typeof displayName === 'string' && displayName.trim() ? displayName : normEmail);
      const safeSub = sanitizeName(typeof sub === 'string' && sub.trim() ? sub : normEmail, 320);
      const org = (await getOrgBySlug(slug)) || (await createOrganization(slug, slug));
      const user = await upsertUser(org.id, normEmail, safeName, safeSub);
      const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: org.id });
      const rt = newRefreshToken();
      await storeRefresh(user.id, rt.hash, refreshExpiry());
      noStore(res);
      res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user });
    } catch (e: any) {
      res.status(500).json({ error: 'oidc_callback_failed', message: e.message });
    }
  });

  // Dev login: cấp token trực tiếp theo email. TẮT ở production bằng
  // IAM_ALLOW_DEV_LOGIN=false (khi đó chỉ còn OIDC callback + refresh).
  app.post('/v1/auth/login', async (req, res) => {
    if (!isDevLoginEnabled()) {
      return res.status(403).json({ error: 'dev_login_disabled', message: 'Use OIDC flow' });
    }
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      orgSlug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { email, orgSlug } = parsed.data;
    const slug = orgSlug || 'acme';
    const org = (await getOrgBySlug(slug)) || (await createOrganization(slug, slug));
    const user = await upsertUser(org.id, email, email);
    const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: org.id });
    const rt = newRefreshToken();
    await storeRefresh(user.id, rt.hash, refreshExpiry());
    noStore(res);
    res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user });
  });

  // Refresh xoay vòng NGUYÊN TỬ: consume+revoke 1 bước → replay/race đều rớt.
  // Reuse signal: RT đã dùng rồi mà dùng lại → 401 + log để monitoring phát hiện
  // đánh cắp (không auto-revoke cả family để tránh giết nhầm winner trong race
  // hợp lệ; caller nghi ngờ gọi /v1/auth/logout-all).
  app.post('/v1/auth/refresh', async (req, res) => {
    const { refreshToken } = (req.body || {}) as any;
    if (!refreshToken) return res.status(400).json({ error: 'invalid_refresh_token', message: 'refreshToken required' });
    const rec = await consumeAndRevokeRefresh(refreshToken);
    if (!rec) {
      const owner = await findRefreshOwner(refreshToken).catch(() => null);
      if (owner) console.warn(`[iam][security] refresh reuse detected for user ${owner.user_id} — possible theft, recommend logout-all`);
      return res.status(401).json({ error: 'invalid_refresh' });
    }
    const rt = newRefreshToken();
    await storeRefresh(rec.user_id, rt.hash, refreshExpiry());
    const user = await getUserById(rec.user_id).catch(() => null);
    const { token, expiresIn } = signAccess(user ? { sub: user.id, email: user.email, org: user.org_id } : { sub: rec.user_id });
    noStore(res);
    res.json({ accessToken: token, expiresIn, refreshToken: rt.value });
  });

  // Logout: thu hồi refresh token.
  app.post('/v1/auth/logout', async (req, res) => {
    const { refreshToken } = (req.body || {}) as any;
    if (!refreshToken) return res.status(400).json({ error: 'invalid_refresh_token', message: 'refreshToken required' });
    await revokeRefresh(refreshToken);
    res.json({ ok: true });
  });

  // Logout mọi nơi: dùng refreshToken còn hiệu lực để chứng minh sở hữu,
  // rồi thu hồi TẤT CẢ session của chính user đó (không nhận userId tùy ý).
  app.post('/v1/auth/logout-all', async (req, res) => {
    const { refreshToken } = (req.body || {}) as any;
    if (!refreshToken) return res.status(400).json({ error: 'invalid_refresh_token', message: 'refreshToken required' });
    const rec = await consumeRefresh(refreshToken);
    if (!rec) return res.status(401).json({ error: 'invalid_refresh' });
    const revoked = await revokeAllRefresh(rec.user_id);
    res.json({ ok: true, revoked });
  });

  // Who-am-I: user record của chính Bearer token.
  app.get('/v1/auth/me', async (req, res) => {
    const h = firstHeader(req.headers.authorization as any);
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
    try {
      const decoded: any = verifyAccess(h.slice(7));
      const user = await getUserById(decoded.sub);
      if (!user) return res.status(404).json({ error: 'user_not_found' });
      res.json({ user, kind: decoded.kind || 'user' });
    } catch (e: any) {
      return res.status(401).json({ error: 'invalid_token', message: e.message });
    }
  });

  app.get('/v1/auth/verify', async (req, res) => {    const h = firstHeader(req.headers.authorization as any);
    const apiKey = firstHeader(req.headers['x-api-key'] as any);
    if (h.startsWith('Bearer ')) {
      try {
        const decoded = verifyAccess(h.slice(7));
        return res.json({ valid: true, type: 'jwt', claims: decoded });
      } catch (e: any) {
        return res.status(401).json({ valid: false, message: e.message });
      }
    }
    if (apiKey) {
      const rec = await verifyApiKey(apiKey);
      if (!rec) return res.status(401).json({ valid: false });
      return res.json({ valid: true, type: 'apikey', ...rec });
    }
    return res.status(400).json({ error: 'credential_required', message: 'provide Bearer or X-API-Key' });
  });

  // ---------- Organizations ----------
  app.get('/v1/orgs', async (_req, res) => res.json(await listOrganizations()));
  app.post('/v1/orgs', async (req, res) => {
    try {
      const schema = z.object({
        slug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/),
        displayName: z.string().trim().min(2).max(200),
      });
      const b = schema.parse(req.body);
      res.status(201).json(await createOrganization(sanitizeName(b.slug, 64), sanitizeName(b.displayName)));
    } catch (e: any) {
      if (e?.code === '23505' || e?.status === 409) {
        return res.status(409).json({ error: 'conflict', message: 'organization slug exists' });
      }
      res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  // ---------- Accounts ----------
  app.get('/v1/orgs/:orgId/accounts', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    res.json(await listAccounts(req.params.orgId));
  });
  app.post('/v1/orgs/:orgId/accounts', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    try {
      const schema = z.object({
        slug: z.string().trim().regex(/^[a-z0-9-]{1,64}$/),
        displayName: z.string().trim().min(2).max(200),
      });
      const b = schema.parse(req.body);
      if (!(await getOrgById(req.params.orgId))) return res.status(404).json({ error: 'org_not_found' });
      if (!(await canActForOrg(req, TRUST_STAMPED, req.params.orgId))) {
        return res.status(403).json({ error: 'forbidden', message: 'organization belongs to another tenant' });
      }
      res.status(201).json(await createAccount(req.params.orgId, b.slug, sanitizeName(b.displayName)));
    } catch (e: any) {
      if (e?.code === '23505' || e?.status === 409) {
        return res.status(409).json({ error: 'conflict', message: 'account slug exists' });
      }
      res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  // ---------- Users ----------
  app.post('/v1/orgs/:orgId/users', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      // nullish (not just optional): SDKs often serialize missing fields as
      // explicit null (e.g. Python display_name=None) — accept both.
      displayName: z.string().trim().max(200).nullish(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    if (!(await getOrgById(req.params.orgId))) return res.status(404).json({ error: 'org_not_found' });
    const { email, displayName } = parsed.data;
    if (!(await canActForOrg(req, TRUST_STAMPED, req.params.orgId))) {
      return res.status(403).json({ error: 'forbidden', message: 'organization belongs to another tenant' });
    }
    res.status(201).json(await upsertUser(req.params.orgId, email, displayName ? sanitizeName(displayName) : undefined));
  });

  app.get('/v1/orgs/:orgId/users', async (req, res) => {
    if (!isUuid(req.params.orgId)) return res.status(400).json({ error: 'invalid_id', message: 'orgId must be a UUID' });
    res.json(await listUsers(req.params.orgId));
  });

  // ---------- Roles & Policies (AWS-style) ----------
  const SLUG_RE = /^[a-z0-9-]{1,64}$/;
  app.post('/v1/accounts/:accountId/roles', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { slug, description } = (req.body || {}) as any;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{1,64}$' });
    }
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.status(201).json(await createRole(req.params.accountId, slug, sanitizeName(description || '')));
  });

  app.get('/v1/accounts/:accountId/roles', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    res.json(await listRoles(req.params.accountId));
  });

  // Policies attached to one role (management UI + attach verification).
  app.get('/v1/roles/:roleId/policies', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    res.json(await policiesForRole(req.params.roleId));
  });

  app.delete('/v1/roles/:roleId', async (req, res) => {    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    const ok = await deleteRole(req.params.roleId);
    if (!ok) return res.status(404).json({ error: 'role_not_found' });
    res.json({ ok: true });
  });

  app.post('/v1/accounts/:accountId/policies', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { slug, description, document } = (req.body || {}) as any;
    if (!slug || !document) return res.status(400).json({ error: 'slug+document required' });
    if (typeof slug !== 'string' || !/^[a-z0-9-]{1,64}$/.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{1,64}$' });
    }
    const docErr = validatePolicyDocument(document);
    if (docErr) return res.status(400).json({ error: 'invalid_document', message: docErr });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.status(201).json(await createPolicy(req.params.accountId, slug, sanitizeName(description || ''), document));
  });

  app.get('/v1/accounts/:accountId/policies', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    res.json(await listPolicies(req.params.accountId));
  });

  app.delete('/v1/policies/:policyId', async (req, res) => {
    if (!isUuid(req.params.policyId)) return res.status(400).json({ error: 'invalid_id', message: 'policyId must be a UUID' });
    const pol = await getPolicyById(req.params.policyId);
    if (!pol) return res.status(404).json({ error: 'policy_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, pol.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'policy belongs to another tenant' });
    }
    const ok = await deletePolicy(req.params.policyId);
    if (!ok) return res.status(404).json({ error: 'policy_not_found' });
    res.json({ ok: true });
  });

  app.post('/v1/roles/:roleId/attach', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    if (!req.body?.policyId) return res.status(400).json({ error: 'invalid_policyId', message: 'policyId required' });
    if (typeof req.body.policyId !== 'string' || !isUuid(req.body.policyId)) {
      return res.status(400).json({ error: 'invalid_policyId', message: 'policyId must be a UUID' });
    }
    const [role, pol] = await Promise.all([getRoleById(req.params.roleId), getPolicyById(req.body.policyId)]);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (!pol) return res.status(404).json({ error: 'policy_not_found' });
    // Cross-tenant guard: a policy from account A must never land on a role in account B.
    if (role.account_id !== pol.account_id) {
      return res.status(403).json({ error: 'cross_account', message: 'policy and role belong to different accounts' });
    }
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    await attachPolicy(req.params.roleId, req.body.policyId);
    res.json({ ok: true });
  });
  app.delete('/v1/roles/:roleId/policies/:policyId', async (req, res) => {
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    if (!isUuid(req.params.policyId)) return res.status(400).json({ error: 'invalid_id', message: 'policyId must be a UUID' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    const pol = await getPolicyById(req.params.policyId);
    if (!pol) return res.status(404).json({ error: 'policy_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, role.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'role belongs to another tenant' });
    }
    await detachPolicy(req.params.roleId, req.params.policyId);
    res.json({ ok: true });
  });
  app.post('/v1/users/:userId/assign', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    if (!req.body?.roleId) return res.status(400).json({ error: 'invalid_roleId', message: 'roleId required' });
    if (typeof req.body.roleId !== 'string' || !isUuid(req.body.roleId)) {
      return res.status(400).json({ error: 'invalid_roleId', message: 'roleId must be a UUID' });
    }
    const [user, role] = await Promise.all([getUserById(req.params.userId), getRoleById(req.body.roleId)]);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    // Cross-tenant guard: the role's account must live in the user's org.
    const acc = await getAccountById(role.account_id);
    if (!acc || acc.org_id !== user.org_id) {
      return res.status(403).json({ error: 'cross_org', message: "role's account is outside the user's organization" });
    }
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    await assignRole(req.params.userId, req.body.roleId);
    res.json({ ok: true });
  });
  app.delete('/v1/users/:userId/roles/:roleId', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    if (!isUuid(req.params.roleId)) return res.status(400).json({ error: 'invalid_id', message: 'roleId must be a UUID' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const role = await getRoleById(req.params.roleId);
    if (!role) return res.status(404).json({ error: 'role_not_found' });
    if (!(await canActForOrg(req, TRUST_STAMPED, user.org_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'user belongs to another tenant' });
    }
    await unassignRole(req.params.userId, req.params.roleId);
    res.json({ ok: true });
  });

  // ---------- Authorize (policy evaluation) ----------
  // context: caller cung cấp thêm (vd {hour, sourceIp}); server luôn ép
  // user/org/email từ DB (caller không override được) để Condition đáng tin.
  app.post('/v1/authorize', async (req, res) => {
    const { userId, action, resource, context } = (req.body || {}) as any;
    if (!userId || !action || !resource) return res.status(400).json({ error: 'userId+action+resource required' });
    if (typeof userId !== 'string' || !isUuid(userId)) return res.status(400).json({ error: 'invalid_userId', message: 'userId must be a UUID' });
    if (typeof action !== 'string' || action.length > 512 || typeof resource !== 'string' || resource.length > 2048) {
      return res.status(400).json({ error: 'invalid_action_resource', message: 'action ≤512 chars, resource ≤2048 chars' });
    }
    const docs = await policiesForUser(userId);
    const user = await getUserById(userId);
    const ctx = { ...capContext(context), user: userId, org: user?.org_id, email: user?.email };
    const verdict = evaluatePolicies(docs, { action, resource }, ctx);
    await logAudit({ actor_type: 'user', actor_id: userId, action, resource, decision: verdict.allowed, context: ctx }).catch(() => undefined);
    res.json({ allowed: verdict.allowed, matchedBy: verdict.matchedBy, evaluatedPolicies: docs.length });
  });

  // Dry-run simulator (không cần user): đánh giá documents inline, như AWS IAM Policy Simulator.
  app.post('/v1/authorize/dry-run', async (req, res) => {
    const { documents, action, resource, context } = (req.body || {}) as any;
    if (!Array.isArray(documents) || !action || !resource) {
      return res.status(400).json({ error: 'documents[]+action+resource required' });
    }
    if (documents.length > 20) return res.status(400).json({ error: 'too_many_documents', message: 'max 20 documents per dry-run' });
    if (typeof action !== 'string' || action.length > 512 || typeof resource !== 'string' || resource.length > 2048) {
      return res.status(400).json({ error: 'invalid_action_resource', message: 'action ≤512 chars, resource ≤2048 chars' });
    }
    for (const d of documents) {
      const docErr = validatePolicyDocument(d);
      if (docErr) return res.status(400).json({ error: 'invalid_document', message: docErr });
    }
    const capped = capContext(context);
    const verdict = evaluatePolicies(documents, { action, resource }, capped);
    await logAudit({ actor_type: 'dry-run', actor_id: '', action, resource, decision: verdict.allowed, context: capped }).catch(() => undefined);
    res.json({ allowed: verdict.allowed, matchedBy: verdict.matchedBy, evaluatedPolicies: documents.length });
  });

  // Audit log (đọc).
  app.get('/v1/audit', async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const actor = (req.query.actor as string) || undefined;
    const rawAllowed = req.query.allowed;
    const allowed = rawAllowed === undefined ? undefined : String(rawAllowed).toLowerCase() === 'true';
    if (rawAllowed !== undefined && !['true', 'false'].includes(String(rawAllowed).toLowerCase())) {
      return res.status(400).json({ error: 'invalid_allowed', message: 'allowed must be true or false' });
    }
    res.json(await listAudit(limit, actor, allowed));
  });

  // ---------- API keys ----------
  app.post('/v1/accounts/:accountId/keys', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { userId, name, scopes, expiresInSeconds } = (req.body || {}) as any;
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    // Format checks first (400); existence checks (404) after the body 400s.
    if (userId != null && (typeof userId !== 'string' || !isUuid(userId))) {
      return res.status(400).json({ error: 'invalid_userId', message: 'userId must be a UUID' });
    }
    const keyName = name || 'default';
    if (typeof keyName !== 'string' || keyName.length === 0 || keyName.length > 100) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 chars' });
    }
    const keyScopes: string[] = scopes || ['*'];
    if (!Array.isArray(keyScopes) || keyScopes.length === 0 || keyScopes.length > 100 ||
        keyScopes.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 200)) {
      return res.status(400).json({ error: 'invalid_scopes', message: 'scopes must be 1..100 non-empty strings ≤200 chars' });
    }
    if (expiresInSeconds != null && (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 315360000)) {
      return res.status(400).json({ error: 'invalid_expiry', message: 'expiresInSeconds must be 1..315360000' });
    }
    if (userId != null && !(await getUserById(userId))) return res.status(404).json({ error: 'user_not_found' });
    const exp = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    const k = await createApiKeyRecord(req.params.accountId, userId || null, keyName, keyScopes, exp);
    res.status(201).json({ id: k.id, apiKey: k.value, prefix: k.prefix, warning: 'Save this apiKey now — it is shown only once.' });
  });

  app.get('/v1/accounts/:accountId/keys', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    // Tenant binding (same as SA-token mint): key metadata may only be
    // enumerated by callers of the owning tenant.
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.json(await listApiKeys(req.params.accountId));
  });

  app.post('/v1/keys/verify', async (req, res) => {    const rec = await verifyApiKey((req.body || {}).apiKey || '');
    if (!rec) return res.status(401).json({ valid: false });
    res.json({ valid: true, ...rec });
  });

  app.delete('/v1/keys/:id', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id', message: 'key id must be a UUID' });
    const rec = await findApiKeyById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'key_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, rec.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'key belongs to another tenant' });
    }
    const ok = await revokeApiKey(req.params.id);
    if (!ok) return res.status(404).json({ error: 'key_not_found' });
    res.json({ ok: true });
  });

  // ---------- Service accounts (machine identity) ----------
  app.post('/v1/accounts/:accountId/service-accounts', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    const { slug, description } = (req.body || {}) as any;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{1,64}$' });
    }
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (description != null && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    if (!(await getAccountById(req.params.accountId))) return res.status(404).json({ error: 'account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, req.params.accountId))) {
      return res.status(403).json({ error: 'forbidden', message: 'account belongs to another tenant' });
    }
    res.status(201).json(await createServiceAccount(req.params.accountId, slug, sanitizeName(description || '')));
  });

  app.get('/v1/accounts/:accountId/service-accounts', async (req, res) => {
    if (!isUuid(req.params.accountId)) return res.status(400).json({ error: 'invalid_id', message: 'accountId must be a UUID' });
    res.json(await listServiceAccounts(req.params.accountId));
  });

  // Cấp JWT cho service account (kind=service-account, mang account scope).
  // Hardening: callers cannot escalate to '*' unless they already hold '*' —
  // the requested scopes must be a subset of the caller's own scopes when the
  // caller presents an API-key/JWT with limited scopes (gateway-propagated).
  // Tenant binding: the caller must belong to the SA's account — otherwise any
  // authenticated principal could mint tokens for any account's SA.
  app.post('/v1/service-accounts/:id/token', async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_id', message: 'service account id must be a UUID' });
    const scopes: string[] = req.body?.scopes || ['*'];
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 100 ||
        scopes.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 200)) {
      return res.status(400).json({ error: 'invalid_scopes', message: 'scopes must be 1..100 non-empty strings ≤200 chars' });
    }
    const sa = await getServiceAccount(req.params.id);
    if (!sa) return res.status(404).json({ error: 'service_account_not_found' });
    if (!(await canActForAccount(req, TRUST_STAMPED, sa.account_id))) {
      return res.status(403).json({ error: 'forbidden', message: 'service account belongs to another tenant' });
    }
    // Caller scopes: stamped header only when trusted — otherwise derive from
    // the verified credential itself (dev callers can't spoof their way to '*').
    let callerScopes: string[] = [];
    const stamped = firstHeader(req.headers['x-synapsedx-scopes'] as any);
    if (TRUST_STAMPED && stamped) {
      callerScopes = stamped.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      const h = firstHeader(req.headers.authorization as any);
      if (h.startsWith('Bearer ')) {
        try {
          callerScopes = verifyAccess(h.slice(7)).scopes || [];
        } catch {
          callerScopes = [];
        }
      } else {
        const apiKey = firstHeader(req.headers['x-api-key'] as any);
        if (apiKey) {
          try {
            callerScopes = (await verifyApiKey(apiKey))?.scopes || [];
          } catch {
            callerScopes = [];
          }
        }
      }
    }
    if (callerScopes.length && !callerScopes.includes('*') && scopes.includes('*')) {
      return res.status(403).json({ error: 'scope_escalation', message: 'Cannot mint wildcard scope from a limited caller' });
    }
    const { token, expiresIn } = signAccess({ sub: sa.id, account: sa.account_id, scopes, kind: 'service-account' });
    noStore(res);
    res.json({ accessToken: token, expiresIn, serviceAccount: sa });
  });

  // Liệt kê policy của user (hữu ích khi debug authorize).
  app.get('/v1/users/:userId/policies', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    res.json(await policiesForUser(req.params.userId));
  });

  // Roles assigned to one user (management UI + assign verification).
  app.get('/v1/users/:userId/roles', async (req, res) => {
    if (!isUuid(req.params.userId)) return res.status(400).json({ error: 'invalid_id', message: 'userId must be a UUID' });
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json(await rolesForUser(req.params.userId));
  });

  // 404
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Malformed JSON body (express.json SyntaxError): 400, not 500 — and never
    // leak the parse offset into logs clients can probe.
    if (err?.status === 400 || err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && /JSON/i.test(err.message))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err?.status === 413 || err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    if (err?.code === '23505' || err?.status === 409) {
      return res.status(409).json({ error: 'conflict', message: 'duplicate slug' });
    }
    // Malformed UUID in Postgres (invalid_text_representation): 400, not 500.
    if (err?.code === '22P02' || /invalid_text_representation|invalid input syntax for.*uuid/i.test(err?.message || '')) {
      return res.status(400).json({ error: 'invalid_id', message: 'malformed UUID' });
    }
    // Race check-then-insert (id bị xóa giữa chừng) → FK violation → 404, không 500.
    if (err?.code === '23503' || /foreign key|violates foreign/i.test(err?.message || '')) {
      return res.status(404).json({ error: 'invalid_reference', message: 'referenced id does not exist' });
    }
    console.error('[iam] unhandled:', err?.message || err);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const server = app.listen(PORT, () => console.log(`[iam] listening on :${PORT} db=${useDb() ? 'postgres' : 'memory'}`));
  const shutdown = () => {
    console.log('[iam] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
