/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * OLP JavaScript SDK — works in Node 18+ and browsers (fetch-based).
 */

export interface OlpClientOptions {
  baseUrl: string; // gateway, e.g. http://localhost:8080
  token?: string; // Bearer JWT
  apiKey?: string; // X-API-Key
}

export class OlpClient {
  private baseUrl: string;
  private token?: string;
  private apiKey?: string;

  constructor(opts: OlpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.apiKey = opts.apiKey;
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
    try {
      r = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers((init?.headers as any) || {}),
      });
    } catch (e: any) {
      throw new Error(`OLP network ${path}: ${e?.message || e}`);
    }
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`OLP ${r.status} ${path}: ${text}`);
    }
    return (await r.json()) as T;
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
  verify() { return this.req('/v1/auth/verify'); }

  // ---- orgs/accounts ----
  listOrgs(): Promise<any[]> { return this.req('/v1/orgs'); }
  createOrg(slug: string, displayName: string) {
    return this.req('/v1/orgs', { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  listAccounts(orgId: string) { return this.req(`/v1/orgs/${orgId}/accounts`); }
  listUsers(orgId: string) { return this.req(`/v1/orgs/${orgId}/users`); }
  createUser(orgId: string, email: string, displayName?: string) {
    return this.req(`/v1/orgs/${orgId}/users`, { method: 'POST', body: JSON.stringify({ email, displayName }) });
  }
  createAccount(orgId: string, slug: string, displayName: string) {
    return this.req(`/v1/orgs/${orgId}/accounts`, { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }

  // ---- iam ----
  createRole(accountId: string, slug: string, description = '') {
    return this.req(`/v1/accounts/${accountId}/roles`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listRoles(accountId: string) { return this.req(`/v1/accounts/${accountId}/roles`); }
  listPolicies(accountId: string) { return this.req(`/v1/accounts/${accountId}/policies`); }
  createPolicy(accountId: string, slug: string, document: any, description = '') {
    return this.req(`/v1/accounts/${accountId}/policies`, { method: 'POST', body: JSON.stringify({ slug, document, description }) });
  }
  authorize(userId: string, action: string, resource: string, context?: Record<string, unknown>) {
    return this.req<{ allowed: boolean }>('/v1/authorize', { method: 'POST', body: JSON.stringify({ userId, action, resource, context }) });
  }
  attachPolicy(roleId: string, policyId: string) {
    return this.req(`/v1/roles/${roleId}/attach`, { method: 'POST', body: JSON.stringify({ policyId }) });
  }
  assignRole(userId: string, roleId: string) {
    return this.req(`/v1/users/${userId}/assign`, { method: 'POST', body: JSON.stringify({ roleId }) });
  }
  simulate(documents: any[], action: string, resource: string, context?: Record<string, unknown>) {
    return this.req<{ allowed: boolean }>('/v1/authorize/dry-run', { method: 'POST', body: JSON.stringify({ documents, action, resource, context }) });
  }
  createApiKey(accountId: string, name = 'default', scopes: string[] = ['*']) {
    return this.req<{ apiKey: string }>(`/v1/accounts/${accountId}/keys`, { method: 'POST', body: JSON.stringify({ name, scopes }) });
  }
  createServiceAccount(accountId: string, slug: string, description = '') {
    return this.req(`/v1/accounts/${accountId}/service-accounts`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listServiceAccounts(accountId: string) { return this.req(`/v1/accounts/${accountId}/service-accounts`); }
  serviceAccountToken(saId: string, scopes: string[] = ['*']) {
    return this.req<{ accessToken: string }>(`/v1/service-accounts/${saId}/token`, { method: 'POST', body: JSON.stringify({ scopes }) });
  }

  // ---- workflows (n8n via workflow-service) ----
  listWorkflows() { return this.req('/v1/workflows'); }
  getWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}`); }
  activateWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' }); }
  deactivateWorkflow(id: string) { return this.req(`/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }); }
  createWorkflowFromTemplate(template: string, name?: string) {
    return this.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ template, name }) });
  }
  listTemplates() { return this.req('/v1/templates'); }
}
