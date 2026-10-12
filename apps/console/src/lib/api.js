/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// synapsedx API client (fetch-based, mirrors @synapsedx/sdk). Apache-2.0.
export function baseUrl() {
  if (typeof window !== 'undefined' && window.SYNAPSEDX_CONFIG?.BASE_URL) {
    return String(window.SYNAPSEDX_CONFIG.BASE_URL).replace(/\/$/, '');
  }
  return (import.meta.env?.VITE_SYNAPSEDX_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
}

/**
 * Session hook wired by AuthProvider (auth.jsx). Lets req() silently rotate an
 * expired access token (single retry) and drop the session when the refresh
 * itself is dead — without touching every page. Null-safe when unwired (tests).
 */
export const authStore = {
  get: () => null,
  set: () => {},
  clear: () => {},
};

export class SynapseDXError extends Error {
  constructor(status, path, body) {
    super(`synapsedx ${status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Single-flight rotation: parallel 401s share ONE refresh call. Without this,
 * two concurrent rotations with the same single-use refresh token would race —
 * the loser gets invalid_refresh and would wipe the winner's fresh session.
 */
let refreshInflight = null;
function rotateOnce() {
  if (!refreshInflight) {
    const rt = authStore.get()?.refreshToken;
    if (!rt) return Promise.resolve(null);
    refreshInflight = req('/v1/auth/refresh', { method: 'POST', body: { refreshToken: rt } })
      .then((rotated) => {
        authStore.set({ token: rotated.accessToken, refreshToken: rotated.refreshToken });
        return rotated;
      })
      .catch(() => {
        // Only drop the session if nobody rotated since (a parallel winner may
        // have already stored a fresh pair — don't wipe it with a stale failure).
        if (authStore.get()?.refreshToken === rt) authStore.clear();
        return null;
      })
      .finally(() => {
        refreshInflight = null;
      });
  }
  return refreshInflight;
}

async function req(path, { method = 'GET', body, token, apiKey, _retried } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  let r;
  try {
    r = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`synapsedx network ${path}: ${e.message || e}`);
  }
  // Silent refresh: expired access token + live refresh token → rotate once,
  // persist via the store, and retry the original call. Never loops (one retry).
  // Skipped only for the token-minting endpoints themselves (login/refresh/
  // logout/callback) — /v1/auth/me and /v1/auth/verify DO retry.
  const NO_RETRY = new Set([
    '/v1/auth/login', '/v1/auth/refresh', '/v1/auth/logout',
    '/v1/auth/logout-all', '/v1/auth/oidc/callback',
  ]);
  if (r.status === 401 && !_retried && token && !NO_RETRY.has(path)) {
    const rotated = await rotateOnce();
    if (rotated) {
      return req(path, { method, body, token: rotated.accessToken, apiKey, _retried: true });
    }
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new SynapseDXError(r.status, path, data);
  return data;
}

const get = (path, auth) => req(path, { ...auth });
const post = (path, body, auth) => req(path, { method: 'POST', body, ...auth });
const del = (path, auth) => req(path, { method: 'DELETE', ...auth });

export const api = {
  login: (email, orgSlug) => post('/v1/auth/login', { email, orgSlug }),
  refresh: (refreshToken) => post('/v1/auth/refresh', { refreshToken }),
  logoutServer: (refreshToken) =>
    post('/v1/auth/logout', { refreshToken }).catch(() => ({ ok: false })),
  me: (a) => get('/v1/auth/me', a),
  orgs: (a) => get('/v1/orgs', a),
  createOrg: (slug, displayName, a) => post('/v1/orgs', { slug, displayName }, a),
  accounts: (orgId, a) => get(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`, a),
  createAccount: (orgId, slug, displayName, a) =>
    post(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`, { slug, displayName }, a),
  users: (orgId, a) => get(`/v1/orgs/${encodeURIComponent(orgId)}/users`, a),
  roles: (accountId, a) => get(`/v1/accounts/${encodeURIComponent(accountId)}/roles`, a),
  createRole: (accountId, slug, a) => post(`/v1/accounts/${encodeURIComponent(accountId)}/roles`, { slug }, a),
  deleteRole: (roleId, a) => del(`/v1/roles/${encodeURIComponent(roleId)}`, a),
  policies: (accountId, a) => get(`/v1/accounts/${encodeURIComponent(accountId)}/policies`, a),
  createPolicy: (accountId, slug, document, a) =>
    post(`/v1/accounts/${encodeURIComponent(accountId)}/policies`, { slug, document }, a),
  deletePolicy: (policyId, a) => del(`/v1/policies/${encodeURIComponent(policyId)}`, a),
  revokeKey: (id, a) => del(`/v1/keys/${encodeURIComponent(id)}`, a),
  attach: (roleId, policyId, a) => post(`/v1/roles/${encodeURIComponent(roleId)}/attach`, { policyId }, a),
  assign: (userId, roleId, a) => post(`/v1/users/${encodeURIComponent(userId)}/assign`, { roleId }, a),
  userPolicies: (userId, a) => get(`/v1/users/${encodeURIComponent(userId)}/policies`, a),
  authorize: (userId, action, resource, context, a) =>
    post('/v1/authorize', { userId, action, resource, context }, a),
  simulate: (documents, action, resource, context, a) =>
    post('/v1/authorize/dry-run', { documents, action, resource, context }, a),
  audit: (limit, actor, a) =>
    get(`/v1/audit?limit=${limit || 50}${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`, a),
  createKey: (accountId, name, a) => post(`/v1/accounts/${encodeURIComponent(accountId)}/keys`, { name, scopes: ['*'] }, a),
  serviceAccounts: (accountId, a) => get(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`, a),
  createSA: (accountId, slug, a) => post(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`, { slug }, a),
  saToken: (id, a) => post(`/v1/service-accounts/${encodeURIComponent(id)}/token`, {}, a),
  templates: (a) => get('/v1/templates', a),
  workflows: (a) => get('/v1/workflows', a),
  createWorkflow: (template, name, a) => post('/v1/workflows', { template, name }, a),
};
