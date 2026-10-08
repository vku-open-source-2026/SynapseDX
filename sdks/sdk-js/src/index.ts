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
  assignRole(userId: string, roleId: string) {
    return this.req(`/v1/users/${encodeURIComponent(userId)}/assign`, { method: 'POST', body: JSON.stringify({ roleId }) });
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

  // ---- workflows (n8n via workflow-service) ----
  listWorkflows() { return this.req('/v1/workflows'); }
  getWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}`); }
  getExecution(id: string) { return this.req(`/v1/executions/${encodeURIComponent(id)}`); }
  listExecutions(query = '') {
    const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    return this.req(`/v1/executions${q}`);
  }
  executeWorkflow(id: string, payload: Record<string, unknown> = {}) {
    return this.req(`/v1/workflows/${encodeURIComponent(id)}/execute`, { method: 'POST', body: JSON.stringify(payload) });
  }
  activateWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' }); }
  deactivateWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }); }
  createWorkflowFromTemplate(template: string, name?: string) {
    return this.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ template, name }) });
  }
  createWorkflow(name: string, definition: any) {
    return this.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ name, definition }) });
  }
  listTemplates() { return this.req('/v1/templates'); }
  getTemplate(name: string) { return this.req(`/v1/templates/${encodeURIComponent(name)}`); }
}
