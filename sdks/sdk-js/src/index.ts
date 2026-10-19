/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * synapsedx JavaScript SDK — works in Node 18+ and browsers (fetch-based).
 */

export interface SynapseDXClientOptions {
  baseUrl: string; // gateway, e.g. http://localhost:8080
  token?: string; // Bearer JWT
  apiKey?: string; // X-API-Key
  timeoutMs?: number; // per-request timeout (default 15000)
}

/** LDS attribute/datasource visibility (`internal` is settable but not listable via `?visibility`). */
export type LdsVisibility = 'public' | 'restricted' | 'internal';

/** NGSI-LD attribute types accepted by PUT /v1/lds/datasources/:id/attributes. */
export type LdsAttributeType = 'Property' | 'Relationship' | 'GeoProperty';

/** Body of POST /v1/lds/datasources; PATCH accepts a partial of this. */
export interface LdsDatasourceInput {
  name: string;
  slug?: string;
  entityType: string;
  license: string;
  licenseUrl?: string;
  contexts?: string[];
  defaultVisibility?: LdsVisibility;
  description?: string;
  orgId?: string;
  accountId?: string;
}

/** One attribute row for PUT /v1/lds/datasources/:id/attributes. */
export interface LdsAttributeInput {
  name: string;
  ngsiLdType?: LdsAttributeType;
  visibility?: LdsVisibility;
  description?: string;
  sourceField?: string;
}

/** Query for GET /v1/lds/datasources/:id/entities (limit 1..500, default 100). */
export interface LdsEntitiesQuery {
  limit?: number;
  offset?: number;
  visibility?: 'public' | 'restricted';
}

/** Result of POST /v1/lds/datasources/:id/records (quarantine reasons are per field). */
export interface LdsIngestResult {
  ingested: number;
  created: number;
  updated: number;
  quarantined: { field: string; reason: string }[];
  entities: { id: string; entityId: string; sourceRecordId?: string }[];
}

export class SynapseDXClient {
  private baseUrl: string;
  private token?: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(opts: SynapseDXClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  setToken(t: string) { this.token = t; }
  setApiKey(k: string) { this.apiKey = k; }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    if (this.apiKey) h['X-API-Key'] = this.apiKey;
    return h;
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let r: Response;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      r = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: init?.signal ?? ctl.signal,
        headers: this.headers((init?.headers as any) || {}),
      });
    } catch (e: any) {
      throw new Error(`synapsedx network ${path}: ${e?.message || e}`);
    } finally {
      clearTimeout(to);
    }
    if (!r.ok) {
      const text = (await r.text()).slice(0, 2000);
      throw new Error(`synapsedx ${r.status} ${path}: ${text}`);
    }
    const text = await r.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  // ---- auth ----
  login(email: string, orgSlug = 'acme') {
    return this.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ email, orgSlug }),
    });
  }
  refresh(refreshToken: string) {
    return this.req<{ accessToken: string; refreshToken: string }>('/v1/auth/refresh', {
      method: 'POST', body: JSON.stringify({ refreshToken }),
    });
  }
  logout(refreshToken: string) {
    return this.req('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  }
  logoutAll(refreshToken: string) {
    return this.req<{ ok: boolean; revoked: number }>('/v1/auth/logout-all', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  }
  verify() { return this.req('/v1/auth/verify'); }
  me() { return this.req('/v1/auth/me'); }
  oidcConfig() { return this.req('/v1/auth/oidc/config'); }
  oidcStart(org = 'acme') { return this.req(`/v1/auth/oidc/start?org=${encodeURIComponent(org)}`); }
  oidcCallback(code: string, state: string) {
    return this.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/oidc/callback', {
      method: 'POST', body: JSON.stringify({ code, state }),
    });
  }

  // ---- orgs/accounts ----
  listOrgs(): Promise<any[]> { return this.req('/v1/orgs'); }
  createOrg(slug: string, displayName: string) {
    return this.req('/v1/orgs', { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  listAccounts(orgId: string) { return this.req(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`); }
  listUsers(orgId: string) { return this.req(`/v1/orgs/${encodeURIComponent(orgId)}/users`); }
  createUser(orgId: string, email: string, displayName?: string) {
    return this.req(`/v1/orgs/${encodeURIComponent(orgId)}/users`, { method: 'POST', body: JSON.stringify({ email, displayName }) });
  }
  createAccount(orgId: string, slug: string, displayName: string) {
    return this.req(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`, { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  userPolicies(userId: string) { return this.req(`/v1/users/${encodeURIComponent(userId)}/policies`); }

  // ---- iam ----
  createRole(accountId: string, slug: string, description = '') {
    return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/roles`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listRoles(accountId: string) { return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/roles`); }
  deleteRole(roleId: string) { return this.req(`/v1/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }); }
  listPolicies(accountId: string) { return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`); }
  deletePolicy(policyId: string) { return this.req(`/v1/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' }); }
  createPolicy(accountId: string, slug: string, document: any, description = '') {
    return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`, { method: 'POST', body: JSON.stringify({ slug, document, description }) });
  }
  authorize(userId: string, action: string, resource: string, context?: Record<string, unknown>) {
    return this.req<{ allowed: boolean }>('/v1/authorize', { method: 'POST', body: JSON.stringify({ userId, action, resource, context }) });
  }
  attachPolicy(roleId: string, policyId: string) {
    return this.req(`/v1/roles/${encodeURIComponent(roleId)}/attach`, { method: 'POST', body: JSON.stringify({ policyId }) });
  }
  detachPolicy(roleId: string, policyId: string) {
    return this.req(`/v1/roles/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' });
  }
  rolePolicies(roleId: string) {
    return this.req(`/v1/roles/${encodeURIComponent(roleId)}/policies`);
  }
  assignRole(userId: string, roleId: string) {
    return this.req(`/v1/users/${encodeURIComponent(userId)}/assign`, { method: 'POST', body: JSON.stringify({ roleId }) });
  }
  unassignRole(userId: string, roleId: string) {
    return this.req(`/v1/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
  }
  userRoles(userId: string) {
    return this.req(`/v1/users/${encodeURIComponent(userId)}/roles`);
  }
  simulate(documents: any[], action: string, resource: string, context?: Record<string, unknown>) {
    return this.req<{ allowed: boolean }>('/v1/authorize/dry-run', { method: 'POST', body: JSON.stringify({ documents, action, resource, context }) });
  }
  listAudit(limit = 50, actor?: string) {
    const qs = `?limit=${limit}${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`;
    return this.req(`/v1/audit${qs}`);
  }
  createApiKey(accountId: string, name = 'default', scopes: string[] = ['*']) {
    return this.req<{ apiKey: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/keys`, { method: 'POST', body: JSON.stringify({ name, scopes }) });
  }
  revokeApiKey(keyId: string) {
    return this.req(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  }
  listApiKeys(accountId: string) {
    return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/keys`);
  }
  verifyApiKey(apiKey: string) {
    return this.req(`/v1/keys/verify`, { method: 'POST', body: JSON.stringify({ apiKey }) });
  }
  createServiceAccount(accountId: string, slug: string, description = '') {
    return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listServiceAccounts(accountId: string) { return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`); }
  serviceAccountToken(saId: string, scopes: string[] = ['*']) {
    return this.req<{ accessToken: string }>(`/v1/service-accounts/${encodeURIComponent(saId)}/token`, { method: 'POST', body: JSON.stringify({ scopes }) });
  }

  // ---- workflows (local engine via workflow-service) ----
  listWorkflows() { return this.req('/v1/workflows'); }
  getWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}`); }
  getExecution(id: string, includeData = false) {
    const qs = includeData ? '?includeData=true' : '';
    return this.req(`/v1/executions/${encodeURIComponent(id)}${qs}`);
  }
  listExecutions(query: string | Record<string, string | number | boolean | undefined> = ''): Promise<any[]> {
    let q = '';
    if (typeof query === 'string') {
      q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    } else if (query && typeof query === 'object') {
      // Allowlist mirrors GET /v1/executions (limit/offset/workflowId/status/triggeredBy/includeData).
      const allowed = ['limit', 'offset', 'workflowId', 'status', 'triggeredBy', 'includeData'] as const;
      const params = new URLSearchParams();
      for (const k of allowed) {
        const v = (query as any)[k];
        if (v !== undefined && v !== null && String(v) !== '') params.set(k, String(v));
      }
      const s = params.toString();
      q = s ? `?${s}` : '';
    }
    return this.req(`/v1/executions${q}`).then(unwrapExecutions);
  }
  executeWorkflow(id: string, payload: Record<string, unknown> = {}) {
    return this.req(`/v1/workflows/${encodeURIComponent(id)}/execute`, { method: 'POST', body: JSON.stringify(payload) });
  }
  activateWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' }); }
  deactivateWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }); }
  createWorkflowFromTemplate(template: string, name?: string) {
    return this.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ template, name }) });
  }
  createWorkflow(name: string, definition: any, settings?: Record<string, unknown>) {
    return this.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ name, definition, ...(settings ? { settings } : {}) }) });
  }
  updateWorkflow(id: string, patch: { name?: string; definition?: any; settings?: Record<string, unknown> }) {
    return this.req(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  deleteWorkflow(id: string) {
    return this.req(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  listTemplates() { return this.req('/v1/templates'); }
  getTemplate(name: string) { return this.req(`/v1/templates/${encodeURIComponent(name)}`); }
  testRun(definition: any, input: Record<string, unknown> = {}, workflowId?: string) {
    return this.req('/v1/workflows/test-run', { method: 'POST', body: JSON.stringify({ definition, input, ...(workflowId ? { workflowId } : {}) }) });
  }

  // ---- generic escape hatch (forward-compat with endpoints added after this SDK) ----
  call(method: string, path: string, body?: unknown) {
    const m = String(method || 'GET').toUpperCase();
    return this.req(path.startsWith('/') ? path : `/${path}`, {
      method: m,
      body: body === undefined || m === 'GET' || m === 'HEAD' ? undefined : JSON.stringify(body),
    });
  }

  // ---- credentials (account-scoped secrets; PROPOSED contract — backend in progress) ----
  //
  // Backend contract (dev1, pending): secrets are encrypted at rest and NEVER
  // returned — create/rotate accept a `secret` once; list/get return metadata
  // only: {id, name, type, accountId, expiresAt, version}.
  // `type` is one of: bearer|basic|apiKey|oauth2 (passed through, not validated
  // client-side, so future types keep working).
  createCredential(accountId: string, opts: { name: string; type: string; secret: string; expiresAt?: string }) {
    return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/credentials`, {
      method: 'POST',
      body: JSON.stringify({ name: opts.name, type: opts.type, secret: opts.secret, ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) }),
    });
  }
  listCredentials(accountId: string) {
    return this.req(`/v1/accounts/${encodeURIComponent(accountId)}/credentials`);
  }
  getCredential(id: string) {
    return this.req(`/v1/credentials/${encodeURIComponent(id)}`);
  }
  deleteCredential(id: string) {
    return this.req(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  rotateCredential(id: string, secret: string) {
    return this.req(`/v1/credentials/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: JSON.stringify({ secret }) });
  }

  // ---- LDS (datasource / license catalog; base path /v1/lds) ----
  //
  // Contract: GET /v1/lds/licenses returns the built-in SPDX + proprietary
  // catalog; datasources own a name/entityType/license and a set of typed
  // attributes; records are ingested into NGSI-LD entities and exported as
  // JSON-LD. Every endpoint accepts Bearer JWT or X-API-Key.
  ldsLicenses(): Promise<any[]> { return this.req('/v1/lds/licenses'); }
  ldsDatasources(query: { orgId?: string; accountId?: string } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (query.orgId) params.set('orgId', query.orgId);
    if (query.accountId) params.set('accountId', query.accountId);
    const s = params.toString();
    return this.req(`/v1/lds/datasources${s ? `?${s}` : ''}`);
  }
  ldsCreateDatasource(input: LdsDatasourceInput) {
    return this.req('/v1/lds/datasources', { method: 'POST', body: JSON.stringify(input) });
  }
  ldsDatasource(id: string) { return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}`); }
  ldsUpdateDatasource(id: string, patch: Partial<LdsDatasourceInput>) {
    return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  ldsDeleteDatasource(id: string) {
    return this.req<{ ok: boolean }>(`/v1/lds/datasources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  ldsAttributes(id: string): Promise<any[]> {
    return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}/attributes`);
  }
  ldsSetAttributes(id: string, attributes: LdsAttributeInput[]): Promise<any[]> {
    return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}/attributes`, {
      method: 'PUT', body: JSON.stringify({ attributes }),
    });
  }
  /**
   * Ingest into a datasource. `records` accepts a single record object, an
   * array (wrapped as `{records}`), or a pre-wrapped `{records}`/`{record}`
   * body — all three shapes the endpoint accepts.
   */
  ldsIngest(id: string, records: Record<string, unknown> | Record<string, unknown>[]): Promise<LdsIngestResult> {
    const body = Array.isArray(records)
      ? { records }
      : records && typeof records === 'object' && ('records' in records || 'record' in records)
        ? records
        : { record: records };
    return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}/records`, {
      method: 'POST', body: JSON.stringify(body),
    });
  }
  /** List NGSI-LD entities; limit 1..500 (default 100), visibility public|restricted only. */
  ldsEntities(id: string, query: LdsEntitiesQuery = {}): Promise<any[]> {
    const allowed = ['limit', 'offset', 'visibility'] as const;
    const params = new URLSearchParams();
    for (const k of allowed) {
      const v = query[k];
      if (v !== undefined && v !== null && String(v) !== '') params.set(k, String(v));
    }
    const s = params.toString();
    return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}/entities${s ? `?${s}` : ''}`);
  }
  ldsEntity(id: string, entityId: string) {
    return this.req(`/v1/lds/datasources/${encodeURIComponent(id)}/entities/${encodeURIComponent(entityId)}`);
  }
  ldsStats(id: string) {
    return this.req<{ records: number; attributes: { public: number; restricted: number; internal: number }; lastIngestAt: string | null }>(
      `/v1/lds/datasources/${encodeURIComponent(id)}/stats`,
    );
  }
}

/**
 * Normalize GET /v1/executions responses: the engine returns `{data: []}`
 * (envelope, forward-compat with the old n8n proxy); older mocks return a
 * bare array. Accepts both so callers always get an array.
 */
export function unwrapExecutions(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload == null ? [] : payload as any;
}

/**
 * Fire a public inbound webhook: `ANY /webhook/:path` (no auth) triggers the
 * ACTIVE workflow whose webhook node declares that `path`.
 *
 * NOTE: the gateway does not proxy `/webhook/*` — pass the workflow-service
 * origin (e.g. `http://localhost:4002`), not the gateway URL. `path` is the
 * webhook node's `parameters.path` (e.g. `synapsedx-event`), not a workflow id.
 */
export async function triggerWebhook(
  webhookBaseUrl: string,
  path: string,
  payload?: unknown,
  init?: { method?: string; timeoutMs?: number },
): Promise<any> {
  const base = webhookBaseUrl.replace(/\/$/, '');
  const clean = String(path || '').replace(/^\/+|\/+$/g, '').split('?')[0];
  if (!clean) throw new Error('synapsedx webhook: path required');
  const method = (init?.method || (payload === undefined ? 'GET' : 'POST')).toUpperCase();
  const url = `${base}/webhook/${clean}`;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), init?.timeoutMs ?? 15000);
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (e: any) {
    throw new Error(`synapsedx network /webhook/${clean}: ${e?.message || e}`);
  } finally {
    clearTimeout(to);
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`synapsedx ${r.status} /webhook/${clean}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
