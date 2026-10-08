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
  attachPolicy, assignRole, policiesForUser, useDb, deleteRole, deletePolicy,
  createServiceAccount, listServiceAccounts, getServiceAccount,
  listRoles, listPolicies, logAudit, listAudit, roleExists, policyExists,
} from './db';
import { evaluatePolicies, validatePolicyDocument } from './policy';
import { signAccess, newRefreshToken, storeRefresh, consumeRefresh, revokeRefresh, revokeAllRefresh, consumeAndRevokeRefresh, refreshExpiry, revokeApiKey, createApiKeyRecord, verifyApiKey, verifyAccess } from './tokens';
import { secretsEqual } from './db';

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

export function createApp(): express.Express {
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
  app.use(cors());
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
  const PUBLIC_PREFIXES = ['/v1/auth/'];
  const PUBLIC_EXACT = new Set(['/v1/auth']);
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const p = req.path;
    if (p === '/health' || PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p.startsWith(x))) return next();
    if (INTERNAL_SECRET) {
      const got = (req.headers['x-synapsedx-internal'] as string) || '';
      if (!got || !secretsEqual(got, INTERNAL_SECRET)) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
      }
      return next();
    }
    // Dev fallback (no internal secret): verify caller credential directly.
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) {
      try {
        verifyAccess(h.slice(7));
        return next();
      } catch { /* fall through to apikey */ }
    }
    const apiKey = (req.headers['x-api-key'] as string) || '';
    if (apiKey) {
      verifyApiKey(apiKey).then(
        (rec) => (rec ? next() : res.status(401).json({ error: 'invalid_api_key' })),
        (e) => next(e),
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

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'iam', version: VERSION, db: useDb() ? 'postgres' : 'memory', time: new Date().toISOString() }));

  if ((process.env.IAM_ALLOW_DEV_LOGIN || 'true') === 'true') {
    console.warn('[iam][security] IAM_ALLOW_DEV_LOGIN=true — passwordless dev login ENABLED (any email gets a token). Set false in production.');
  }
  if ((process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK || 'true') === 'true') {
    console.warn('[iam][security] IAM_ALLOW_OIDC_DEMO_CALLBACK=true — OIDC callback trusts caller-supplied email (impersonation possible). Set false in production.');
  }

  // ---------- OIDC discovery (Authentik hoặc Keycloak) ----------
  app.get('/v1/auth/oidc/config', (_req, res) => {
    res.json({
      issuer: process.env.OIDC_ISSUER || 'http://authentik-server:9000/application/o/synapsedx/',
      clientId: process.env.OIDC_CLIENT_ID || 'synapsedx-platform',
      redirectUri: process.env.OIDC_REDIRECT_URI || 'http://localhost:4001/v1/auth/oidc/callback',
      provider: process.env.OIDC_PROVIDER || 'authentik',
      note: 'Cấu hình Authentik/Keycloak làm upstream IdP. IAM giữ shadow user + phân quyền org/account/role/policy.',
    });
  });

  app.get('/v1/auth/oidc/start', (req, res) => {
    const issuer = process.env.OIDC_ISSUER || '';
    const clientId = process.env.OIDC_CLIENT_ID || '';
    const redirectUri = (process.env.OIDC_REDIRECT_URI || '') as string;
    const org = typeof req.query.org === 'string' && /^[a-z0-9-]{2,64}$/.test(req.query.org) ? req.query.org : 'acme';
    const state = Buffer.from(JSON.stringify({ org, t: Date.now() })).toString('base64url');
    const url = `${issuer.replace(/\/$/, '')}/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${encodeURIComponent('openid email profile')}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    res.json({ authorizeUrl: url, state });
  });

  // Callback: trong bản MVP nhận `email` (do IdP trả về sau khi exchange code — ở production dùng openid-client).
  // Hỗ trợ cả code exchange thật nếu OIDC_ISSUER reachable, fallback demo.
  // CẢNH BÁO BẢO MẬT: chế độ demo tin `email` do caller gửi — cho phép mạo danh bất kỳ
  // user nào. Mặc định bật cho dev (IAM_ALLOW_OIDC_DEMO_CALLBACK=true); production BẮT BUỘC
  // set IAM_ALLOW_OIDC_DEMO_CALLBACK=false — khi đó endpoint chỉ chấp nhận `code` (để IdP
  // exchange thật) và từ chối email thô.
  app.post('/v1/auth/oidc/callback', async (req, res) => {
    try {
      const demoAllowed = (process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK || 'true') === 'true';
      const { email, sub, displayName, orgSlug, code } = req.body as any;
      if (!demoAllowed) {
        if (!code) {
          return res.status(501).json({
            error: 'oidc_code_required',
            message: 'Demo email callback is disabled (IAM_ALLOW_OIDC_DEMO_CALLBACK=false). Provide an authorization `code` for real IdP exchange (requires openid-client flow).',
          });
        }
        return res.status(501).json({
          error: 'oidc_not_configured',
          message: 'Real code exchange needs an OIDC client (openid-client) — not wired in this build. Enable the demo callback only in dev.',
        });
      }
      const schema = z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        orgSlug: z.string().trim().regex(/^[a-z0-9-]{2,64}$/).optional(),
      });
      const parsed = schema.safeParse({ email, orgSlug });
      if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
      const normEmail = parsed.data.email;
      const slug = parsed.data.orgSlug || 'acme';
      const safeName = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 200) : normEmail;
      const safeSub = typeof sub === 'string' ? sub.slice(0, 320) : normEmail;
      const org = (await getOrgBySlug(slug)) || (await createOrganization(slug, slug));
      const user = await upsertUser(org.id, normEmail, safeName, safeSub);
      const { token, expiresIn } = signAccess({ sub: user.id, email: user.email, org: org.id });
      const rt = newRefreshToken();
      await storeRefresh(user.id, rt.hash, refreshExpiry());
      res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user });
    } catch (e: any) {
      res.status(500).json({ error: 'oidc_callback_failed', message: e.message });
    }
  });

  // Dev login: cấp token trực tiếp theo email. TẮT ở production bằng
  // IAM_ALLOW_DEV_LOGIN=false (khi đó chỉ còn OIDC callback + refresh).
  app.post('/v1/auth/login', async (req, res) => {
    if ((process.env.IAM_ALLOW_DEV_LOGIN || 'true') !== 'true') {
      return res.status(403).json({ error: 'dev_login_disabled', message: 'Use OIDC flow' });
    }
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      orgSlug: z.string().trim().regex(/^[a-z0-9-]{2,64}$/).optional(),
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
    res.json({ accessToken: token, expiresIn, refreshToken: rt.value, user });
  });

  // Refresh xoay vòng NGUYÊN TỬ: consume+revoke 1 bước → replay/race đều rớt.
  app.post('/v1/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body as any;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    const rec = await consumeAndRevokeRefresh(refreshToken);
    if (!rec) return res.status(401).json({ error: 'invalid_refresh' });
    const rt = newRefreshToken();
    await storeRefresh(rec.user_id, rt.hash, refreshExpiry());
    const { token, expiresIn } = signAccess({ sub: rec.user_id });
    res.json({ accessToken: token, expiresIn, refreshToken: rt.value });
  });

  // Logout: thu hồi refresh token.
  app.post('/v1/auth/logout', async (req, res) => {
    const { refreshToken } = req.body as any;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    await revokeRefresh(refreshToken);
    res.json({ ok: true });
  });

  // Logout mọi nơi: dùng refreshToken còn hiệu lực để chứng minh sở hữu,
  // rồi thu hồi TẤT CẢ session của chính user đó (không nhận userId tùy ý).
  app.post('/v1/auth/logout-all', async (req, res) => {
    const { refreshToken } = req.body as any;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    const rec = await consumeRefresh(refreshToken);
    if (!rec) return res.status(401).json({ error: 'invalid_refresh' });
    const revoked = await revokeAllRefresh(rec.user_id);
    res.json({ ok: true, revoked });
  });

  // Who-am-I: user record của chính Bearer token.
  app.get('/v1/auth/me', async (req, res) => {
    const h = req.headers.authorization || '';
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

  app.get('/v1/auth/verify', async (req, res) => {    const h = req.headers.authorization || '';
    const apiKey = (req.headers['x-api-key'] as string) || '';
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
    return res.status(400).json({ error: 'provide Bearer or X-API-Key' });
  });

  // ---------- Organizations ----------
  app.get('/v1/orgs', async (_req, res) => res.json(await listOrganizations()));
  app.post('/v1/orgs', async (req, res) => {
    try {
      const schema = z.object({
        slug: z.string().trim().regex(/^[a-z0-9-]{2,64}$/),
        displayName: z.string().trim().min(2).max(200),
      });
      const b = schema.parse(req.body);
      res.status(201).json(await createOrganization(b.slug, b.displayName));
    } catch (e: any) {
      if (e?.code === '23505' || /exists|duplicate/i.test(e?.message || '')) {
        return res.status(409).json({ error: 'conflict', message: 'organization slug exists' });
      }
      res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  // ---------- Accounts ----------
  app.get('/v1/orgs/:orgId/accounts', async (req, res) => res.json(await listAccounts(req.params.orgId)));
  app.post('/v1/orgs/:orgId/accounts', async (req, res) => {
    try {
      const schema = z.object({
        slug: z.string().trim().regex(/^[a-z0-9-]{2,64}$/),
        displayName: z.string().trim().min(2).max(200),
      });
      const b = schema.parse(req.body);
      res.status(201).json(await createAccount(req.params.orgId, b.slug, b.displayName));
    } catch (e: any) {
      if (e?.code === '23505' || /exists|duplicate/i.test(e?.message || '')) {
        return res.status(409).json({ error: 'conflict', message: 'account slug exists' });
      }
      res.status(400).json({ error: 'invalid_body', message: e.message });
    }
  });

  // ---------- Users ----------
  app.post('/v1/orgs/:orgId/users', async (req, res) => {
    const schema = z.object({
      email: z.string().trim().toLowerCase().email().max(320),
      displayName: z.string().trim().max(200).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', message: parsed.error.message });
    const { email, displayName } = parsed.data;
    res.status(201).json(await upsertUser(req.params.orgId, email, displayName));
  });

  app.get('/v1/orgs/:orgId/users', async (req, res) => {
    res.json(await listUsers(req.params.orgId));
  });

  // ---------- Roles & Policies (AWS-style) ----------
  const SLUG_RE = /^[a-z0-9-]{2,64}$/;
  app.post('/v1/accounts/:accountId/roles', async (req, res) => {
    const { slug, description } = req.body as any;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{2,64}$' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    res.status(201).json(await createRole(req.params.accountId, slug, description || ''));
  });

  app.get('/v1/accounts/:accountId/roles', async (req, res) => {
    res.json(await listRoles(req.params.accountId));
  });

  app.delete('/v1/roles/:roleId', async (req, res) => {
    const ok = await deleteRole(req.params.roleId);
    if (!ok) return res.status(404).json({ error: 'role_not_found' });
    res.json({ ok: true });
  });

  app.post('/v1/accounts/:accountId/policies', async (req, res) => {
    const { slug, description, document } = req.body as any;
    if (!slug || !document) return res.status(400).json({ error: 'slug+document required' });
    if (typeof slug !== 'string' || !/^[a-z0-9-]{2,64}$/.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{2,64}$' });
    }
    const docErr = validatePolicyDocument(document);
    if (docErr) return res.status(400).json({ error: 'invalid_document', message: docErr });
    res.status(201).json(await createPolicy(req.params.accountId, slug, description || '', document));
  });

  app.get('/v1/accounts/:accountId/policies', async (req, res) => {
    res.json(await listPolicies(req.params.accountId));
  });

  app.delete('/v1/policies/:policyId', async (req, res) => {
    const ok = await deletePolicy(req.params.policyId);
    if (!ok) return res.status(404).json({ error: 'policy_not_found' });
    res.json({ ok: true });
  });

  app.post('/v1/roles/:roleId/attach', async (req, res) => {
    if (!req.body?.policyId) return res.status(400).json({ error: 'policyId required' });
    const [roleOk, polOk] = await Promise.all([roleExists(req.params.roleId), policyExists(req.body.policyId)]);
    if (!roleOk) return res.status(404).json({ error: 'role_not_found' });
    if (!polOk) return res.status(404).json({ error: 'policy_not_found' });
    await attachPolicy(req.params.roleId, req.body.policyId);
    res.json({ ok: true });
  });
  app.post('/v1/users/:userId/assign', async (req, res) => {
    if (!req.body?.roleId) return res.status(400).json({ error: 'roleId required' });
    const [user, roleOk] = await Promise.all([getUserById(req.params.userId), roleExists(req.body.roleId)]);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (!roleOk) return res.status(404).json({ error: 'role_not_found' });
    await assignRole(req.params.userId, req.body.roleId);
    res.json({ ok: true });
  });

  // ---------- Authorize (policy evaluation) ----------
  // context: caller cung cấp thêm (vd {hour, sourceIp}); server luôn ép
  // user/org/email từ DB (caller không override được) để Condition đáng tin.
  app.post('/v1/authorize', async (req, res) => {
    const { userId, action, resource, context } = req.body as any;
    if (!userId || !action || !resource) return res.status(400).json({ error: 'userId+action+resource required' });
    if (typeof action !== 'string' || action.length > 512 || typeof resource !== 'string' || resource.length > 2048) {
      return res.status(400).json({ error: 'invalid_action_resource', message: 'action ≤512 chars, resource ≤2048 chars' });
    }
    const docs = await policiesForUser(userId);
    const user = await getUserById(userId);
    const ctx = { ...(context || {}), user: userId, org: user?.org_id, email: user?.email };
    const verdict = evaluatePolicies(docs, { action, resource }, ctx);
    await logAudit({ actor_type: 'user', actor_id: userId, action, resource, decision: verdict.allowed, context: ctx }).catch(() => undefined);
    res.json({ allowed: verdict.allowed, matchedBy: verdict.matchedBy, evaluatedPolicies: docs.length });
  });

  // Dry-run simulator (không cần user): đánh giá documents inline, như AWS IAM Policy Simulator.
  app.post('/v1/authorize/dry-run', async (req, res) => {
    const { documents, action, resource, context } = req.body as any;
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
    const verdict = evaluatePolicies(documents, { action, resource }, context || {});
    await logAudit({ actor_type: 'dry-run', actor_id: '', action, resource, decision: verdict.allowed, context: context || {} }).catch(() => undefined);
    res.json({ allowed: verdict.allowed, matchedBy: verdict.matchedBy, evaluatedPolicies: documents.length });
  });

  // Audit log (đọc).
  app.get('/v1/audit', async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const actor = (req.query.actor as string) || undefined;
    res.json(await listAudit(limit, actor));
  });

  // ---------- API keys ----------
  app.post('/v1/accounts/:accountId/keys', async (req, res) => {
    const { userId, name, scopes, expiresInSeconds } = req.body as any;
    const keyName = name || 'default';
    if (typeof keyName !== 'string' || keyName.length === 0 || keyName.length > 100) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 chars' });
    }
    const keyScopes: string[] = scopes || ['*'];
    if (!Array.isArray(keyScopes) || keyScopes.length === 0 || keyScopes.length > 100 ||
        keyScopes.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 200)) {
      return res.status(400).json({ error: 'invalid_scopes', message: 'scopes must be 1..100 non-empty strings ≤200 chars' });
    }
    if (expiresInSeconds !== undefined && (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 315360000)) {
      return res.status(400).json({ error: 'invalid_expiry', message: 'expiresInSeconds must be 1..315360000' });
    }
    const exp = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
    const k = await createApiKeyRecord(req.params.accountId, userId || null, keyName, keyScopes, exp);
    res.status(201).json({ id: k.id, apiKey: k.value, prefix: k.prefix, warning: 'Lưu apiKey ngay — chỉ hiển thị 1 lần.' });
  });

  app.post('/v1/keys/verify', async (req, res) => {
    const rec = await verifyApiKey(req.body.apiKey || '');
    if (!rec) return res.status(401).json({ valid: false });
    res.json({ valid: true, ...rec });
  });

  app.delete('/v1/keys/:id', async (req, res) => {
    const ok = await revokeApiKey(req.params.id);
    if (!ok) return res.status(404).json({ error: 'key_not_found' });
    res.json({ ok: true });
  });

  // ---------- Service accounts (machine identity) ----------
  app.post('/v1/accounts/:accountId/service-accounts', async (req, res) => {
    const { slug, description } = req.body as any;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid_slug', message: 'slug must match ^[a-z0-9-]{2,64}$' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 500)) {
      return res.status(400).json({ error: 'invalid_description', message: 'description ≤500 chars' });
    }
    res.status(201).json(await createServiceAccount(req.params.accountId, slug, description || ''));
  });

  app.get('/v1/accounts/:accountId/service-accounts', async (req, res) => {
    res.json(await listServiceAccounts(req.params.accountId));
  });

  // Cấp JWT cho service account (kind=service-account, mang account scope).
  app.post('/v1/service-accounts/:id/token', async (req, res) => {
    const sa = await getServiceAccount(req.params.id);
    if (!sa) return res.status(404).json({ error: 'service_account_not_found' });
    const scopes: string[] = req.body?.scopes || ['*'];
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 100 ||
        scopes.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 200)) {
      return res.status(400).json({ error: 'invalid_scopes', message: 'scopes must be 1..100 non-empty strings ≤200 chars' });
    }
    const { token, expiresIn } = signAccess({ sub: sa.id, account: sa.account_id, scopes, kind: 'service-account' });
    res.json({ accessToken: token, expiresIn, serviceAccount: sa });
  });

  // Liệt kê policy của user (hữu ích khi debug authorize).
  app.get('/v1/users/:userId/policies', async (req, res) => {
    res.json(await policiesForUser(req.params.userId));
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
    if (err?.code === '23505' || /exists|duplicate/i.test(err?.message || '')) {
      return res.status(409).json({ error: 'conflict', message: 'duplicate slug' });
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
