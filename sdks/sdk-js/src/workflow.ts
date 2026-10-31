/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow client: templates, workflow CRUD/lifecycle, executions, test runs
 * and public inbound webhooks.
 */

import { HttpClient } from './_http';

/** Credential kinds accepted by the workflow engine (used by http/webhook nodes). */
export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'hmac';

export interface CredentialInput {
  /** Owning account (credentials are account-scoped, org-bound for org callers). */
  accountId: string;
  name: string;
  kind?: CredentialKind | string;
  type?: CredentialKind | string;
  /** Write-only: never returned by any endpoint. */
  secret: string;
}

export interface CredentialMetadata {
  id: string;
  accountId: string;
  name: string;
  kind: CredentialKind | string;
  createdAt: string;
  updatedAt: string;
}

export class WorkflowService {
  constructor(private readonly http: HttpClient) {}

  // ---- templates ----
  listTemplates() { return this.http.req('/v1/templates'); }
  getTemplate(name: string) { return this.http.req(`/v1/templates/${encodeURIComponent(name)}`); }

  // ---- workflows ----
  listWorkflows() { return this.http.req('/v1/workflows'); }
  getWorkflow(id: string) { return this.http.req(`/v1/workflows/${encodeURIComponent(id)}`); }
  createWorkflowFromTemplate(template: string, name?: string) {
    return this.http.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ template, name }) });
  }
  createWorkflow(name: string, definition: any, settings?: Record<string, unknown>) {
    return this.http.req('/v1/workflows', { method: 'POST', body: JSON.stringify({ name, definition, ...(settings ? { settings } : {}) }) });
  }
  updateWorkflow(id: string, patch: { name?: string; definition?: any; settings?: Record<string, unknown> }) {
    return this.http.req(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  deleteWorkflow(id: string) {
    return this.http.req(`/v1/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  activateWorkflow(id: string) { return this.http.req(`/v1/workflows/${encodeURIComponent(id)}/activate`, { method: 'POST' }); }
  deactivateWorkflow(id: string) { return this.http.req(`/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }); }
  executeWorkflow(id: string, payload: Record<string, unknown> = {}) {
    return this.http.req(`/v1/workflows/${encodeURIComponent(id)}/execute`, { method: 'POST', body: JSON.stringify(payload) });
  }

  // ---- executions ----
  getExecution(id: string, includeData = false) {
    const qs = includeData ? '?includeData=true' : '';
    return this.http.req(`/v1/executions/${encodeURIComponent(id)}${qs}`);
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
    return this.http.req(`/v1/executions${q}`).then(unwrapExecutions);
  }
  testRun(definition: any, input: Record<string, unknown> = {}, workflowId?: string) {
    return this.http.req('/v1/workflows/test-run', { method: 'POST', body: JSON.stringify({ definition, input, ...(workflowId ? { workflowId } : {}) }) });
  }

  // ---- credentials (account-scoped secrets, encrypted at rest) ----
  // Secrets are write-only: create/rotate accept `secret` once, every read
  // returns metadata only. Kinds: bearer | api-key | basic | hmac.
  createCredential(
    inputOrAccountId: CredentialInput | string,
    opts?: { name: string; kind?: CredentialKind | string; type?: CredentialKind | string; secret: string; expiresAt?: string }
  ): Promise<CredentialMetadata> {
    const body = typeof inputOrAccountId === 'string'
      ? {
          accountId: inputOrAccountId,
          name: opts?.name,
          kind: opts?.kind || opts?.type || 'bearer',
          secret: opts?.secret,
        }
      : {
          accountId: inputOrAccountId.accountId,
          name: inputOrAccountId.name,
          kind: inputOrAccountId.kind || inputOrAccountId.type || 'bearer',
          secret: inputOrAccountId.secret,
        };
    return this.http.req('/v1/credentials', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
  listCredentials(accountId?: string): Promise<CredentialMetadata[]> {
    const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return this.http.req<any>(`/v1/credentials${qs}`).then(unwrapCredentialList);
  }
  getCredential(id: string): Promise<CredentialMetadata> {
    return this.http.req(`/v1/credentials/${encodeURIComponent(id)}`);
  }
  rotateCredential(id: string, secret: string): Promise<CredentialMetadata> {
    return this.http.req(`/v1/credentials/${encodeURIComponent(id)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ secret }),
    });
  }
  deleteCredential(id: string) {
    return this.http.req(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ---- public inbound webhooks ----
  /**
   * Fire a public inbound webhook through the gateway: `ANY /webhook/:path`.
   * No auth is required; per-workflow auth/rate-limit/idempotency still apply.
   * `path` is the webhook node's `parameters.path`, not a workflow id.
   */
  triggerWebhook(path: string, payload?: unknown, init: { method?: string } = {}) {
    const clean = String(path || '').replace(/^\/+|\/+$/g, '').split('?')[0];
    if (!clean) throw new Error('synapseone webhook: path required');
    const method = (init.method || (payload === undefined ? 'GET' : 'POST')).toUpperCase();
    return this.http.call(method, `/webhook/${clean}`, payload);
  }
}

/** Normalize GET /v1/credentials: the API returns `{data: []}`. */
export function unwrapCredentialList(payload: any): CredentialMetadata[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return payload == null ? [] : payload as any;
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
 * The gateway proxies `/webhook/*` to the workflow service, so `webhookBaseUrl`
 * is normally the gateway URL. Use `client.workflow.triggerWebhook()` for the
 * gateway-bound convenience form. `path` is the webhook node's
 * `parameters.path` (e.g. `synapseone-event`), not a workflow id.
 */
export async function triggerWebhook(
  webhookBaseUrl: string,
  path: string,
  payload?: unknown,
  init?: { method?: string; timeoutMs?: number },
): Promise<any> {
  const base = webhookBaseUrl.replace(/\/$/, '');
  const clean = String(path || '').replace(/^\/+|\/+$/g, '').split('?')[0];
  if (!clean) throw new Error('synapseone webhook: path required');
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
    throw new Error(`synapseone network /webhook/${clean}: ${e?.message || e}`);
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
  if (!r.ok) throw new Error(`synapseone ${r.status} /webhook/${clean}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
