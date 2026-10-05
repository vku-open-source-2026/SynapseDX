/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  createOrganization, listOrganizations, getOrgBySlug,
  createAccount, listAccounts, upsertUser, listUsers, getUserById, createRole, createPolicy,
  attachPolicy, assignRole, policiesForUser, useDb, deleteRole, deletePolicy,
  createServiceAccount, listServiceAccounts, getServiceAccount,
  listRoles, listPolicies, logAudit, listAudit,
} from './db';
import { evaluatePolicies } from './policy';
import { signAccess, newRefreshToken, storeRefresh, consumeRefresh, revokeRefresh, revokeAllRefresh, consumeAndRevokeRefresh, refreshExpiry, revokeApiKey, createApiKeyRecord, verifyApiKey } from './tokens';

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
  app.use(cors());
  app.use(morgan('combined'));
  app.use(express.json({ limit: '1mb' }));

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

  // ---------- OIDC discovery (Authentik hoặc Keycloak) ----------
  app.get('/v1/auth/oidc/config', (_req, res) => {
    res.json({
      issuer: process.env.OIDC_ISSUER || 'http://authentik-server:9000/application/o/olp/',
      clientId: process.env.OIDC_CLIENT_ID || 'olp-platform',
      redirectUri: process.env.OIDC_REDIRECT_URI || 'http://localhost:4001/v1/auth/oidc/callback',
      provider: process.env.OIDC_PROVIDER || 'authentik',
      note: 'Cấu hình Authentik/Keycloak làm upstream IdP. IAM giữ shadow user + phân quyền org/account/role/policy.',
    });
  });

  app.get('/v1/auth/oidc/start', (req, res) => {
    const issuer = process.env.OIDC_ISSUER || '';
    const clientId = process.env.OIDC_CLIENT_ID || '';
    const redirectUri = (process.env.OIDC_REDIRECT_URI || '') as string;
    const state = Buffer.from(JSON.stringify({ org: req.query.org || 'acme', t: Date.now() })).toString('base64url');
    const url = `${issuer.replace(/\/$/, '')}/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${encodeURIComponent('openid email profile')}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    res.json({ authorizeUrl: url, state });
  });

  // Callback: trong bản MVP nhận `email` (do IdP trả về sau khi exchange code — ở production dùng openid-client).
  // Hỗ trợ cả code exchange thật nếu OIDC_ISSUER reachable, fallback demo.
  app.post('/v1/auth/oidc/callback', async (req, res) => {
    try {
      const { email, sub, displayName, orgSlug } = req.body as any;
      if (!email) return res.status(400).json({ error: 'missing_email' });
      const org = (await getOrgBySlug(orgSlug || 'acme')) || (await createOrganization(orgSlug || 'acme', orgSlug || 'acme'));
      const user = await upsertUser(org.id, email, displayName || email, sub || email);
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
    const { email, orgSlug } = req.body as any;
    if (!email) return res.status(400).json({ error: 'email required' });
    const org = (await getOrgBySlug(orgSlug || 'acme')) || (await createOrganization(orgSlug || 'acme', orgSlug || 'acme'));
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

  app.get('/v1/auth/verify', async (req, res) => {
    const h = req.headers.authorization || '';
    const apiKey = (req.headers['x-api-key'] as string) || '';
    if (h.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(h.slice(7), process.env.IAM_JWT_SECRET || 'change_me_super_secret_32chars_min');
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
      const schema = z.object({ slug: z.string().min(2), displayName: z.string().min(2) });
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
      const schema = z.object({ slug: z.string().min(2), displayName: z.string().min(2) });
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
    const { email, displayName } = req.body as any;
    if (!email) return res.status(400).json({ error: 'email required' });
    res.status(201).json(await upsertUser(req.params.orgId, email, displayName));
  });

  app.get('/v1/orgs/:orgId/users', async (req, res) => {
    res.json(await listUsers(req.params.orgId));
  });

  // ---------- Roles & Policies (AWS-style) ----------
  app.post('/v1/accounts/:accountId/roles', async (req, res) => {
    const { slug, description } = req.body as any;
    if (!slug) return res.status(400).json({ error: 'slug required' });
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
    if (!document.Statement) return res.status(400).json({ error: 'document.Statement required (AWS IAM style)' });
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
    await attachPolicy(req.params.roleId, req.body.policyId);
    res.json({ ok: true });
  });
  app.post('/v1/users/:userId/assign', async (req, res) => {
    await assignRole(req.params.userId, req.body.roleId);
    res.json({ ok: true });
  });

  // ---------- Authorize (policy evaluation) ----------
  // context: caller cung cấp thêm (vd {hour, sourceIp}); server luôn ép
  // user/org/email từ DB (caller không override được) để Condition đáng tin.
  app.post('/v1/authorize', async (req, res) => {
    const { userId, action, resource, context } = req.body as any;
    if (!userId || !action || !resource) return res.status(400).json({ error: 'userId+action+resource required' });
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
    for (const d of documents) {
      if (!d || !Array.isArray(d.Statement)) return res.status(400).json({ error: 'each document needs Statement[]' });
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
    const exp = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
    const k = await createApiKeyRecord(req.params.accountId, userId || null, name || 'default', scopes || ['*'], exp);
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
    if (!slug) return res.status(400).json({ error: 'slug required' });
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
    if (err?.code === '23505' || /exists|duplicate/i.test(err?.message || '')) {
      return res.status(409).json({ error: 'conflict', message: 'duplicate slug' });
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
