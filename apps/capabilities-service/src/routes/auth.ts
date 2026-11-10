// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Identity/session capability over Tier-1 IAM.
 *
 * Tier-3 calls these routes instead of importing @synapseone/sdk or storing
 * passwords. Tier-2 stores no identity data. The full first-party lifecycle
 * (register/login/change/forgot/reset/verify/sessions), OIDC and the delegated
 * token exchange are proxied to Tier-1; Tier-2 adds organization/audience
 * binding and a stable error contract.
 */
import { Express } from 'express';
import { SynapseOneError } from '@synapseone/sdk';
import { CallerCredential, authenticate, credentialClient, isAdmin, requireAuthenticated } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { anonymousClient, serviceClient } from '../platform';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stringField(body: Record<string, unknown>, name: string, max = 320): string {
  const value = String(body[name] ?? '').trim();
  if (!value) throw apiError(400, 'field_required', `${name} is required`, { field: name });
  if (value.length > max) throw apiError(400, 'invalid_request', `${name} is too long`, { field: name });
  return value;
}

function emailField(body: Record<string, unknown>): string {
  const email = stringField(body, 'email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw apiError(400, 'invalid_request', 'email is not a valid address', { field: 'email' });
  return email;
}

const CREDENTIAL_FIELDS = new Set(['password_hash', 'passwordHash', 'password_updated_at', 'passwordUpdatedAt']);

/**
 * Defence in depth: Tier-1 strips credential material from user payloads, but
 * Tier-2 must never forward a password hash to a browser even if an older
 * upstream build starts including it again. Applied to every proxied
 * identity response that can carry a user object.
 */
export function redactCredentialFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactCredentialFields(item)) as unknown as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_FIELDS.has(key)) continue;
    out[key] = redactCredentialFields(item);
  }
  return out as T;
}

/** Bind every credential flow to the deployment organization (no slug hopping). */
export function boundOrgSlug(config: ServiceConfig, raw: unknown): string | undefined {
  const requested = raw === undefined || raw === null ? '' : String(raw).trim();
  if (config.authOrgSlug) {
    if (requested && requested !== config.authOrgSlug) {
      throw apiError(403, 'org_not_allowed', 'this deployment is bound to a different organization', {
        organization: config.authOrgSlug,
      });
    }
    return config.authOrgSlug;
  }
  return requested || undefined;
}

export function resolveAudience(config: ServiceConfig, raw: unknown, product?: string): string {
  const requested = raw === undefined || raw === null || raw === '' ? undefined : String(raw).trim().toLowerCase();
  const candidate = product?.trim().toLowerCase();
  const audience = requested || (candidate && config.authAllowedAudiences.includes(candidate) ? candidate : config.authAudience);
  if (!config.authAllowedAudiences.includes(audience)) {
    throw apiError(403, 'audience_not_allowed', 'this audience is not allowed for delegated tokens', {
      allowed: config.authAllowedAudiences,
    });
  }
  return audience;
}

function mapAuthError(error: unknown): never {
  if (error instanceof SynapseOneError) {
    const upstreamCode = (error.body as any)?.error || (error.body as any)?.code;
    if (error.status === 400 || error.status === 422) {
      throw apiError(400, 'invalid_request', 'Tier-1 IAM rejected the login/credential request', {
        ...(upstreamCode ? { reason: String(upstreamCode) } : {}),
      });
    }
    if (error.status === 401) {
      throw apiError(401, 'invalid_credentials', 'email or password is incorrect', {
        ...(upstreamCode ? { reason: String(upstreamCode) } : {}),
      });
    }
    if (error.status === 403) {
      throw apiError(403, 'auth_rejected', 'Tier-1 IAM rejected this identity operation', {
        ...(upstreamCode ? { reason: String(upstreamCode) } : {}),
      });
    }
    if (error.status === 404) throw apiError(404, 'not_found', 'the identity resource was not found');
    if (error.status === 409) throw apiError(409, 'upstream_conflict', 'the identity resource already exists');
    if (error.status === 429) throw apiError(429, 'rate_limited', 'too many authentication attempts');
  }
  throw error;
}

function callerCredential(config: ServiceConfig, caller: { credential?: CallerCredential }) {
  if (!caller.credential) throw apiError(401, 'unauthorized', 'a verified Tier-1 credential is required');
  if (caller.credential.kind !== 'bearer') {
    throw apiError(403, 'auth_rejected', 'this operation requires a user bearer token, not an API key');
  }
  return credentialClient(config, caller.credential);
}

function scopesSubset(requested: string[], held: string[]): boolean {
  return requested.every((scope) => held.includes('*') || held.includes(scope));
}

export function registerAuthRoutes(app: Express, config: ServiceConfig): void {
  // ---- first-party credential lifecycle ----
  app.post('/v1/capabilities/auth/register', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const email = emailField(body);
    const password = stringField(body, 'password', 1024);
    const orgSlug = boundOrgSlug(config, body.orgSlug);
    const displayName = body.displayName === undefined ? undefined : String(body.displayName).slice(0, 200);
    let result: any;
    try {
      result = await anonymousClient(config).iam.register({
        email, password, ...(displayName ? { displayName } : {}), ...(orgSlug ? { orgSlug } : {}),
      });
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.status(201).json(redactCredentialFields(result));
  }));

  app.post('/v1/capabilities/auth/login', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const email = emailField(body);
    const orgSlug = boundOrgSlug(config, body.orgSlug);
    let result: any;
    try {
      if (body.password !== undefined) {
        const password = String(body.password);
        if (!password) throw apiError(400, 'field_required', 'password is required', { field: 'password' });
        result = await anonymousClient(config).iam.loginWithPassword({
          email, password, ...(orgSlug ? { orgSlug } : {}),
        });
      } else {
        result = await anonymousClient(config).iam.login(email, orgSlug);
      }
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(redactCredentialFields(result));
  }));

  app.post('/v1/capabilities/auth/refresh', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const value = String(body.refreshToken || body.refresh_token || '').trim();
    if (!value) throw apiError(400, 'field_required', 'refreshToken is required', { field: 'refreshToken' });
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.refresh(value);
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(redactCredentialFields(result as Record<string, unknown>));
  }));

  app.post('/v1/capabilities/auth/logout', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const value = String(body.refreshToken || body.refresh_token || '').trim();
    if (!value) throw apiError(400, 'field_required', 'refreshToken is required', { field: 'refreshToken' });
    let result: any;
    try {
      result = await anonymousClient(config).iam.logout(value);
    } catch (error) {
      mapAuthError(error);
    }
    res.json(result ?? { ok: true });
  }));

  app.post('/v1/capabilities/auth/logout-all', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const value = String(body.refreshToken || body.refresh_token || '').trim();
    if (!value) throw apiError(400, 'field_required', 'refreshToken is required', { field: 'refreshToken' });
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.logoutAll(value);
    } catch (error) {
      mapAuthError(error);
    }
    res.json(result as Record<string, unknown>);
  }));

  app.post('/v1/capabilities/auth/password/change', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    requireAuthenticated(caller);
    const body = (req.body || {}) as Record<string, unknown>;
    const currentPassword = stringField(body, 'currentPassword', 1024);
    const newPassword = stringField(body, 'newPassword', 1024);
    let result: unknown;
    try {
      result = await callerCredential(config, caller).iam.changePassword(currentPassword, newPassword);
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(result as Record<string, unknown>);
  }));

  app.post('/v1/capabilities/auth/password/forgot', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const email = emailField(body);
    const orgSlug = boundOrgSlug(config, body.orgSlug);
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.requestPasswordReset(email, orgSlug || 'acme');
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.status(202).json(result ?? { ok: true });
  }));

  // Backward-compatible alias used by the previous typed-503 contract.
  app.post('/v1/capabilities/auth/password-reset', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const email = emailField(body);
    const orgSlug = boundOrgSlug(config, body.orgSlug);
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.requestPasswordReset(email, orgSlug || 'acme');
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.status(202).json(result ?? { ok: true });
  }));

  app.post('/v1/capabilities/auth/password/reset', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const token = stringField(body, 'token', 512);
    const newPassword = stringField(body, 'newPassword', 1024);
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.resetPassword(token, newPassword);
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(result as Record<string, unknown>);
  }));

  app.post('/v1/capabilities/auth/email/verify', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const token = stringField(body, 'token', 512);
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.verifyEmail(token);
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(result as Record<string, unknown>);
  }));

  app.post('/v1/capabilities/auth/email/verify/request', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    requireAuthenticated(caller);
    let result: unknown;
    try {
      result = await callerCredential(config, caller).iam.requestEmailVerification();
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(result as Record<string, unknown>);
  }));

  app.get('/v1/capabilities/auth/sessions', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    requireAuthenticated(caller);
    let result: unknown;
    try {
      result = await callerCredential(config, caller).iam.listSessions();
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(result as unknown as Record<string, unknown>);
  }));

  app.delete('/v1/capabilities/auth/sessions/:id', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    requireAuthenticated(caller);
    let result: unknown;
    try {
      result = await callerCredential(config, caller).iam.revokeSession(String(req.params.id));
    } catch (error) {
      mapAuthError(error);
    }
    res.json(result as Record<string, unknown>);
  }));

  app.get('/v1/capabilities/auth/me', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    const principal = requireAuthenticated(caller);
    if (caller.credential?.kind === 'bearer') {
      let result: unknown;
      try {
        result = await credentialClient(config, caller.credential).iam.me();
      } catch (error) {
        mapAuthError(error);
      }
      res.setHeader('cache-control', 'no-store');
      res.json(redactCredentialFields(result as Record<string, unknown>));
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.json({
      kind: principal.type,
      account: principal.account,
      scopes: principal.scopes,
      user: { id: principal.subject },
    });
  }));

  // ---- OIDC ----
  app.get('/v1/capabilities/auth/oidc/config', handler(async (_req, res) => {
    const result = await anonymousClient(config).iam.oidcConfig();
    res.setHeader('cache-control', 'no-store');
    res.json(result as unknown as Record<string, unknown>);
  }));

  app.get('/v1/capabilities/auth/oidc/start', handler(async (req, res) => {
    const org = boundOrgSlug(config, req.query.org) || config.authOrgSlug || 'acme';
    const result = await anonymousClient(config).iam.oidcStart(org) as unknown as Record<string, unknown>;
    res.setHeader('cache-control', 'no-store');
    const target = typeof result?.authorizeUrl === 'string' ? result.authorizeUrl : result?.url;
    if (typeof target === 'string' && String(req.query.redirect || '').toLowerCase() === 'true') {
      res.redirect(target);
      return;
    }
    res.json(result);
  }));

  app.post('/v1/capabilities/auth/oidc/callback', handler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const code = String(body.code || '').trim();
    const state = String(body.state || '').trim();
    if (!code || !state) throw apiError(400, 'field_required', 'code and state are required');
    let result: unknown;
    try {
      result = await anonymousClient(config).iam.oidcCallback(code, state);
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json(result as Record<string, unknown>);
  }));

  // ---- delegated token exchange (Tier-2 service -> user-scoped Tier-1 token) ----
  app.post('/v1/capabilities/auth/exchange', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    const principal = requireAuthenticated(caller);
    // Tier-1 only accepts a service-account/API-key caller for /v1/auth/exchange.
    const serviceCaller = principal.type === 'apikey' || principal.kind === 'service-account';
    const exchangeAllowed = serviceCaller && (isAdmin(principal)
      || principal.scopes.includes('synapsedx:auth:exchange')
      || principal.scopes.includes('auth:exchange'));
    if (!exchangeAllowed) {
      throw apiError(403, 'exchange_forbidden', 'this credential may not mint delegated tokens', {
        requiredScope: 'synapsedx:auth:exchange',
      });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const userId = stringField(body, 'userId', 64);
    const requestedScopes = Array.isArray(body.scopes) ? body.scopes.map((scope) => String(scope)) : undefined;
    if (requestedScopes && !scopesSubset(requestedScopes, principal.scopes)) {
      throw apiError(403, 'insufficient_scope', 'cannot delegate scopes the caller does not hold', {
        held: principal.scopes,
      });
    }
    const audience = resolveAudience(config, body.audience, req.header('x-synapsedx-product')?.trim() || undefined);
    const ttlSeconds = body.ttlSeconds === undefined ? undefined : Number(body.ttlSeconds);
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)) {
      throw apiError(400, 'invalid_request', 'ttlSeconds must be an integer 60..3600');
    }
    let result: unknown;
    try {
      result = await serviceClient(config).iam.exchangeToken({
        userId,
        ...(body.accountId ? { accountId: String(body.accountId) } : {}),
        ...(body.orgId ? { orgId: String(body.orgId) } : {}),
        ...(requestedScopes ? { scopes: requestedScopes } : {}),
        audience,
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      });
    } catch (error) {
      mapAuthError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.status(201).json(redactCredentialFields(result));
  }));
}
