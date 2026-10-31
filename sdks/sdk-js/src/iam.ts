/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Synapse IAM client: auth/OIDC, orgs/accounts/users, roles/policies,
 * API keys, service accounts and usage analytics.
 *
 * Access it through `new SynapseOneClient(...).iam` or build it with an
 * HttpClient directly.
 */

import { HttpClient } from './_http';

export class IamService {
  constructor(private readonly http: HttpClient) {}

  // ---- auth ----
  login(email: string, orgSlug = 'acme') {
    return this.http.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/login', {
      method: 'POST', body: JSON.stringify({ email, orgSlug }),
    });
  }
  refresh(refreshToken: string) {
    return this.http.req<{ accessToken: string; refreshToken: string }>('/v1/auth/refresh', {
      method: 'POST', body: JSON.stringify({ refreshToken }),
    });
  }
  logout(refreshToken: string) {
    return this.http.req('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  }
  logoutAll(refreshToken: string) {
    return this.http.req<{ ok: boolean; revoked: number }>('/v1/auth/logout-all', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  }
  verify() { return this.http.req('/v1/auth/verify'); }
  me() { return this.http.req('/v1/auth/me'); }
  oidcConfig() { return this.http.req('/v1/auth/oidc/config'); }
  oidcStart(org = 'acme') { return this.http.req(`/v1/auth/oidc/start?org=${encodeURIComponent(org)}`); }
  oidcCallback(code: string, state: string) {
    return this.http.req<{ accessToken: string; refreshToken: string; user: any }>('/v1/auth/oidc/callback', {
      method: 'POST', body: JSON.stringify({ code, state }),
    });
  }

  // ---- orgs/accounts/users ----
  listOrgs(): Promise<any[]> { return this.http.req('/v1/orgs'); }
  createOrg(slug: string, displayName: string) {
    return this.http.req('/v1/orgs', { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  listAccounts(orgId: string) { return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`); }
  listUsers(orgId: string) { return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/users`); }
  createUser(orgId: string, email: string, displayName?: string) {
    return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/users`, { method: 'POST', body: JSON.stringify({ email, displayName }) });
  }
  createAccount(orgId: string, slug: string, displayName: string) {
    return this.http.req(`/v1/orgs/${encodeURIComponent(orgId)}/accounts`, { method: 'POST', body: JSON.stringify({ slug, displayName }) });
  }
  userPolicies(userId: string) { return this.http.req(`/v1/users/${encodeURIComponent(userId)}/policies`); }

  // ---- roles / policies ----
  createRole(accountId: string, slug: string, description = '') {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/roles`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listRoles(accountId: string) { return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/roles`); }
  deleteRole(roleId: string) { return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' }); }
  listPolicies(accountId: string) { return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`); }
  deletePolicy(policyId: string) { return this.http.req(`/v1/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' }); }
  createPolicy(accountId: string, slug: string, document: any, description = '') {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/policies`, { method: 'POST', body: JSON.stringify({ slug, document, description }) });
  }
  authorize(userId: string, action: string, resource: string, context?: Record<string, unknown>) {
    return this.http.req<{ allowed: boolean }>('/v1/authorize', { method: 'POST', body: JSON.stringify({ userId, action, resource, context }) });
  }
  attachPolicy(roleId: string, policyId: string) {
    return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}/attach`, { method: 'POST', body: JSON.stringify({ policyId }) });
  }
  detachPolicy(roleId: string, policyId: string) {
    return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}/policies/${encodeURIComponent(policyId)}`, { method: 'DELETE' });
  }
  rolePolicies(roleId: string) {
    return this.http.req(`/v1/roles/${encodeURIComponent(roleId)}/policies`);
  }
  assignRole(userId: string, roleId: string) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/assign`, { method: 'POST', body: JSON.stringify({ roleId }) });
  }
  unassignRole(userId: string, roleId: string) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
  }
  userRoles(userId: string) {
    return this.http.req(`/v1/users/${encodeURIComponent(userId)}/roles`);
  }
  simulate(documents: any[], action: string, resource: string, context?: Record<string, unknown>) {
    return this.http.req<{ allowed: boolean }>('/v1/authorize/dry-run', { method: 'POST', body: JSON.stringify({ documents, action, resource, context }) });
  }
  listAudit(limit = 50, actor?: string) {
    const qs = `?limit=${limit}${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`;
    return this.http.req(`/v1/audit${qs}`);
  }

  // ---- API keys ----
  createApiKey(accountId: string, name = 'default', scopes: string[] = ['*']) {
    return this.http.req<{ apiKey: string }>(`/v1/accounts/${encodeURIComponent(accountId)}/keys`, { method: 'POST', body: JSON.stringify({ name, scopes }) });
  }
  revokeApiKey(keyId: string) {
    return this.http.req(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  }
  listApiKeys(accountId: string) {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/keys`);
  }
  verifyApiKey(apiKey: string) {
    return this.http.req(`/v1/keys/verify`, { method: 'POST', body: JSON.stringify({ apiKey }) });
  }

  // ---- service accounts ----
  createServiceAccount(accountId: string, slug: string, description = '') {
    return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`, { method: 'POST', body: JSON.stringify({ slug, description }) });
  }
  listServiceAccounts(accountId: string) { return this.http.req(`/v1/accounts/${encodeURIComponent(accountId)}/service-accounts`); }
  // scopes omitted -> the server delegates the caller's own scopes (never
  // widens to '*'). Pass an explicit list to narrow the minted token.
  serviceAccountToken(saId: string, scopes?: string[]) {
    return this.http.req<{ accessToken: string }>(`/v1/service-accounts/${encodeURIComponent(saId)}/token`, {
      method: 'POST',
      body: JSON.stringify(scopes === undefined ? {} : { scopes }),
    });
  }

  // ---- usage & telemetry ----
  usageSummary(filter?: {
    from?: string | Date;
    to?: string | Date;
    feature?: string;
    accountId?: string;
    actor?: string;
    method?: string;
    status?: number;
    statusClass?: string;
  }) {
    const qs = new URLSearchParams();
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (v !== undefined && v !== null && String(v) !== '') {
          qs.set(k, v instanceof Date ? v.toISOString() : String(v));
        }
      }
    }
    const s = qs.toString();
    return this.http.req<any>(`/v1/usage/summary${s ? `?${s}` : ''}`);
  }

  usageEvents(filter?: {
    from?: string | Date;
    to?: string | Date;
    feature?: string;
    accountId?: string;
    actor?: string;
    method?: string;
    status?: number;
    statusClass?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) {
    const qs = new URLSearchParams();
    if (filter) {
      for (const [k, v] of Object.entries(filter)) {
        if (v !== undefined && v !== null && String(v) !== '') {
          qs.set(k, v instanceof Date ? v.toISOString() : String(v));
        }
      }
    }
    const s = qs.toString();
    return this.http.req<any>(`/v1/usage/events${s ? `?${s}` : ''}`);
  }
}
