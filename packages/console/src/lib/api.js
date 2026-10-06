// OLP API client (fetch-based, mirrors @olp/sdk). Apache-2.0.
export function baseUrl() {
  if (typeof window !== 'undefined' && window.OLP_CONFIG?.BASE_URL) {
    return String(window.OLP_CONFIG.BASE_URL).replace(/\/$/, '');
  }
  return (import.meta.env?.VITE_OLP_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
}

export class OlpError extends Error {
  constructor(status, path, body) {
    super(`OLP ${status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function req(path, { method = 'GET', body, token, apiKey } = {}) {
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
    throw new Error(`OLP network ${path}: ${e.message || e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new OlpError(r.status, path, data);
  return data;
}

const get = (path, auth) => req(path, { ...auth });
const post = (path, body, auth) => req(path, { method: 'POST', body, ...auth });
const del = (path, auth) => req(path, { method: 'DELETE', ...auth });

export const api = {
  login: (email, orgSlug) => post('/v1/auth/login', { email, orgSlug }),
  me: (a) => get('/v1/auth/me', a),
  orgs: (a) => get('/v1/orgs', a),
  createOrg: (slug, displayName, a) => post('/v1/orgs', { slug, displayName }, a),
  accounts: (orgId, a) => get(`/v1/orgs/${orgId}/accounts`, a),
  createAccount: (orgId, slug, displayName, a) =>
    post(`/v1/orgs/${orgId}/accounts`, { slug, displayName }, a),
  users: (orgId, a) => get(`/v1/orgs/${orgId}/users`, a),
  roles: (accountId, a) => get(`/v1/accounts/${accountId}/roles`, a),
  createRole: (accountId, slug, a) => post(`/v1/accounts/${accountId}/roles`, { slug }, a),
  deleteRole: (roleId, a) => del(`/v1/roles/${roleId}`, a),
  policies: (accountId, a) => get(`/v1/accounts/${accountId}/policies`, a),
  createPolicy: (accountId, slug, document, a) =>
    post(`/v1/accounts/${accountId}/policies`, { slug, document }, a),
  deletePolicy: (policyId, a) => del(`/v1/policies/${policyId}`, a),
  revokeKey: (id, a) => del(`/v1/keys/${id}`, a),
  attach: (roleId, policyId, a) => post(`/v1/roles/${roleId}/attach`, { policyId }, a),
  assign: (userId, roleId, a) => post(`/v1/users/${userId}/assign`, { roleId }, a),
  userPolicies: (userId, a) => get(`/v1/users/${userId}/policies`, a),
  authorize: (userId, action, resource, context, a) =>
    post('/v1/authorize', { userId, action, resource, context }, a),
  simulate: (documents, action, resource, context, a) =>
    post('/v1/authorize/dry-run', { documents, action, resource, context }, a),
  audit: (limit, actor, a) =>
    get(`/v1/audit?limit=${limit || 50}${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`, a),
  createKey: (accountId, name, a) => post(`/v1/accounts/${accountId}/keys`, { name, scopes: ['*'] }, a),
  serviceAccounts: (accountId, a) => get(`/v1/accounts/${accountId}/service-accounts`, a),
  createSA: (accountId, slug, a) => post(`/v1/accounts/${accountId}/service-accounts`, { slug }, a),
  saToken: (id, a) => post(`/v1/service-accounts/${id}/token`, {}, a),
  templates: (a) => get('/v1/templates', a),
  workflows: (a) => get('/v1/workflows', a),
  createWorkflow: (template, name, a) => post('/v1/workflows', { template, name }, a),
};
