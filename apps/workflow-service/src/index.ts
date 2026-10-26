/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow service: local built-in engine (Apache-2.0, no external engine).
 * Stores workflows + executions in Postgres (DATABASE_URL) with in-memory
 * fallback for dev/test. Executes webhook/cron/manual/httpRequest/code/
 * set/if/noOp DAGs via ./engine (sandboxed code).
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import {
  createWorkflowRec, getWorkflowRec, listWorkflowRecs, updateWorkflowRec, deleteWorkflowRec,
  createExecutionRec, getExecutionRec, listExecutionRecs, findActiveWebhookWorkflow,
  listActiveCronWorkflows, ensureTables, useDb, StoredWorkflow, StoredCredential,
  createCredentialRec, getCredentialRec, listCredentialRecs, deleteCredentialRec,
  toPublicCredential, decryptSecret,
} from './store';
import type { Principal } from './store';
import { runWorkflow, detectCycle, workflowCronIntervalMs, workflowCronNextRunAt, validateCronParams, validateSynapseDXParams, validateIntegrationParams, validateAgentToolIds, extractEmbeddingVector, isBlockedUrl as engineIsBlockedUrl, isAllowedSelfUrl, selfAllowlist, actorFor, isWebhookType, isCronType, isTriggerType, isCodeType, isHttpRequestType, isIfType, isSetType, isNoOpType, isAiAgentType, isDecisionType, isModelType, isIntegrationType, edgeTargetPort, auxiliaryEdges } from './engine';
import type { CredentialResolver, RunPrincipal, SynapseDXCall, EngineNode, Connections } from './engine';

/** May this credential be resolved for this run principal? (P0-4/#5)
 *  - org-bound credentials: only inside their org, or by their owning account;
 *  - legacy unbound credentials (no org): only the owning account — org
 *    principals cannot reach secrets of unknown tenancy. */
export function credentialVisibleTo(rec: StoredCredential, p: Principal | null | undefined): boolean {
  if (!p) return true; // anonymous direct calls (dev/tests)
  const acctOk = !!p.account && rec.account_id === p.account;
  const orgOk = !!p.org && !!rec.org_id && rec.org_id === p.org;
  if (rec.org_id) return orgOk || acctOk;
  return acctOk;
}

/** Server-side credential resolver for node auth (P0-4): nodes reference
 *  credentialIds; secrets are decrypted only here, at run time, and only for
 *  the principal the run belongs to. */
export function makeCredentialResolver(p: Principal | null | undefined): CredentialResolver {
  return async (credentialId: string) => {
    if (!credentialId || typeof credentialId !== 'string' || credentialId.length > 128 || /[\r\n]/.test(credentialId)) return null;
    const rec = await getCredentialRec(credentialId);
    if (!rec || !credentialVisibleTo(rec, p)) return null;
    try {
      return { kind: rec.kind, secret: decryptSecret(rec.secret_enc) };
    } catch {
      return null;
    }
  };
}

/** Tenant read guard (P0-3): tenant-bound rows are invisible outside their
 *  tenant. Org-bound rows belong to the org; account-only rows to the
 *  account. Legacy global rows (no tenant at all) are dev/anonymous-only —
 *  authenticated callers never see pre-tenancy leftovers. Returns false →
 *  caller gets 404 (existence not leaked). */
function canAccessWorkflow(w: StoredWorkflow, p: Principal | null | undefined): boolean {
  if (!p) return true; // anonymous direct calls (dev/tests)
  if (p.account && w.account_id === p.account) return true;
  if (p.org && w.org_id === p.org) return true;
  return false;
}

/** Tenant filter for execution lists (P0-3/#6): match the principal snapshot
 *  stored at run time. Null = the caller has no tenant scope; callers must
 *  fail closed on it (anonymous direct calls return {} = unfiltered only for
 *  the dev/test fallback). */
function executionScope(p: Principal | null | undefined): { orgId?: string; accountId?: string } | null {
  if (!p) return {};
  if (p.org) return { orgId: p.org };
  if (p.account) return { accountId: p.account };
  return null;
}

/** May this execution record be read by this principal? Same tenant rules as
 *  canAccessWorkflow, applied to the run-time principal snapshot. */
function canAccessExecution(e: { principal?: Principal | null }, p: Principal | null | undefined): boolean {
  if (!p) return true;
  if (p.account && e.principal?.account === p.account) return true;
  if (p.org && e.principal?.org === p.org) return true;
  return false;
}

/** Nested workflow executions (agent `workflow_run` / SynapseFlow node).
 *  AsyncLocalStorage keeps the depth per async chain, so concurrent runs
 *  cannot corrupt each other's counters. */
const workflowRunContext = new AsyncLocalStorage<{ depth: number }>();
const MAX_WORKFLOW_NESTING = 3;

/** First-party SynapseDX caller for synapsedx.api nodes: IAM resources go to
 *  IAM over the service network with the run principal stamped (IAM enforces
 *  its own canActFor tenant checks on it); workflow-local resources are read
 *  straight from the store, scoped by canAccessWorkflow. No arbitrary paths —
 *  only the engine's SYNAPSEDX_API_RESOURCES table can reach here. */
export const synapsedxCall: SynapseDXCall = async (resource, operation, args, principal) => {
  const cleanId = (v: unknown, field: string, max = 256): string => {
    const s = String(v ?? '');
    if (!s || s.length > max || /[\r\n]/.test(s)) throw new Error(`synapsedx.api: '${resource}.${operation}' needs a valid '${field}'`);
    return s;
  };
  const a = args && typeof args === 'object' ? args : {};
  // Workflow-local resources (no HTTP hop, tenant-scoped by principal).
  if (resource === 'workflows') {
    if (operation === 'list') {
      const all = await listWorkflowRecs();
      return all.filter((w) => canAccessWorkflow(w, principal)).map(toApiWorkflow);
    }
    const w = await getWorkflowRec(cleanId(a.id, 'id', 128));
    if (!w || !canAccessWorkflow(w, principal)) throw new Error(`synapsedx.api: workflows.${operation} -> 404 (not found)`);
    if (operation === 'get') return toApiWorkflow(w);
    if (operation === 'execute') {
      const depth = workflowRunContext.getStore()?.depth || 0;
      if (depth >= MAX_WORKFLOW_NESTING) {
        throw new Error(`synapsedx.api: workflows.execute nesting limit (${MAX_WORKFLOW_NESTING}) reached`);
      }
      const input = a.input && typeof a.input === 'object' && !Array.isArray(a.input) ? a.input : {};
      if (JSON.stringify(input).length > 200 * 1024) throw new Error('synapsedx.api: workflows.execute input exceeds 200KB');
      const runPrincipal = principal || workflowRunPrincipal(w);
      const startedAt = new Date().toISOString();
      const r = await workflowRunContext.run({ depth: depth + 1 }, () =>
        runWorkflow(
          { nodes: w.nodes as any, connections: w.connections as any, name: w.name, settings: w.settings as any },
          input,
          {
            triggeredBy: 'workflow',
            principal: runPrincipal,
            credentialResolver: makeCredentialResolver(runPrincipal),
            synapsedxCall,
          },
        ),
      );
      const finishedAt = new Date().toISOString();
      const exec = await createExecutionRec({
        workflow_id: w.id,
        workflow_name: w.name,
        status: r.status,
        input,
        output: r.output,
        node_runs: r.nodeRuns as any,
        error: (r as any).error ?? null,
        triggered_by: 'workflow',
        principal: runPrincipal,
        actor: actorFor(w.id, runPrincipal),
        startedAt,
        finishedAt,
      });
      if (r.status !== 'success') {
        throw new Error(`synapsedx.api: workflows.execute '${w.name}' failed: ${String((r as any).error || 'unknown error').slice(0, 300)}`);
      }
      return { ok: true, executionId: exec.id, workflow: { id: w.id, name: w.name }, output: r.output };
    }
    throw new Error(`synapsedx.api: unsupported call 'workflows.${operation}'`);
  }
  if (resource === 'executions') {
    if (operation === 'list') {
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
      const offset = Math.max(Number(a.offset) || 0, 0);
      const status = typeof a.status === 'string' && ['success', 'error', 'running'].includes(a.status) ? a.status : undefined;
      const workflowId = typeof a.workflowId === 'string' && a.workflowId ? cleanId(a.workflowId, 'workflowId', 128) : undefined;
      const scope = executionScope(principal);
      if (!scope) return { data: [] };
      const { items } = await listExecutionRecs({ workflowId, status, limit, offset, ...scope });
      return { data: items.map((e) => toApiExecution(e, false)) };
    }
    const e = await getExecutionRec(cleanId(a.id, 'id', 128));
    if (!e || !canAccessExecution(e, principal)) throw new Error('synapsedx.api: executions.get -> 404 (not found)');
    return toApiExecution(e, true);
  }
  if (resource === 'templates') {
    if (operation === 'list') return listTemplates();
    const t = buildTemplate(cleanId(a.name, 'name', 64), cleanId(a.name, 'name', 64));
    if (!t) throw new Error('synapsedx.api: templates.get -> 404 (template_not_found)');
    return t;
  }
  // SynapseLDS (linked data) over the service network as the run principal.
  // Records published here go through the same structural-allowlist projector
  // as everything else: reserved/system fields are quarantined, unregistered
  // dynamic fields default-deny out of every NGSI-LD export.
  if (resource === 'lds') {
    const LDS_BASE = (process.env.LDS_SERVICE_URL || 'http://lds:4004').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseDX-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseDX-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseDX-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseDX-Account'] = String(principal.account);
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list-datasources') {
        path = '/v1/lds/datasources';
      } else if (operation === 'publish-record') {
        method = 'POST';
        path = `/v1/lds/datasources/${encodeURIComponent(cleanId(a.datasourceId, 'datasourceId', 128))}/records`;
        const record = a.record !== undefined ? a.record : a.data;
        if (record === undefined || record === null) {
          throw new Error("synapsedx.api: lds.publish-record needs 'record' (an object — put it in input, e.g. ={{ $json }})");
        }
        if (typeof record !== 'object' || Array.isArray(record)) {
          throw new Error("synapsedx.api: lds.publish-record 'record' must be a JSON object");
        }
        body = { record };
      } else if (operation === 'get-entity') {
        method = 'GET';
        path = `/v1/lds/datasources/${encodeURIComponent(cleanId(a.datasourceId, 'datasourceId', 128))}/entities/${encodeURIComponent(cleanId(a.entityId, 'entityId', 256))}`;
      } else {
        throw new Error(`synapsedx.api: unsupported call 'lds.${operation}'`);
      }
      const r = await fetch(`${LDS_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapsedx.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapsedx.api: SynapseLDS timed out after 20000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Base service
  if (resource === 'base') {
    const BASE_BASE = (process.env.BASE_SERVICE_URL || 'http://base:4005').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseDX-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseDX-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseDX-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseDX-Account'] = String(principal.account);
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list-collections') {
        path = '/v1/base/collections';
      } else if (operation === 'create-document') {
        method = 'POST';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/documents`;
        body = a.data !== undefined ? { id: a.id, data: a.data } : (a.document !== undefined ? { id: a.id, data: a.document } : a);
      } else if (operation === 'get-document') {
        method = 'GET';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/documents/${encodeURIComponent(cleanId(a.id, 'id', 256))}`;
      } else if (operation === 'query-documents') {
        method = 'POST';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/query`;
        // base-service expects `where` + `orderBy`; older workflows and the
        // AI tool use `filter`/`sort`, so accept both spellings. An empty
        // filter is invalid server-side, so omit it when the caller wants all.
        const where = a.where !== undefined ? a.where : a.filter;
        const orderBy = a.orderBy !== undefined ? a.orderBy : a.sort;
        const hasWhere = where !== undefined && where !== null && (
          Array.isArray(where)
            ? where.length > 0
            : typeof where === 'object'
              ? Object.keys(where).length > 0
              : String(where).trim().length > 0
        );
        body = {
          ...(hasWhere ? { where } : {}),
          ...(orderBy !== undefined ? { orderBy } : {}),
          limit: a.limit,
          offset: a.offset,
        };
      } else if (operation === 'delete-document') {
        method = 'DELETE';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/documents/${encodeURIComponent(cleanId(a.id, 'id', 256))}`;
      } else if (operation === 'vector-search') {
        let vector = a.vector ?? a.embedding;
        const queryText = a.query ?? a.text ?? a.prompt ?? (typeof a.input === 'string' ? a.input : undefined);
        if ((!Array.isArray(vector) || vector.length === 0) && queryText) {
          try {
            const embRes = await synapsedxCall('inference', 'embeddings', { input: String(queryText) }, principal);
            const rawVec = extractEmbeddingVector(embRes);
            if (rawVec && rawVec.length > 0) {
              vector = rawVec;
            }
          } catch (e: any) {
            throw new Error(`synapsedx.api: base.vector-search embedding failed: ${e?.message || e}`);
          }
        }
        method = 'POST';
        path = `/v1/base/collections/${encodeURIComponent(cleanId(a.collection, 'collection', 128))}/vector-search`;
        body = {
          vector,
          limit: a.limit ?? a.k,
          field: a.field,
          metric: a.metric,
          where: a.where !== undefined ? a.where : a.filter,
          as: a.as,
        };
      } else {
        throw new Error(`synapsedx.api: unsupported call 'base.${operation}'`);
      }
      const r = await fetch(`${BASE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapsedx.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapsedx.api: Base service timed out after 20000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Faststore service
  if (resource === 'faststore') {
    const FASTSTORE_BASE = (process.env.FASTSTORE_SERVICE_URL || 'http://faststore:4006').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseDX-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseDX-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseDX-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseDX-Account'] = String(principal.account);
        headers['X-SynapseDX-Tenant'] = String(principal.org || principal.account || principal.sub);
      } else {
        headers['X-SynapseDX-Tenant'] = 'platform';
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'get') {
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
      } else if (operation === 'set') {
        method = 'PUT';
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
        body = { value: a.value, ttlSeconds: a.ttlSeconds, nx: a.nx, xx: a.xx };
      } else if (operation === 'incr') {
        method = 'POST';
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}/incr`;
        body = { by: a.by !== undefined ? Number(a.by) : 1, ttlSeconds: a.ttlSeconds };
      } else if (operation === 'delete') {
        method = 'DELETE';
        path = `/v1/faststore/keys/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
      } else if (operation === 'hash-get') {
        path = `/v1/faststore/hashes/${encodeURIComponent(cleanId(a.key, 'key', 256))}${a.field ? `/${encodeURIComponent(String(a.field))}` : ''}`;
      } else if (operation === 'hash-set') {
        method = 'PUT';
        path = `/v1/faststore/hashes/${encodeURIComponent(cleanId(a.key, 'key', 256))}`;
        body = { values: a.values || a.fields || (a.field && a.value !== undefined ? { [a.field]: a.value } : {}), ttlSeconds: a.ttlSeconds };
      } else {
        throw new Error(`synapsedx.api: unsupported call 'faststore.${operation}'`);
      }
      const r = await fetch(`${FASTSTORE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      // Cache miss is a normal result for agents/if nodes, not a workflow
      // failure: return null instead of throwing on 404 for reads.
      if (r.status === 404 && (operation === 'get' || operation === 'hash-get')) {
        return operation === 'get' ? { key: a.key, value: null, hit: false } : { key: a.key, values: null, hit: false };
      }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapsedx.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapsedx.api: Faststore service timed out after 15000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Queue service
  if (resource === 'queue') {
    const QUEUE_BASE = (process.env.QUEUE_SERVICE_URL || 'http://queue:4007').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseDX-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseDX-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseDX-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseDX-Account'] = String(principal.account);
        headers['X-SynapseDX-Tenant'] = String(principal.org || principal.account || principal.sub);
      } else {
        headers['X-SynapseDX-Tenant'] = 'platform';
      }
      let method = 'GET';
      let path = '';
      let body: any;
      if (operation === 'list') {
        path = '/v1/queue/queues';
      } else if (operation === 'publish') {
        method = 'POST';
        path = `/v1/queue/queues/${encodeURIComponent(cleanId(a.queue, 'queue', 128))}/messages`;
        body = {
          payload: a.payload !== undefined ? a.payload : a.body !== undefined ? a.body : a.message,
          priority: a.priority,
          delaySeconds: a.delaySeconds,
        };
      } else if (operation === 'consume') {
        method = 'POST';
        path = `/v1/queue/queues/${encodeURIComponent(cleanId(a.queue, 'queue', 128))}/consume`;
        // queue-service uses maxMessages + consumer; keep `count` as a
        // backward-compatible alias for older workflows.
        body = {
          maxMessages: a.maxMessages !== undefined ? Number(a.maxMessages) : a.count !== undefined ? Number(a.count) : 1,
          consumer: a.consumer || 'workflow',
          visibilityTimeoutSeconds: a.visibilityTimeoutSeconds,
        };
      } else if (operation === 'ack') {
        method = 'POST';
        path = `/v1/queue/queues/${encodeURIComponent(cleanId(a.queue, 'queue', 128))}/ack`;
        body = { receipt: a.receipt || a.receiptHandle };
      } else {
        throw new Error(`synapsedx.api: unsupported call 'queue.${operation}'`);
      }
      const r = await fetch(`${QUEUE_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapsedx.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapsedx.api: Queue service timed out after 15000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }

  // Inference service
  if (resource === 'inference') {
    const INF_BASE = (process.env.INFERENCE_SERVICE_URL || 'http://inference:4008').replace(/\/$/, '');
    const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
    const rawInferenceTimeout = Number(process.env.INFERENCE_TIMEOUT_MS || 120000);
    const inferenceTimeoutMs = Math.min(Math.max(Number.isFinite(rawInferenceTimeout) ? rawInferenceTimeout : 120000, 1000), 300000);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), inferenceTimeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseDX-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseDX-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseDX-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseDX-Account'] = String(principal.account);
      }
      let method = 'POST';
      let path = '';
      let body: any;
      if (operation === 'chat') {
        path = '/v1/inference/chat/completions';
        body = {
          messages: a.messages,
          model: a.model,
          temperature: a.temperature,
          max_tokens: a.max_tokens,
          // Native tool calling must survive the workflow-service hop;
          // previously these fields were silently dropped.
          ...(a.tools !== undefined ? { tools: a.tools } : {}),
          ...(a.tool_choice !== undefined ? { tool_choice: a.tool_choice } : {}),
          ...(a.response_format !== undefined ? { response_format: a.response_format } : {}),
          ...(a.top_p !== undefined ? { top_p: a.top_p } : {}),
        };
      } else if (operation === 'embeddings') {
        path = '/v1/inference/embeddings';
        body = { input: a.input, model: a.model };
      } else if (operation === 'decision') {
        path = '/v1/inference/decision';
        body = { state: a.state, questions: a.questions, instruction: a.instruction };
      } else if (operation === 'route') {
        path = '/v1/inference/decision/route';
        body = { input: a.input, choices: a.choices, instruction: a.instruction };
      } else {
        throw new Error(`synapsedx.api: unsupported call 'inference.${operation}'`);
      }
      const r = await fetch(`${INF_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapsedx.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`synapsedx.api: Inference service timed out after ${inferenceTimeoutMs}ms`);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  }
  // IAM resources over the service network as the run principal.
  const IAM_BASE = (process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
  const INTERNAL = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  // #10: the IAM middleware requires a real caller credential even when the
  // internal secret is present (the secret proves gateway-origin, not identity).
  // Use a dedicated service API key — never the run user's JWT (workflow runs
  // outlive tokens and webhook/cron runs hold no user credential at all).
  const IAM_API_KEY = (process.env.SYNAPSEDX_IAM_API_KEY || '').trim();
  const iamFetch = async (method: string, path: string, body?: any): Promise<any> => {
    if (!IAM_API_KEY) {
      throw new Error('synapsedx.api: IAM calls need SYNAPSEDX_IAM_API_KEY (service credential) — see docs/configuration.md');
    }
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': IAM_API_KEY };
      if (INTERNAL) headers['x-synapsedx-internal'] = INTERNAL;
      if (principal?.sub) {
        headers['X-SynapseDX-Kind'] = String(principal.kind || 'user');
        headers['X-SynapseDX-User'] = String(principal.sub);
        if (principal.org) headers['X-SynapseDX-Org'] = String(principal.org);
        if (principal.account) headers['X-SynapseDX-Account'] = String(principal.account);
      }
      const r = await fetch(`${IAM_BASE}${path}`, {
        method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const detail = parsed && typeof parsed === 'object' ? (parsed.error || parsed.message || '') : '';
        throw new Error(`synapsedx.api: ${method} ${path} -> ${r.status}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`);
      }
      return parsed;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('synapsedx.api: IAM timed out after 15000ms');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(to);
    }
  };
  const enc = encodeURIComponent;
  switch (`${resource}.${operation}`) {
    case 'orgs.list':
      return iamFetch('GET', '/v1/orgs');
    case 'users.list':
      return iamFetch('GET', `/v1/orgs/${enc(cleanId(a.orgId, 'orgId'))}/users`);
    case 'roles.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/roles`);
    case 'policies.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/policies`);
    case 'authorize.check':
      return iamFetch('POST', '/v1/authorize', {
        userId: cleanId(a.userId, 'userId'), action: cleanId(a.action, 'action', 512),
        resource: cleanId(a.resource, 'resource', 2048), ...(a.context !== undefined ? { context: a.context } : {}),
      });
    case 'audit.query': {
      const qs = new URLSearchParams();
      qs.set('limit', String(Math.min(Math.max(Number(a.limit) || 20, 1), 200)));
      if (a.actor !== undefined) qs.set('actor', cleanId(a.actor, 'actor'));
      if (a.allowed !== undefined) qs.set('allowed', String(!!a.allowed));
      return iamFetch('GET', `/v1/audit?${qs.toString()}`);
    }
    case 'keys.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/keys`);
    case 'service-accounts.list':
      return iamFetch('GET', `/v1/accounts/${enc(cleanId(a.accountId, 'accountId'))}/service-accounts`);
    default:
      throw new Error(`synapsedx.api: unsupported call '${resource}.${operation}'`);
  }
};



dotenv.config();
const PORT = Number(process.env.PORT || 4002);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const IS_PROD_WF = process.env.NODE_ENV === 'production';

// In-process metrics (P2 /metrics): run counts by trigger+status, node
// error counts, webhook rejections by reason. Reset on restart.
// Module-level so both createApp routes and the cron loop can record.
const metricRuns = new Map<string, number>();
const metricWebhookRejected = new Map<string, number>();
function recordRun(triggeredBy: string, status: string, nodeRuns?: Array<{ status: string }>): void {
  const k = `${triggeredBy || 'manual'}|${status || 'success'}`;
  metricRuns.set(k, (metricRuns.get(k) || 0) + 1);
  if (nodeRuns) {
    const errs = nodeRuns.filter((r) => r.status === 'error').length;
    if (errs) metricRuns.set(`node-errors|total`, (metricRuns.get(`node-errors|total`) || 0) + errs);
  }
}
function recordWebhookReject(reason: string): void {
  metricWebhookRejected.set(reason, (metricWebhookRejected.get(reason) || 0) + 1);
}
export function __resetMetrics(): void {
  metricRuns.clear();
  metricWebhookRejected.clear();
}

/** SSRF guard: block workflow definitions that make the engine fetch internal targets.
 *  Single implementation lives in ./engine (isBlockedUrl honors the
 *  SYNAPSEDX_SELF_BASE_URLS allowlist); re-exported here for tests. */
const isBlockedUrl = engineIsBlockedUrl;
function findSsrfUrl(definition: any): string | null {
  // Recursive scan (depth-capped) so nested options (headers, bodyParameters,
  // assignments…) can't smuggle an internal URL past save-time validation.
  // Runtime execHttp re-checks the final URL + every redirect hop anyway.
  const seen = new Set<any>();
  const scan = (v: any, depth: number): string | null => {
    if (depth > 4 || v === null || v === undefined) return null;
    if (typeof v === 'string') {
      if (v.length < 2048 && /^https?:\/\//i.test(v) && isBlockedUrl(v)) return v;
      return null;
    }
    if (typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = scan(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const val of Object.values(v)) {
      const hit = scan(val, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  try {
    const nodes = definition?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      const hit = scan((n as any)?.parameters, 0);
      if (hit) return hit;
    }
  } catch { /* ignore */ }
  return null;
}
function validateDefinition(definition: any, opts: { requireTrigger?: boolean } = {}): string | null {
  if (!definition || typeof definition !== 'object') return 'definition must be an object';
  const nodes = (definition as any).nodes;
  if (nodes !== undefined) {
    if (!Array.isArray(nodes)) return 'definition.nodes must be an array';
    if (nodes.length > 50) return 'definition.nodes exceeds 50 nodes';
    const names = new Set<string>();
    for (const n of nodes) {
      if (!n || typeof n !== 'object') return 'definition.nodes[] must be objects';
      if (typeof (n as any).type !== 'string' || (n as any).type.length > 128) return 'definition.nodes[].type invalid';
      // m5: the engine keys everything off node names — nameless nodes
      // silently break routing, so require a name (same as console validateGraph).
      const nm = (n as any).name;
      if (typeof nm !== 'string' || !nm || nm.length > 128) {
        return `definition.nodes[].name must be a 1..128 char string (got '${String(nm).slice(0, 32)}')`;
      }
      if (names.has(nm)) return `duplicate node name '${nm}'`;
      names.add(nm);
      const params = (n as any).parameters;
      if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
        return `definition.nodes['${nm}'].parameters must be an object`;
      }
      if (isCodeType((n as any).type)) {
        const src = params?.code ?? params?.jsCode ?? params?.js;
        if (typeof src === 'string' && Buffer.byteLength(src, 'utf8') > 50 * 1024) {
          return `definition.nodes['${nm}'].code exceeds 50KB`;
        }
      }
      // M7: webhook trigger contract — path charset + method enum.
      if (isWebhookType((n as any).type) && params && typeof params === 'object') {
        if (params.path !== undefined && params.path !== null && String(params.path) !== '') {
          const wp = String(params.path).replace(/^\/+|\/+$/g, '');
          if (!wp || wp.length > 128 || !/^[A-Za-z0-9_.\/-]+$/.test(wp) || wp.split('/').includes('..')) {
            return `definition.nodes['${nm}'].webhook path invalid (1..128 chars, [A-Za-z0-9_.\\/ -], no '..'])`;
          }
        }
        if (params.httpMethod !== undefined && params.httpMethod !== null && String(params.httpMethod) !== '') {
          const m = String(params.httpMethod).toUpperCase();
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) {
            return `definition.nodes['${nm}'].webhook httpMethod invalid (GET|POST|PUT|PATCH|DELETE|HEAD)`;
          }
        }
        // P0-5: inbound hardening contract.
        if (params.auth !== undefined && params.auth !== null) {
          if (typeof params.auth !== 'object' || Array.isArray(params.auth)) {
            return `definition.nodes['${nm}'].webhook auth must be an object`;
          }
          const mode = (params.auth as any).mode;
          if (mode !== undefined && !['none', 'secret-header', 'hmac-sha256', 'jwt'].includes(String(mode))) {
            return `definition.nodes['${nm}'].webhook auth.mode invalid (none|secret-header|hmac-sha256|jwt)`;
          }
          if (String(mode) !== 'none' && mode !== undefined) {
            if (typeof (params.auth as any).credentialId !== 'string' || !(params.auth as any).credentialId) {
              return `definition.nodes['${nm}'].webhook auth.credentialId required when mode is '${mode}'`;
            }
          }
          if ((params.auth as any).header !== undefined && (typeof (params.auth as any).header !== 'string' || !/^[A-Za-z0-9-]+$/.test((params.auth as any).header) || (params.auth as any).header.length > 128)) {
            return `definition.nodes['${nm}'].webhook auth.header invalid`;
          }
        }
        if (params.rateLimit !== undefined && params.rateLimit !== null) {
          const rpm = Number((params.rateLimit as any)?.rpm);
          if (!Number.isFinite(rpm) || rpm < 1 || rpm > 60000) {
            return `definition.nodes['${nm}'].webhook rateLimit.rpm must be 1..60000`;
          }
        }
        if (params.idempotency !== undefined && params.idempotency !== null) {
          if (typeof params.idempotency !== 'object' || Array.isArray(params.idempotency)) {
            return `definition.nodes['${nm}'].webhook idempotency must be an object`;
          }
          if (typeof (params.idempotency as any).header !== 'string' || !/^[A-Za-z0-9-]+$/.test((params.idempotency as any).header)) {
            return `definition.nodes['${nm}'].webhook idempotency.header invalid`;
          }
          const ttl = Number((params.idempotency as any).ttlSeconds ?? 3600);
          if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86400) {
            return `definition.nodes['${nm}'].webhook idempotency.ttlSeconds must be 60..86400`;
          }
        }
      }
      // P1-16: httpRequest credential reference shape (secret itself lives
      // in /v1/credentials and is resolved server-side at run time).
      if (isHttpRequestType((n as any).type) && params && typeof params === 'object') {
        const auth = (params as any).auth;
        if (auth !== undefined && auth !== null) {
          if (typeof auth !== 'object' || Array.isArray(auth)) {
            return `definition.nodes['${nm}'].httpRequest auth must be an object`;
          }
          if (typeof (auth as any).credentialId !== 'string' || !(auth as any).credentialId) {
            return `definition.nodes['${nm}'].httpRequest auth.credentialId required`;
          }
        }
        if ((params as any).retry !== undefined && (params as any).retry !== null) {
          const rt = (params as any).retry;
          if (typeof rt !== 'object' || Array.isArray(rt)) {
            return `definition.nodes['${nm}'].retry must be an object`;
          }
          const a = Number((rt as any).attempts);
          if ((rt as any).attempts !== undefined && (!Number.isFinite(a) || a < 1 || a > 5)) {
            return `definition.nodes['${nm}'].retry.attempts must be 1..5`;
          }
        }
      }
      // First-party SynapseDX block: resource/operation must be known.
      if ((n as any).type === 'synapsedx.api' && params && typeof params === 'object') {
        const perr = validateSynapseDXParams(params);
        if (perr) return `definition.nodes['${nm}']: ${perr}`;
      }
      // Split per-service integration nodes (IAM/Base/Faststore/Queue/LDS/
      // Inference/Flow) — validate their operation + required input fields.
      if (isIntegrationType((n as any).type) && (n as any).type !== 'synapsedx.api' && params && typeof params === 'object') {
        const perr = validateIntegrationParams((n as any).type, params);
        if (perr) return `definition.nodes['${nm}']: ${perr}`;
      }
      // AI Agent: enabled tools + model parameters.
      if (isAiAgentType((n as any).type) && params && typeof params === 'object') {
        const terr = validateAgentToolIds((params as any).tools);
        if (terr) return `definition.nodes['${nm}']: ${terr}`;
        const maxSteps = Number((params as any).maxSteps);
        if ((params as any).maxSteps !== undefined && (!Number.isFinite(maxSteps) || maxSteps < 1 || maxSteps > 12)) {
          return `definition.nodes['${nm}']: maxSteps must be 1..12`;
        }
        const temp = Number((params as any).temperature);
        if ((params as any).temperature !== undefined && (!Number.isFinite(temp) || temp < 0 || temp > 2)) {
          return `definition.nodes['${nm}']: temperature must be 0..2`;
        }
      }
      // Decision Engine: at least one route, bounded fallback/threshold.
      if (isDecisionType((n as any).type) && params && typeof params === 'object') {
        const raw = (params as any).choices !== undefined ? (params as any).choices : (params as any).routes;
        let routes: string[] = [];
        if (Array.isArray(raw)) {
          routes = raw.map((r: any) => (r && typeof r === 'object' ? String(r.name ?? r.route ?? r.value ?? '') : String(r ?? ''))).filter(Boolean);
        } else if (raw && typeof raw === 'object') {
          routes = Object.keys(raw);
        }
        if (!routes.length) return `definition.nodes['${nm}']: decision needs at least one route (choices)`;
        if (routes.length > 20) return `definition.nodes['${nm}']: decision supports at most 20 routes`;
        if (new Set(routes).size !== routes.length) return `definition.nodes['${nm}']: decision route names must be unique`;
        const fb = Number((params as any).fallbackBranch);
        if ((params as any).fallbackBranch !== undefined && (!Number.isFinite(fb) || fb < 0 || fb >= routes.length)) {
          return `definition.nodes['${nm}']: fallbackBranch must be 0..${routes.length - 1}`;
        }
        const mc = Number((params as any).minConfidence);
        if ((params as any).minConfidence !== undefined && (!Number.isFinite(mc) || mc < 0 || mc > 1)) {
          return `definition.nodes['${nm}']: minConfidence must be 0..1`;
        }
      }
      // M8: reject schedules that would silently never fire.
      if (isCronType((n as any).type)) {
        const ce = validateCronParams(params || {});
        if (ce) return `definition.nodes['${nm}']: ${ce}`;
      }
    }
    // Cycle check (DAG only).
    try {
      const conns = (definition as any).connections || {};
      const cyc = detectCycle(nodes as any, conns as any);
      if (cyc) return cyc;
    } catch { /* ignore */ }
  }
  try {
    if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 200 * 1024) return 'definition exceeds 200KB';
  } catch { return 'definition is not JSON-serializable'; }
  const bad = findSsrfUrl(definition);
  if (bad) return `definition contains blocked internal URL (${String(bad).slice(0, 80)}) — use an allowlisted public endpoint`;
  // Structural edge checks — messages synced with console validateGraph.
  try {
    const nodesArr: any[] = Array.isArray((definition as any).nodes) ? (definition as any).nodes : [];
    const names = new Set(nodesArr.map((n: any) => (n as any)?.name).filter((x: any) => typeof x === 'string' && x));
    const byName = new Map(nodesArr.map((n: any) => [n?.name, n]));
    const routesOf = (p: any): string[] => {
      const raw = p?.choices !== undefined ? p.choices : p?.routes;
      if (Array.isArray(raw)) {
        return raw.map((r: any) => (r && typeof r === 'object' ? String(r.name ?? r.route ?? r.value ?? '') : String(r ?? ''))).filter(Boolean);
      }
      if (raw && typeof raw === 'object') return Object.keys(raw);
      return [];
    };
    const conns: any = (definition as any).connections || {};
    const touched = new Set<string>();
    const auxSources = new Set<string>();
    const modelTargets = new Map<string, number>();
    for (const [from, groups] of Object.entries(conns)) {
      if (!names.has(from)) return `connection from unknown node '${from}'`;
      const mains: any = (groups as any)?.main;
      if (mains !== undefined && !Array.isArray(mains)) return `connections['${from}'].main must be an array`;
      for (let bi = 0; bi < (mains || []).length; bi++) {
        const branch = mains[bi];
        for (const e of Array.isArray(branch) ? branch : []) {
          if (!e || typeof e !== 'object' || !names.has((e as any).node)) {
            return `connection from '${from}' points at unknown node '${(e as any)?.node}'`;
          }
          if ((e as any).node === from) return `self-loop on '${from}' is not allowed`;
          const port = edgeTargetPort(e as any);
          if (port) {
            const target = byName.get((e as any).node);
            if (!isAiAgentType((target as any)?.type)) {
              return `connection '${from}' -> '${(e as any).node}': ${port} socket can only target an AI Agent`;
            }
            auxSources.add(from);
            if (port === 'model') {
              if (!isModelType((byName.get(from) as any)?.type)) {
                return `connection '${from}' -> '${(e as any).node}': Model socket needs a Model Core source`;
              }
              modelTargets.set((e as any).node, (modelTargets.get((e as any).node) || 0) + 1);
            }
          } else {
            touched.add(from);
            touched.add((e as any).node);
            const src = byName.get(from);
            if (isIfType((src as any)?.type) && bi > 1) {
              return `if node '${from}' has only true/false outputs (branch ${bi} is invalid)`;
            }
            if (isDecisionType((src as any)?.type)) {
              const nRoutes = routesOf((src as any)?.parameters || {}).length;
              if (nRoutes && bi >= nRoutes) {
                return `decision node '${from}' has ${nRoutes} route(s) but an edge is on branch ${bi}`;
              }
            }
          }
        }
      }
    }
    for (const [agent, count] of modelTargets) {
      if (count > 1) return `AI Agent '${agent}' has more than one model source connected`;
    }
    if (nodesArr.length > 1) {
      for (const n of nodesArr) {
        const nm = (n as any)?.name;
        if (typeof nm === 'string' && nm && !touched.has(nm) && !auxSources.has(nm)) {
          return `dangling node '${nm}' has no connections`;
        }
      }
    }
  } catch { /* ignore */ }
  // A definition without any recognized trigger can never run — reject save
  // instead of producing an "active but dead" workflow that fires nothing.
  // (test-run sandboxes run trigger-less fragments, so it opts out.)
  if (opts.requireTrigger !== false) {
    const triggerless: any[] = Array.isArray((definition as any).nodes) ? (definition as any).nodes : [];
    if (
      triggerless.length &&
      !triggerless.some((n: any) => isTriggerType(String(n?.type)))
    ) {
      return 'definition needs at least one trigger node (webhook, cron or manualTrigger)';
    }
  }
  return null;
}

function toApiWorkflow(w: StoredWorkflow): any {
  return {
    id: w.id,
    name: w.name,
    active: w.active,
    nodes: w.nodes,
    connections: w.connections,
    settings: w.settings,
    orgId: w.org_id ?? undefined,
    accountId: w.account_id ?? undefined,
    owner: w.owner_sub ?? undefined,
    runAs: w.run_as ?? undefined,
    revision: w.revision ?? 1,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

/** Mask secret-looking values in execution payloads (P0-4): keys matching
 *  authorization/api-key/password/secret/token/cookie are replaced with ***.
 *  Applied at the API boundary so stored node I/O never leaks credentials
 *  to log viewers. Depth-capped, cycle-safe. */
const SECRET_KEY_RE = /^(authorization|.*api[-_]?key.*|.*password.*|.*secret.*|.*token.*|cookie|set-cookie|x-signature)$/i;
export function maskSecrets(v: any, depth = 0, seen: Set<any> = new Set()): any {
  if (depth > 6 || v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (seen.has(v)) return '[circular]';
  if (Array.isArray(v)) {
    seen.add(v);
    const out = v.map((item) => maskSecrets(item, depth + 1, seen));
    seen.delete(v);
    return out;
  }
  seen.add(v);
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = SECRET_KEY_RE.test(k) ? '***' : maskSecrets(val, depth + 1, seen);
  }
  seen.delete(v);
  return out;
}

function toApiExecution(e: any, includeData: boolean): any {
  const base: any = {
    id: e.id,
    workflowId: e.workflow_id,
    workflowName: e.workflow_name,
    status: e.status,
    mode: 'manual',
    triggeredBy: e.triggered_by,
    principal: e.principal ?? undefined,
    actor: e.actor ?? undefined,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    error: e.error,
    output: maskSecrets(e.output),
    input: includeData ? maskSecrets(e.input) : undefined,
  };
  if (includeData) {
    base.data = maskSecrets(e.node_runs);
    base.nodeRuns = maskSecrets(e.node_runs);
  }
  // Strip undefined for clean JSON.
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
}

/** Caller principal from gateway-stamped headers (P0-2). The gateway strips
 *  client-sent x-synapsedx-* and re-stamps from the verified identity, so
 *  these are trusted here. Direct calls carry no principal → anonymous. */
export function principalFromHeaders(req: express.Request): import('./store').Principal | null {
  const h = (n: string): string => {
    const v = req.headers[n];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);
  const user = h('x-synapsedx-user');
  if (user) {
    if (user.length > 128) return null;
    return {
      sub: user,
      org: clean(h('x-synapsedx-org')),
      account: clean(h('x-synapsedx-account')),
      kind: clean(h('x-synapsedx-kind')),
    };
  }
  // API keys are machine identities: the gateway stamps kind=apikey + account
  // but no user (keys carry no user claim). Without this fallback they would
  // look like an internal/direct call — workflow scoping would treat them as
  // tenant-free (global list, arbitrary tenant binding). Any tenant marker
  // means "authenticated principal"; synthesize a non-user subject.
  const kind = clean(h('x-synapsedx-kind'));
  const account = clean(h('x-synapsedx-account'));
  const org = clean(h('x-synapsedx-org'));
  if (kind || account || org) {
    return {
      sub: account ? `apikey:${account}` : `${kind || 'principal'}:unknown`,
      org,
      account,
      kind: kind || 'apikey',
    };
  }
  return null;
}

/** Principal for automated runs (webhook/cron): the workflow's stored run_as
 *  (else owner) bound to its tenant. Webhooks do NOT run as anonymous, so
 *  tenant-scoped first-party calls (e.g. SynapseLDS publish-record) keep
 *  working without weakening tenancy. */
export function workflowRunPrincipal(wf: {
  org_id?: string | null; account_id?: string | null; owner_sub?: string | null; run_as?: string | null;
}): import('./store').Principal | null {
  const sub = String(wf.run_as || '').trim() || String(wf.owner_sub || '').trim();
  if (!sub && !wf.org_id && !wf.account_id) return null;
  return { sub: sub || 'workflow', org: wf.org_id || undefined, account: wf.account_id || undefined, kind: 'workflow' };
}

export function createApp(): express.Express {
  if (IS_PROD_WF) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[workflow] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('[workflow] DATABASE_URL must be set in production (in-memory fallback would split-brain)');
    }
  }
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
  app.use(cors((() => {
    const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      if (!IS_PROD_WF) console.warn('[workflow][security] CORS_ORIGIN not set — allowing all origins (dev default).');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Echo/propagate x-request-id (see iam-service for rationale).
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({
    limit: '2mb',
    // Keep the raw body for HMAC webhook verification (P0-5).
    verify: (req: any, _res, buf) => { req.rawBody = buf; },
  }));

  // ---- inbound webhook hardening (P0-5): per-workflow auth, rate limit, idempotency ----
  // Node params contract (validated at save time):
  //   auth: { mode: none|secret-header|hmac-sha256|jwt, header?, credentialId? }
  //   rateLimit: { rpm } (default 600, 1..60000) · idempotency: { header, ttlSeconds }
  const webhookRate = new Map<string, { count: number; reset: number }>();
  const webhookDedupe = new Map<string, number>();
  function webhookNodeFor(wf: StoredWorkflow, clean: string): any | null {
    for (const n of wf.nodes || []) {
      if (!isWebhookType((n as any)?.type)) continue;
      if (String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '') === clean) return n;
    }
    return null;
  }
  function webhookAuthOf(node: any): { mode: string; header: string; credentialId?: string } {
    const a = (node as any)?.parameters?.auth;
    const mode = a && typeof a === 'object' && typeof a.mode === 'string' ? a.mode : 'none';
    const defaults: Record<string, string> = { 'secret-header': 'x-webhook-secret', 'hmac-sha256': 'x-signature', jwt: 'authorization' };
    const header = a && typeof a?.header === 'string' && a.header ? String(a.header).toLowerCase().slice(0, 128) : (defaults[mode] || '');
    const credentialId = a && typeof a?.credentialId === 'string' ? a.credentialId : undefined;
    return { mode, header, credentialId };
  }
  function verifyJwtHS256(token: string, secret: string, node: any): boolean {
    try {
      const t = token.startsWith('Bearer ') ? token.slice(7) : token;
      const parts = t.split('.');
      if (parts.length !== 3) return false;
      const crypto = require('crypto');
      const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url' as any);
      const a = Buffer.from(expected);
      const b = Buffer.from(parts[2]);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url' as any).toString('utf8'));
      const nowS = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === 'number' && nowS > payload.exp) return false;
      if (typeof payload.nbf === 'number' && nowS < payload.nbf) return false;
      const auth = (node as any)?.parameters?.auth || {};
      if (typeof auth.issuer === 'string' && auth.issuer && payload.iss !== auth.issuer) return false;
      if (typeof auth.audience === 'string' && auth.audience && payload.aud !== auth.audience) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Public inbound webhooks: ANY /webhook/:path triggers the active
  // workflow whose webhook node declares that path. No internal secret —
  // external systems call this (like any webhook). Per-workflow auth,
  // rate limiting and idempotency are enforced here (P0-5); the payload
  // is capped at 200KB.
  const handleInboundWebhook = async (req: express.Request, res: express.Response) => {
    try {
      const rawPath = String((req.params as any)?.path || req.path.replace(/^\/webhook\/?/, ''));
      const clean = rawPath.replace(/^\/+|\/+$/g, '').split('?')[0].slice(0, 128);
      if (!clean || /[\r\n]/.test(clean)) {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      const wf = await findActiveWebhookWorkflow(clean);
      if (!wf) {
        recordWebhookReject('not_found');
        return res.status(404).json({ error: 'webhook_not_found' });
      }
      const node = webhookNodeFor(wf, clean);
      const params = (node as any)?.parameters || {};
      // Rate limit (fixed window per workflow).
      const rpm = Math.min(Math.max(Number(params?.rateLimit?.rpm) || 600, 1), 60000);
      const nowMs = Date.now();
      const bucket = webhookRate.get(wf.id);
      if (!bucket || nowMs >= bucket.reset) webhookRate.set(wf.id, { count: 1, reset: nowMs + 60000 });
      else {
        bucket.count++;
        if (bucket.count > rpm) {
          recordWebhookReject('rate_limited');
          res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.reset - nowMs) / 1000)));
          return res.status(429).json({ error: 'rate_limited', message: `webhook exceeds ${rpm}/min` });
        }
      }
      // Auth.
      const auth = webhookAuthOf(node);
      if (auth.mode !== 'none') {
        let secret: string | null = null;
        if (auth.credentialId) {
          try {
            const rec = await getCredentialRec(auth.credentialId);
            if (rec) secret = decryptSecret(rec.secret_enc);
          } catch { /* fall through to misconfigured */ }
        }
        if (!secret) {
          recordWebhookReject('misconfigured');
          return res.status(500).json({ error: 'misconfigured', message: 'webhook auth misconfigured (unknown credential)' });
        }
        const got = String(req.headers[auth.header] || '');
        let ok = false;
        if (auth.mode === 'secret-header') {
          const a = Buffer.from(got);
          const b = Buffer.from(secret);
          ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
        } else if (auth.mode === 'hmac-sha256') {
          const crypto = require('crypto');
          const raw = ((req as any).rawBody as Buffer) || Buffer.from(JSON.stringify((req as any).body || ''));
          const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
          const norm = got.startsWith('sha256=') ? got.slice(7) : got;
          const a = Buffer.from(norm);
          const b = Buffer.from(expected);
          ok = norm.length > 0 && a.length === b.length && timingSafeEqual(a, b);
        } else if (auth.mode === 'jwt') {
          ok = verifyJwtHS256(got, secret, node);
        } else {
          recordWebhookReject('misconfigured');
          return res.status(500).json({ error: 'misconfigured', message: `unknown webhook auth mode '${auth.mode}'` });
        }
        if (!ok) {
          recordWebhookReject('unauthorized');
          return res.status(401).json({ error: 'unauthorized', message: 'invalid webhook credentials' });
        }
      }
      // Idempotency: replayed delivery keys within TTL are rejected (409).
      const idem = (params as any)?.idempotency;
      if (idem && typeof idem === 'object' && typeof idem.header === 'string' && idem.header) {
        const keyVal = String(req.headers[String(idem.header).toLowerCase()] || '');
        if (keyVal) {
          const ttlMs = Math.min(Math.max(Number(idem.ttlSeconds) || 3600, 60), 86400) * 1000;
          const dk = `${wf.id}:${keyVal.slice(0, 256)}`;
          const seenAt = webhookDedupe.get(dk);
          if (seenAt && nowMs - seenAt < ttlMs) {
            recordWebhookReject('duplicate');
            return res.status(409).json({ error: 'duplicate_delivery', message: 'delivery key already processed' });
          }
          webhookDedupe.set(dk, nowMs);
          if (webhookDedupe.size > 10000) {
            for (const [k, t] of webhookDedupe) {
              if (nowMs - t >= ttlMs) webhookDedupe.delete(k);
              if (webhookDedupe.size <= 8000) break;
            }
          }
        }
      }
      let input: any = {};
      if (req.method === 'GET' || req.method === 'HEAD') {
        input = { query: req.query || {} };
      } else {
        try {
          if (Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8') > 200 * 1024) {
            return res.status(413).json({ error: 'payload_too_large', message: 'webhook body ≤200KB' });
          }
        } catch { return res.status(400).json({ error: 'invalid_body' }); }
        input = (req.body && typeof req.body === 'object' ? req.body : { value: req.body }) || {};
        if (Object.keys(req.query || {}).length) (input as any)._query = req.query;
      }
      const startedAt = new Date().toISOString();
      const runPrincipal = workflowRunPrincipal(wf);
      const r = await runWorkflow(
        { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
        input,
        { triggeredBy: 'webhook', principal: runPrincipal, credentialResolver: makeCredentialResolver(runPrincipal), synapsedxCall },
      );
      const finishedAt = new Date().toISOString();
      recordRun('webhook', r.status, r.nodeRuns);
      const exec = await createExecutionRec({
        workflow_id: wf.id, workflow_name: wf.name, status: r.status,
        input, output: r.output, node_runs: r.nodeRuns as any,
        error: (r as any).error ?? null, triggered_by: 'webhook',
        principal: runPrincipal, actor: actorFor(wf.id, runPrincipal), startedAt, finishedAt,
      });
      res.status(r.status === 'success' ? 200 : 500).json({ ok: r.status === 'success', output: r.output, executionId: exec.id, error: (r as any).error ?? undefined });
    } catch (e: any) {
      console.error('[workflow] webhook failed:', e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  };
  app.all('/webhook/:path', handleInboundWebhook as any);
  app.all('/webhook/*', (async (req: express.Request, res: express.Response) => {
    (req.params as any) = { ...(req.params as any), path: String(req.path).replace(/^\/webhook\/?/, '') };
    return handleInboundWebhook(req, res);
  }) as any);

  // Defense-in-depth: workflow KHÔNG tin gateway mù quáng. Khi SYNAPSEDX_INTERNAL_SECRET
  // được set (cùng giá trị ở gateway), mọi /v1/* (trừ /health) phải mang header
  // x-synapsedx-internal khớp — chặn truy cập trực tiếp :4002 vượt mặt gateway.
  // Client KHÔNG bao giờ được gửi header này (gateway strip + set lại sau khi verify).
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[workflow][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production.');
  }
  app.use('/v1/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!INTERNAL_SECRET) {
      if (IS_PROD_WF) return res.status(500).json({ error: 'misconfigured', message: 'internal secret required in production' });
      return next();
    }
    const raw = req.headers['x-synapsedx-internal'] as string | string[] | undefined;
    const got = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
    // Constant-time compare to avoid leaking secret prefix via timing.
    const a = Buffer.from(got);
    const b = Buffer.from(INTERNAL_SECRET);
    const ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
    next();
  }) as any);

  // Bọc async handler (Express 4 không catch async throw).
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

  app.get('/health', async (_req, res) => {
    let counts: any = {};
    try {
      const [wfs, execs] = await Promise.all([listWorkflowRecs(), listExecutionRecs({ limit: 1 })]);
      counts = { workflows: wfs.length };
      void execs;
    } catch { /* health never fails on db */ }
    res.json({ status: 'ok', service: 'workflow', version: VERSION, engine: 'local', db: useDb() ? 'postgres' : 'memory', selfAllowlist: selfAllowlist().length, ...counts, time: new Date().toISOString() });
  });

/** Path :id guard shared by the single-workflow routes (length + CRLF). */
function checkId(id: unknown): string | null {
  const s = String(id || '');
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function idGate(req: any, res: any): string | null {
  const id = checkId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'invalid_id' });
    return null;
  }
  return id;
}

function cleanTenantField(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

/** Resolve tenant binding for create/update (P0-3). Explicit body values
 *  must stay inside the caller's verified tenant (403 otherwise); anonymous
 *  callers (dev/tests/direct) may set them freely. Account-scoped callers
 *  (API keys) never carry a verified org, so an explicit `orgId` is refused
 *  instead of being trusted. */
function tenantBinding(
  req: any, body: any, cur?: StoredWorkflow,
): { ok: true; value: { org_id: string | null; account_id: string | null; run_as: string | null } } | { ok: false; status: number; error: string; message: string } {
  const p = principalFromHeaders(req);
  const read = (key: string): { ok: true; value: string | null } | { ok: false } => {
    const raw = (body || {})[key];
    if (raw === undefined || raw === null || String(raw) === '') return { ok: true, value: null };
    const c = cleanTenantField(raw);
    return c === null ? { ok: false } : { ok: true, value: c };
  };
  const orgBody = read('orgId');
  if (!orgBody.ok) return { ok: false, status: 400, error: 'invalid_tenant', message: 'orgId must be 1..128 chars' };
  const accBody = read('accountId');
  if (!accBody.ok) return { ok: false, status: 400, error: 'invalid_tenant', message: 'accountId must be 1..128 chars' };
  const runAsBody = read('runAs');
  if (!runAsBody.ok) return { ok: false, status: 400, error: 'invalid_tenant', message: 'runAs must be 1..128 chars' };

  if (p?.org && orgBody.value && orgBody.value !== p.org) {
    return { ok: false, status: 403, error: 'cross_tenant', message: 'cannot bind a workflow outside your own org' };
  }
  if (p && !p.org && orgBody.value) {
    return { ok: false, status: 403, error: 'cross_tenant', message: 'account-scoped callers cannot bind an org' };
  }
  if (p?.account && accBody.value && accBody.value !== p.account) {
    return { ok: false, status: 403, error: 'cross_tenant', message: 'cannot bind a workflow outside your own account' };
  }

  const org_id = orgBody.value ?? p?.org ?? cur?.org_id ?? null;
  const account_id = accBody.value ?? p?.account ?? cur?.account_id ?? null;
  const run_as = runAsBody.value ?? cur?.run_as ?? null;
  return { ok: true, value: { org_id, account_id, run_as } };
}

  // List workflows. Authenticated callers see only their own tenant slice
  // (org-bound rows for users, account-bound rows for machine identities;
  // legacy tenant-free rows stay dev-only). Explicit ?orgId=/accountId=
  // filters must stay inside the caller's own tenant (403 otherwise).
  // Anonymous direct calls keep the legacy global view (dev/tests).
  app.get('/v1/workflows', async (req, res) => {
    const p = principalFromHeaders(req);
    const q = req.query as any;
    const orgQ = typeof q.orgId === 'string' && q.orgId ? q.orgId.slice(0, 128) : undefined;
    const acctQ = typeof q.accountId === 'string' && q.accountId ? q.accountId.slice(0, 128) : undefined;
    if (p) {
      if (orgQ && (!p.org || orgQ !== p.org)) {
        return res.status(403).json({ error: 'forbidden', message: 'orgId is outside your own org' });
      }
      if (acctQ && (!p.account || acctQ !== p.account)) {
        return res.status(403).json({ error: 'forbidden', message: 'accountId is outside your own account' });
      }
      if (!p.org && !p.account) {
        return res.status(403).json({ error: 'forbidden', message: 'caller has no tenant scope' });
      }
      const all = await listWorkflowRecs();
      // Optional narrowing: when a user JWT (no account claim) filters by
      // accountId, keep the org condition too so foreign accounts stay hidden.
      const visible = all.filter((w) => {
        if (!canAccessWorkflow(w, p)) return false;
        if (orgQ && w.org_id !== orgQ) return false;
        if (acctQ && w.account_id !== acctQ) return false;
        return true;
      });
      res.json(visible.map(toApiWorkflow));
      return;
    }
    if (orgQ || acctQ) {
      const all = await listWorkflowRecs({ ...(orgQ ? { orgId: orgQ } : {}), ...(acctQ ? { accountId: acctQ } : {}) });
      res.json(all.map(toApiWorkflow));
      return;
    }
    const all = await listWorkflowRecs();
    res.json(all.map(toApiWorkflow));
  });

  // Get one workflow
  app.get('/v1/workflows/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const w = await getWorkflowRec(id);
    if (!w || !canAccessWorkflow(w, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    res.json(toApiWorkflow(w));
  });

  // Create workflow from template or raw definition
  app.post('/v1/workflows', async (req, res) => {
    const { name, definition, template, settings } = (req.body || {}) as any;
    // null ≡ absent for optional fields (SDKs serialize missing values as null).
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
    }
    if (template != null && (typeof template !== 'string' || !/^[a-z0-9-]{1,64}$/.test(template))) {
      return res.status(400).json({ error: 'invalid_template', message: 'unknown template (see GET /v1/templates)' });
    }
    if (template != null && definition != null) {
      return res.status(400).json({ error: 'ambiguous_source', message: 'pass either template or definition, not both' });
    }
    const fromTemplate = Boolean(template && !definition);
    let payload: any = definition;
    if (fromTemplate) {
      payload = buildTemplate(template, (name as string) || template);
      if (!payload) return res.status(400).json({ error: 'unknown_template', available: listTemplates().map((t) => t.name) });
      // Template webhook paths must not collide: two active workflows sharing
      // a path makes /webhook/:path routing ambiguous. Suffix -2, -3, ….
      try {
        const hookIdx = (payload.nodes || []).findIndex((n: any) => isWebhookType((n as any)?.type));
        if (hookIdx >= 0) {
          const basePath = String(payload.nodes[hookIdx]?.parameters?.path || 'hook').replace(/^\/+|\/+$/g, '') || 'hook';
          const existing = new Set<string>();
          for (const w of await listWorkflowRecs()) {
            for (const n of (w.nodes || []) as any[]) {
              if (isWebhookType((n as any)?.type)) {
                const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
                if (p) existing.add(p);
              }
            }
          }
          let cand = basePath;
          for (let i = 2; existing.has(cand); i++) cand = `${basePath}-${i}`;
          payload.nodes[hookIdx] = {
            ...payload.nodes[hookIdx],
            parameters: { ...(payload.nodes[hookIdx]?.parameters || {}), path: cand },
          };
        }
      } catch { /* uniquify is best-effort */ }
    }
    if (!payload) return res.status(400).json({ error: 'definition or template required' });
    normalizeDecisionChoices(payload);
    // Built-in templates are trusted (fixed code); custom definitions get full validation.
    const defErr = fromTemplate ? null : validateDefinition(payload);
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    let settingsOut: Record<string, any> = {};
    // m10: explicit top-level settings win; definition.settings carries over
    // (e.g. Duplicate) when no top-level value is given.
    const settingsCand = settings ?? (payload as any).settings;
    if (settingsCand !== undefined && settingsCand !== null) {
      if (typeof settingsCand !== 'object' || Array.isArray(settingsCand)) {
        return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
      }
      try {
        if (Buffer.byteLength(JSON.stringify(settingsCand), 'utf8') > 8 * 1024) {
          return res.status(400).json({ error: 'invalid_settings', message: 'settings ≤8KB' });
        }
      } catch { return res.status(400).json({ error: 'invalid_settings', message: 'settings must be JSON-serializable' }); }
      settingsOut = settingsCand;
    }
    // P0-3: tenant binding — explicit body org/account must stay inside the
    // caller's own org; otherwise inherit from the stamped principal.
    const tenant = tenantBinding(req, req.body || {});
    if (!tenant.ok) return res.status(tenant.status).json({ error: tenant.error, message: tenant.message });
    const w = await createWorkflowRec({
      name: String(name || payload.name || 'synapsedx-workflow').slice(0, 200),
      nodes: payload.nodes || [],
      connections: payload.connections || {},
      settings: settingsOut,
      ...tenant.value,
      owner_sub: principalFromHeaders(req)?.sub ?? null,
    });
    res.status(201).json(toApiWorkflow(w));
  });

  // Update workflow name and/or definition.
  app.put('/v1/workflows/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { name, definition, settings, orgId, accountId, runAs } = (req.body || {}) as any;
    if (name == null && definition == null && settings == null && orgId == null && accountId == null && runAs == null) {
      return res.status(400).json({ error: 'invalid_body', message: 'name and/or definition and/or settings and/or tenant fields required' });
    }
    if (name != null && (typeof name !== 'string' || name.length === 0 || name.length > 200)) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..200 chars' });
    }
    if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) {
      return res.status(400).json({ error: 'invalid_settings', message: 'settings must be an object' });
    }
    const cur = await getWorkflowRec(id);
    if (!cur || !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    let nodes = cur.nodes;
    let connections = cur.connections;
    if (definition != null) {
      normalizeDecisionChoices(definition);
      const defErr = validateDefinition(definition);
      if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
      nodes = (definition as any).nodes || [];
      connections = (definition as any).connections || {};
      // A `settings` key inside `definition`, if any, is intentionally ignored.
    }
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify({ nodes, connections }), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (size > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'definition ≤200KB' });
    const tenant = tenantBinding(req, req.body || {}, cur);
    if (!tenant.ok) return res.status(tenant.status).json({ error: tenant.error, message: tenant.message });
    const updated = await updateWorkflowRec(id, {
      ...(name != null ? { name } : {}),
      ...(settings != null ? { settings } : {}),
      ...tenant.value,
      nodes, connections,
    });
    res.json(toApiWorkflow(updated!));
  });

  // Execute workflow: run the local DAG immediately with the given input.
  // Unlike the old n8n proxy (webhook-only + must be active), manual execute
  // via the authenticated API works for ANY trigger type and regardless of
  // the active flag — activating only gates cron + public /webhook/*.
  // This fixes cron/manual workflows being un-runnable from the Console.
  app.post('/v1/workflows/:id/execute', async (req, res) => {
    const id = String(req.params.id || '');
    if (!id || id.length > 128 || /[\r\n]/.test(id)) return res.status(400).json({ error: 'invalid_id' });
    let bodySize = 0;
    try { bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (bodySize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'execute body ≤200KB' });
    const wf = await getWorkflowRec(id);
    const principal = principalFromHeaders(req);
    if (!wf || !canAccessWorkflow(wf, principal)) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    const input = (req.body && typeof req.body === 'object' ? req.body : { value: req.body }) || {};
    const startedAt = new Date().toISOString();
    const r = await runWorkflow(
      { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
      input,
      { triggeredBy: 'manual', principal, credentialResolver: makeCredentialResolver(principal), synapsedxCall },
    );
    const finishedAt = new Date().toISOString();
    recordRun('manual', r.status, r.nodeRuns);
    const exec = await createExecutionRec({
      workflow_id: wf.id, workflow_name: wf.name, status: r.status,
      input, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'manual',
      principal, actor: actorFor(wf.id, principal), startedAt, finishedAt,
    });
    res.status(r.status === 'success' ? 200 : 500).json({
      ok: r.status === 'success',
      output: r.output,
      executionId: exec.id,
      status: r.status,
      ...(r.status === 'error' ? { error: (r as any).error } : {}),
    });
  });

  // Activate / deactivate
  app.post('/v1/workflows/:id/activate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (!cur || !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    // Re-validate the stored definition: schedules that never fire and
    // webhook misconfigurations must fail loudly here, not silently.
    const defErr = validateDefinition({ nodes: cur.nodes, connections: cur.connections });
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    // M7: two active workflows sharing a webhook path make /webhook/:path
    // routing ambiguous — refuse with 409 so the clash is explicit.
    try {
      const trig = findWebhookTrigger({ nodes: cur.nodes });
      if (trig) {
        const all = await listWorkflowRecs();
        const clash = all.find((w) => {
          if (w.id === id || !w.active) return false;
          return (w.nodes || []).some((n: any) => {
            if (!isWebhookType((n as any)?.type)) return false;
            return String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '') === trig.path;
          });
        });
        if (clash) {
          return res.status(409).json({
            error: 'webhook_path_conflict',
            message: `webhook path '${trig.path}' already serves active workflow '${clash.name}' (${clash.id}) — change the path or deactivate it first`,
          });
        }
      }
    } catch { /* conflict scan is best-effort */ }
    const w = await updateWorkflowRec(id, { active: true });
    if (!w) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json(toApiWorkflow(w));
  });

  app.post('/v1/workflows/:id/deactivate', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (cur && !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    const w = await updateWorkflowRec(id, { active: false });
    if (!w) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json(toApiWorkflow(w));
  });

  // Executions list. Same allowlist contract as before.
  app.get('/v1/executions', async (req, res) => {
    const q = req.query as any;
    let limit = 20;
    let offset = 0;
    if (q.limit !== undefined) {
      if (typeof q.limit !== 'string' || !/^\d{1,4}$/.test(q.limit)) {
        return res.status(400).json({ error: 'invalid_query', message: 'limit must be a 0..9999 integer' });
      }
      limit = Math.min(Number(q.limit), 100) || 20;
    }
    if (q.offset !== undefined) {
      if (typeof q.offset !== 'string' || !/^\d{1,4}$/.test(q.offset)) {
        return res.status(400).json({ error: 'invalid_query', message: 'offset must be a 0..9999 integer' });
      }
      // offset=0 (any spelling) means first page.
      offset = Number(q.offset) === 0 ? 0 : Number(q.offset);
    }
    const workflowId = typeof q.workflowId === 'string' && q.workflowId.length <= 256 ? q.workflowId : undefined;
    if (workflowId && /[\r\n]/.test(workflowId)) return res.status(400).json({ error: 'invalid_query', message: 'bad workflowId' });
    const status = typeof q.status === 'string' && q.status.length <= 32 ? q.status : undefined;
    if (status && !['success', 'error', 'running'].includes(status)) {
      return res.status(400).json({ error: 'invalid_query', message: 'status must be success|error|running' });
    }
    // M10: test runs persist server-side — filterable so history views can
    // include or exclude them (triggeredBy=manual|webhook|cron|test).
    const triggeredBy = typeof q.triggeredBy === 'string' && q.triggeredBy.length <= 32 ? q.triggeredBy : undefined;
    if (triggeredBy && !['manual', 'webhook', 'cron', 'test'].includes(triggeredBy)) {
      return res.status(400).json({ error: 'invalid_query', message: 'triggeredBy must be manual|webhook|cron|test' });
    }
    const includeData = q.includeData === 'true';
    const principal = principalFromHeaders(req);
    const scope = executionScope(principal);
    if (!scope) return res.status(403).json({ error: 'forbidden', message: 'caller has no tenant scope' });
    const { items } = await listExecutionRecs({ workflowId, status, triggeredBy, limit, offset, ...scope });
    const mapped = items.map((e) => toApiExecution(e, includeData));
    // Console accepts both a raw array and {data: []} — return the envelope
    // with data for forward-compat (n8n proxied {data} before).
    res.json({ data: mapped });
  });

  // Get one execution.
  app.get('/v1/executions/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const e = await getExecutionRec(id);
    if (!e || !canAccessExecution(e, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'execution not found' });
    }
    const includeData = (req.query as any).includeData === 'true';
    res.json(toApiExecution(e, includeData));
  });

  // Delete a workflow.
  app.delete('/v1/workflows/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getWorkflowRec(id);
    if (cur && !canAccessWorkflow(cur, principalFromHeaders(req))) {
      return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    }
    const ok = await deleteWorkflowRec(id);
    if (!ok) return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
    res.json({ ok: true, id });
  });

  // ---------- credentials (P0-4): account-scoped secrets, encrypted at rest ----------
  // Nodes store only credentialIds; secrets are resolved server-side at run
  // time and never appear in nodeRuns, params or list responses. Credentials
  // are additionally org-bound (#5): org callers can only list/create/delete
  // credentials of their own org, and resolvers refuse foreign-org secrets.
  function credentialAccountScope(req: any, accountId: string): { ok: boolean; status?: number; error?: string; message?: string; orgId?: string | null } {
    const p = principalFromHeaders(req);
    if (!p) return { ok: true, orgId: null }; // anonymous direct calls (dev/tests)
    if (p.account) {
      if (p.account !== accountId) {
        return { ok: false, status: 403, error: 'cross_account', message: 'credential account is outside your own account' };
      }
      return { ok: true, orgId: null };
    }
    if (!p.org) {
      return { ok: false, status: 403, error: 'forbidden', message: 'caller has no tenant scope' };
    }
    return { ok: true, orgId: p.org };
  }

  app.get('/v1/credentials', async (req, res) => {
    const q = req.query as any;
    const p = principalFromHeaders(req);
    if (typeof q.accountId === 'string' && q.accountId.length > 128) {
      return res.status(400).json({ error: 'invalid_account', message: 'accountId must be 1..128 chars' });
    }
    const accountId = typeof q.accountId === 'string' ? q.accountId : p?.account;
    if (accountId) {
      const scope = credentialAccountScope(req, accountId);
      if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
      const items = await listCredentialRecs(accountId, scope.orgId ?? undefined);
      return res.json({ data: items.map(toPublicCredential) });
    }
    // No account scope: anonymous dev view only (never secret material).
    if (p) {
      return res.status(400).json({ error: 'account_required', message: 'pass ?accountId= (credentials are account-scoped)' });
    }
    const items = await listCredentialRecs();
    res.json({ data: items.map(toPublicCredential) });
  });

  app.post('/v1/credentials', async (req, res) => {
    const { accountId, name, kind, secret } = (req.body || {}) as any;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\r\n]/.test(accountId)) {
      return res.status(400).json({ error: 'invalid_account', message: 'accountId must be 1..128 chars' });
    }
    const scope = credentialAccountScope(req, accountId);
    if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
    if (typeof name !== 'string' || !name || name.length > 100) {
      return res.status(400).json({ error: 'invalid_name', message: 'name must be 1..100 chars' });
    }
    if (!['bearer', 'api-key', 'basic', 'hmac'].includes(kind)) {
      return res.status(400).json({ error: 'invalid_kind', message: 'kind must be bearer|api-key|basic|hmac' });
    }
    if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret, 'utf8') > 8 * 1024) {
      return res.status(400).json({ error: 'invalid_secret', message: 'secret must be 1..8KB' });
    }
    if (kind === 'basic') {
      try {
        const parsed = JSON.parse(secret);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as any).password !== 'string') {
          return res.status(400).json({ error: 'invalid_secret', message: 'basic secret must be JSON {username, password}' });
        }
      } catch {
        return res.status(400).json({ error: 'invalid_secret', message: 'basic secret must be JSON {username, password}' });
      }
    }
    try {
      const c = await createCredentialRec({ account_id: accountId, org_id: scope.orgId ?? null, name, kind, secret });
      res.status(201).json(toPublicCredential(c));
    } catch (e: any) {
      if ((e as any)?.code === 'conflict') return res.status(409).json({ error: 'conflict', message: (e as any).message });
      throw e;
    }
  });

  app.delete('/v1/credentials/:id', async (req, res) => {
    const id = idGate(req, res);
    if (id === null) return;
    const cur = await getCredentialRec(id);
    if (!cur) return res.status(404).json({ error: 'not_found', message: 'credential not found' });
    const scope = credentialAccountScope(req, cur.account_id);
    if (!scope.ok) return res.status(scope.status!).json({ error: scope.error, message: scope.message });
    // Org-scoped callers may only manage credentials actually bound to their
    // org — legacy/anonymous credentials of unknown tenancy are off-limits.
    if (scope.orgId) {
      if (!cur.org_id || cur.org_id !== scope.orgId) {
        return res.status(403).json({ error: 'cross_tenant', message: 'credential is outside your own org' });
      }
    }
    await deleteCredentialRec(id);
    res.json({ ok: true, id });
  });

  // ---------- /metrics (P2): Prometheus exposition ----------
  app.get('/metrics', async (_req, res) => {
    const lines = [
      '# HELP synapsedx_workflow_runs_total Workflow executions by trigger and status.',
      '# TYPE synapsedx_workflow_runs_total counter',
      ...[...metricRuns.entries()].map(([k, v]) => {
        const [triggeredBy, status] = k.split('|');
        return `synapsedx_workflow_runs_total{triggered_by="${triggeredBy}",status="${status}"} ${v}`;
      }),
      '# HELP synapsedx_workflow_webhook_rejected_total Rejected inbound webhook calls by reason.',
      '# TYPE synapsedx_workflow_webhook_rejected_total counter',
      ...[...metricWebhookRejected.entries()].map(([reason, v]) => `synapsedx_workflow_webhook_rejected_total{reason="${reason}"} ${v}`),
    ];
    res.type('text/plain').send(`${lines.join('\n')}\n`);
  });

  // Test-run a definition without saving (validates + executes in sandbox).
  // Powers the editor's "try code/set/if" before Save. Persists as a
  // triggered_by=test execution — pass { workflowId } of a saved workflow
  // to attach it to that workflow's history, otherwise it lands under a
  // synthetic test-* id (visible in unfiltered /v1/executions).
  app.post('/v1/workflows/test-run', async (req, res) => {
    const { definition, input, workflowId } = (req.body || {}) as any;
    if (!definition) return res.status(400).json({ error: 'definition required' });
    // Sandbox fragments may omit trigger nodes (editor "try node without a graph").
    const defErr = validateDefinition(definition, { requireTrigger: false });
    if (defErr) return res.status(400).json({ error: 'invalid_definition', message: defErr });
    let inSize = 0;
    try { inSize = Buffer.byteLength(JSON.stringify(input ?? {}), 'utf8'); } catch { return res.status(400).json({ error: 'invalid_body' }); }
    if (inSize > 200 * 1024) return res.status(400).json({ error: 'payload_too_large', message: 'input ≤200KB' });
    let attach: StoredWorkflow | null = null;
    if (workflowId !== undefined && workflowId !== null && workflowId !== '') {
      if (typeof workflowId !== 'string' || workflowId.length > 128 || /[\r\n]/.test(workflowId)) {
        return res.status(400).json({ error: 'invalid_workflow_id' });
      }
      attach = await getWorkflowRec(workflowId);
      if (!attach || !canAccessWorkflow(attach, principalFromHeaders(req))) {
        return res.status(404).json({ error: 'not_found', message: 'workflow not found' });
      }
    }
    const principal = principalFromHeaders(req);
    const startedAt = new Date().toISOString();
    const r = await runWorkflow(definition, input ?? {}, { triggeredBy: 'test', principal, credentialResolver: makeCredentialResolver(principal), synapsedxCall });
    const finishedAt = new Date().toISOString();
    recordRun('test', r.status, r.nodeRuns);
    const wfId = attach ? attach.id : `test-${randomUUID().slice(0, 8)}`;
    const exec = await createExecutionRec({
      workflow_id: wfId, workflow_name: attach ? attach.name : 'test-run', status: r.status,
      input: input ?? {}, output: r.output, node_runs: r.nodeRuns as any,
      error: (r as any).error ?? null, triggered_by: 'test',
      principal, actor: actorFor(wfId, principal), startedAt, finishedAt,
    });
    res.status(r.status === 'success' ? 200 : 500).json({
      ok: r.status === 'success', output: r.output, nodeRuns: r.nodeRuns,
      executionId: exec.id, error: (r as any).error ?? undefined,
    });
  });

  // Built-in templates (versioned JSON)
  app.get('/v1/templates', (_req, res) => res.json(listTemplates()));
  app.get('/v1/templates/:name', (req, res) => {
    const t = buildTemplate(req.params.name, req.params.name);
    if (!t) return res.status(404).json({ error: 'template_not_found' });
    res.json(t);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[workflow] unhandled:', err?.message || err);
    if (res.headersSent) return;
    // Malformed JSON body: 400, not 500.
    if (err?.status === 400 || err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && /JSON/i.test(err.message))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err?.status === 413 || err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

export function listTemplates() {
  return [
    { name: 'webhook-to-log', description: 'Webhook receives a gateway event -> writes a log -> replies 200' },
    { name: 'cron-etl', description: 'Nightly cron -> fetches API health -> transforms -> logs' },
    { name: 'iam-webhook', description: 'Receives IAM events (user.created) -> calls back into the API' },
    { name: 'code-transform', description: 'Webhook -> sandboxed JS transform -> conditional branch -> set fields' },
    { name: 'manual-starter', description: 'Manual trigger -> code transform -> set fields (click Execute to try)' },
    { name: 'synapsedx-self-check', description: 'Manual -> SynapseDX API (list orgs) -> count -> summary (first-party integration demo)' },
    { name: 'webhook-to-lds', description: 'Webhook -> SynapseLDS: publish the payload as an NGSI-LD record (payload carries datasourceId)' },
    { name: 'github-push-to-log', description: 'GitHub push webhook (HMAC verified) -> normalize commits -> summary' },
    { name: 'ai-triage-ops', description: 'AI triage showcase: webhook -> Decision (4 routes) -> 3 AI Agents with canvas Tools/Model sockets + Base/Faststore/IAM/HTTP tools -> aggregate -> escalation queue' },
    { name: 'customer-360-orchestrator', description: 'Customer 360 showcase: webhook -> Decision (4 routes) -> AI SRE agent + canvas Tools/Model sockets -> Base/Faststore/IAM/LDS/Queue/Flow integrations -> fan-out/fan-in -> risk gate' },
    { name: 'vector-rag-orchestrator', description: 'Enterprise RAG triage: webhook -> Base vector search -> Decision (multi-route) -> AI Agent with vector tools -> Faststore cache -> Queue escalation' },
  ];
}

export { isBlockedUrl, validateDefinition, findSsrfUrl };

/** Webhook trigger of a workflow: validated path + declared HTTP method. */
export interface WebhookTrigger {
  path: string;
  method: string;
}

export function findWebhookTrigger(workflow: any): WebhookTrigger | null {
  try {
    const nodes = workflow?.nodes;
    if (!Array.isArray(nodes)) return null;
    for (const n of nodes) {
      if (!isWebhookType((n as any)?.type)) continue;
      const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
      if (!p || p.length > 128) continue;
      if (!/^[A-Za-z0-9_.\/-]+$/.test(p)) continue;
      if (p.split('/').includes('..')) continue;
      const raw = String((n as any)?.parameters?.httpMethod || 'POST').toUpperCase();
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(raw) ? raw : 'POST';
      return { path: p, method };
    }
  } catch { /* ignore */ }
  return null;
}

/** First webhook trigger path of a workflow definition, or null. */
export function findWebhookPath(workflow: any): string | null {
  return findWebhookTrigger(workflow)?.path || null;
}

/** Decide routes are positional (main[0..n]); PostgreSQL JSONB does not
 *  preserve object key order. Normalize legacy object maps to ordered arrays
 *  at save time so a Decision node keeps its route/branch contract. */
export function normalizeDecisionChoices(definition: any): any {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  for (const n of nodes) {
    if (!isDecisionType(n?.type)) continue;
    const p = n?.parameters;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    for (const key of ['choices', 'routes'] as const) {
      const raw = (p as any)[key];
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        (p as any)[key] = Object.entries(raw).map(([name, description]) => ({
          name,
          description: String(description ?? name),
        }));
      }
    }
  }
  return definition;
}

export function buildTemplate(name: string, workflowName?: string): any | null {
  const wname = workflowName || name;
  const wid = () => (globalThis.crypto as any)?.randomUUID?.() || Math.random().toString(36).slice(2);
  if (name === 'webhook-to-log') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'synapsedx-event', httpMethod: 'POST' } },
        { id: wid(), name: 'Log', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 300], parameters: {} },
      ],
      connections: { Webhook: { main: [[{ node: 'Log', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'cron-etl') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Cron', type: 'n8n-nodes-base.cron', typeVersion: 1, position: [200, 300], parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } } },
        { id: wid(), name: 'FetchAPI', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 300], parameters: { url: 'https://api.example.com/health', method: 'GET' } },
      ],
      connections: { Cron: { main: [[{ node: 'FetchAPI', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'iam-webhook') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'IAMEvent', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'iam-event', httpMethod: 'POST' } },
        { id: wid(), name: 'CallAPI', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [420, 300], parameters: { url: 'https://api.example.com/v1/orgs', method: 'GET' } },
      ],
      connections: { IAMEvent: { main: [[{ node: 'CallAPI', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'code-transform') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'transform', httpMethod: 'POST' } },
        { id: wid(), name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' } },
        { id: wid(), name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 1, position: [600, 300], parameters: { condition: '$input.doubled > 10' } },
        { id: wid(), name: 'Big', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 220], parameters: { values: { tag: 'big' } } },
        { id: wid(), name: 'Small', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 380], parameters: { values: { tag: 'small' } } },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
        Transform: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
        // if: main[0] = true branch, main[1] = false branch
        Check: { main: [[{ node: 'Big', type: 'main', index: 0 }], [{ node: 'Small', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'manual-starter') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        { id: wid(), name: 'Transform', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' } },
        { id: wid(), name: 'Tag', type: 'n8n-nodes-base.set', typeVersion: 1, position: [600, 300], parameters: { values: { tag: 'processed' } } },
      ],
      connections: {
        Manual: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] },
        Transform: { main: [[{ node: 'Tag', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'synapsedx-self-check') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [200, 300], parameters: {} },
        { id: wid(), name: 'GetOrgs', type: 'synapsedx.api', typeVersion: 1, position: [400, 300], parameters: { resource: 'orgs', operation: 'list', input: {} } },
        { id: wid(), name: 'Count', type: 'n8n-nodes-base.code', typeVersion: 1, position: [600, 300], parameters: { code: 'const list = Array.isArray($input) ? $input : []; return { count: list.length, at: $now };' } },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.set', typeVersion: 1, position: [800, 300], parameters: { values: { checked: true } } },
      ],
      connections: {
        Manual: { main: [[{ node: 'GetOrgs', type: 'main', index: 0 }]] },
        GetOrgs: { main: [[{ node: 'Count', type: 'main', index: 0 }]] },
        Count: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'webhook-to-lds') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'lds-publish', httpMethod: 'POST' } },
        { id: wid(), name: 'PublishToLDS', type: 'synapsedx.api', typeVersion: 1, position: [440, 300], parameters: { resource: 'lds', operation: 'publish-record', input: { datasourceId: '={{ $json.datasourceId }}', record: '={{ $json }}' } } },
        { id: wid(), name: 'Done', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [680, 300], parameters: {} },
      ],
      connections: {
        Webhook: { main: [[{ node: 'PublishToLDS', type: 'main', index: 0 }]] },
        PublishToLDS: { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'github-push-to-log') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'GitHubPush', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'github-push', httpMethod: 'POST', auth: { mode: 'hmac-sha256', header: 'x-hub-signature-256' } } },
        { id: wid(), name: 'Normalize', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 300], parameters: { code: 'const p = $input || {}; const commits = Array.isArray(p.commits) ? p.commits : []; return { repo: p.repository?.full_name || null, ref: p.ref || null, pusher: p.pusher?.name || null, count: commits.length, messages: commits.slice(0, 10).map((c) => c.message) };' } },
        { id: wid(), name: 'Summary', type: 'n8n-nodes-base.set', typeVersion: 1, position: [600, 300], parameters: { values: { source: 'github' } } },
      ],
      connections: {
        GitHubPush: { main: [[{ node: 'Normalize', type: 'main', index: 0 }]] },
        Normalize: { main: [[{ node: 'Summary', type: 'main', index: 0 }]] },
      },
    };
  }
  if (name === 'customer-360-orchestrator') {
    const node = (n: string, type: string, x: number, y: number, parameters: any = {}) => ({
      id: wid(), name: n, type, typeVersion: 1, position: [x, y], parameters,
    });
    const edge = (target: string) => ({ node: target, type: 'main', index: 0 });
    const tool = (target: string) => ({ node: target, type: 'tools', index: 0, targetPort: 'tools' });
    const model = (target: string) => ({ node: target, type: 'model', index: 0, targetPort: 'model' });
    return {
      name: wname,
      settings: { onError: 'continue', timeoutMs: 300000 },
      nodes: [
        { ...node('Intake', 'n8n-nodes-base.webhook', 80, 480, { path: 'customer-360-demo', httpMethod: 'POST' }), webhookId: wid() },
        node('Normalize', 'n8n-nodes-base.code', 320, 480, {
          code:
            'const p = $input || {};' +
            'const query = String(p.query || p.message || p.intent || "customer health review").trim();' +
            'const amount = Number(p.amount || p.mrr || 0);' +
            'const tier = String(p.tier || "standard");' +
            'const urgent = /(urgent|asap|down|outage|production|critical)/i.test(query);' +
            'const eventId = p.eventId || ("evt-" + Date.now());' +
            'const customerId = p.customerId || "demo-customer";' +
            'const riskScore = Math.min(100, Math.round(amount / 100 + (tier === "enterprise" ? 25 : 0) + (urgent ? 30 : 0)));' +
            'return { ...p, query, amount, tier, customerId, eventId, priority: p.priority || (urgent ? "urgent" : "normal"), riskScore, receivedAt: $now };',
        }),
        node('Route', 'synapseflow.decision', 580, 480, {
          input: '={{ $json.query }}',
          choices: [
            { name: 'billing', description: 'billing, invoice, refund, charge, payment, subscription' },
            { name: 'technical', description: 'technical, error, outage, api, bug, incident, production' },
            { name: 'account', description: 'account, login, password, permission, access, user' },
            { name: 'growth', description: 'growth, upgrade, pricing, plan, renewal, expansion, sales' },
          ],
          instruction: 'Route this customer event to the team best equipped to handle it.',
          fallbackBranch: 3,
          minConfidence: 0.25,
        }),
        node('FlowCatalog', 'synapsedx.flow', 840, 40, {
          operation: 'workflows.list',
          input: {},
        }),
        node('HasLDS', 'n8n-nodes-base.if', 840, 200, {
          condition: '={{ !!$json.datasourceId }}',
        }),
        node('PublishTimeline', 'synapsedx.lds', 1100, 120, {
          operation: 'publish-record',
          input: {
            datasourceId: '={{ $json.datasourceId }}',
            record: {
              id: '={{ $json.eventId }}',
              eventId: '={{ $json.eventId }}',
              kind: 'customer360.event',
              customerId: '={{ $json.customerId }}',
              route: 'pending',
              query: '={{ $json.query }}',
              amount: '={{ $json.amount }}',
              priority: '={{ $json.priority }}',
              receivedAt: '={{ $json.receivedAt }}',
            },
          },
        }),
        node('SkipLDS', 'n8n-nodes-base.noOp', 1100, 260, {}),

        // Billing lane: calculation -> cache + Base audit in parallel -> aggregate.
        node('BillingCalc', 'n8n-nodes-base.code', 840, 380, {
          code:
            'const amount = Number($input.amount || 0);' +
            'const tier = String($input.tier || "standard");' +
            'const discount = tier === "enterprise" ? 0.15 : tier === "pro" ? 0.08 : 0;' +
            'const credit = Math.round(amount * discount * 100) / 100;' +
            'return { ...$input, billing: { amount, credit, currency: "USD", tier, discount, decision: credit > 0 ? "credit_approved" : "no_credit", calculatedAt: $now } };',
        }),
        node('BillingCache', 'synapsedx.faststore', 1120, 320, {
          operation: 'set',
          input: { key: 'billing:{{ $json.eventId }}', value: '={{ $json.billing }}', ttlSeconds: 3600 },
        }),
        node('BillingRecord', 'synapsedx.base', 1120, 440, {
          operation: 'create-document',
          input: { collection: 'customer360_events', id: '={{ $json.eventId }}', data: '={{ $json }}' },
        }),
        node('BillingDone', 'n8n-nodes-base.set', 1380, 440, {
          values: { route: 'billing', branchResult: '={{ $json.data }}', processedBy: 'billing' },
        }),

        // Technical lane: autonomous SRE agent with built-in + canvas tools.
        node('IncidentAgent', 'synapseflow.aiAgent', 840, 620, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt:
            'You are the SRE commander in SynapseFlow. Diagnose incidents using the available tools. ' +
            'Prefer evidence from SynapseBase, Faststore, IAM and the workflow catalog. ' +
            'The audit collection is customer360_events. SynapseBase filters are JSON objects, for example {"eventId":"evt-123"}; never pass a SQL-style string or guess a collection name. ' +
            'Never invent status or customer data. Keep the final answer under 250 words and end with a one-paragraph customer-safe update.',
          userPrompt:
            'Incident: "{{ $json.query }}". Event: {{ $json.eventId }}. Customer: {{ $json.customerId }}. ' +
            'Priority: {{ $json.priority }}. Route: {{ $json.decision.route }}. ' +
            'Use at most two tools, then return the remediation plan.',
          tools: [
            'synapsebase_query',
            'synapsebase_vector_search',
            'faststore_cache',
            'iam_check_permission',
            'workflow_list',
          ],
          maxSteps: 4,
          maxTokens: 1024,
          temperature: 0.1,
        }),

        // Account lane: permission check + cache snapshot in parallel, then audit.
        node('AccountPrep', 'n8n-nodes-base.noOp', 840, 820, {}),
        node('AccountAuth', 'synapsedx.iam', 1120, 740, {
          operation: 'authorize.check',
          input: { userId: '={{ $json.userId }}', action: 'read', resource: 'customer360' },
        }),
        node('AccountSnapshot', 'synapsedx.faststore', 1120, 840, {
          operation: 'hash-set',
          input: {
            key: 'account:{{ $json.customerId }}',
            values: { tier: '={{ $json.tier }}', riskScore: '={{ $json.riskScore }}', lastRoute: 'account', checkedAt: '={{ $now }}' },
          },
        }),
        node('AccountRecord', 'synapsedx.base', 1120, 940, {
          operation: 'create-document',
          input: { collection: 'customer360_events', id: '={{ $json.eventId }}', data: '={{ $json }}' },
        }),
        node('AccountDone', 'n8n-nodes-base.set', 1380, 940, {
          values: { route: 'account', branchResult: '={{ $json.data }}', processedBy: 'account' },
        }),

        // Growth lane: deterministic plan + Base audit; Flow catalog ran above.
        node('GrowthPlan', 'n8n-nodes-base.code', 840, 1080, {
          code:
            'const amount = Number($input.amount || 0);' +
            'const tier = String($input.tier || "standard");' +
            'const plan = amount >= 5000 ? "enterprise-expansion" : amount > 0 ? "growth-nurture" : "community";' +
            'return { ...$input, growth: { plan, tier, nextStep: plan === "enterprise-expansion" ? "executive-business-review" : "self-serve-nurture", createdAt: $now } };',
        }),
        node('GrowthRecord', 'synapsedx.base', 1120, 1080, {
          operation: 'create-document',
          input: { collection: 'customer360_events', id: '={{ $json.eventId }}', data: '={{ $json }}' },
        }),
        node('GrowthDone', 'n8n-nodes-base.set', 1380, 1080, {
          values: { route: 'growth', branchResult: '={{ $json.data }}', processedBy: 'growth' },
        }),

        // Fan-in: normalize every lane into one result, then side-effect metrics.
        node('Aggregate', 'n8n-nodes-base.code', 1680, 620, {
          code:
            'const p = $input || {};' +
            'const payload = p.branchResult || p;' +
            'const d = p.decision || payload.decision || {};' +
            'const route = p.route || payload.route || d.route || "unknown";' +
            'const agent = p.agent || payload.agent || {};' +
            'return { ...p, route, confidence: d.confidence ?? payload.confidence ?? p.confidence ?? 1, ' +
            'reply: p.response || agent.response || payload.reply || "", customerId: p.customerId || payload.customerId || "demo-customer", ' +
            'eventId: p.eventId || payload.eventId || ("evt-" + Date.now()), amount: Number(p.amount ?? payload.amount ?? 0), ' +
            'priority: p.priority || payload.priority || "normal", processedAt: $now };',
        }),
        node('Metrics', 'synapsedx.faststore', 1960, 500, {
          operation: 'incr',
          input: { key: 'customer360:processed', by: 1 },
        }),
        node('RiskGate', 'n8n-nodes-base.if', 1960, 640, {
          condition: '={{ ($json.confidence ?? 1) < 0.55 || $json.priority === "urgent" || ($json.amount ?? 0) >= 1000 }}',
        }),
        node('Escalate', 'synapsedx.queue', 2240, 560, {
          operation: 'publish',
          input: { queue: 'customer360-escalations', payload: '={{ $json }}', priority: 8 },
        }),
        node('Done', 'n8n-nodes-base.noOp', 2240, 740, {}),

        // Canvas tools (purple Tools sockets) + Model socket.
        node('KBLookup', 'synapsedx.base', 840, 1360, {
          operation: 'query-documents',
          input: { collection: 'customer360_events', limit: 3 },
        }),
        node('TraceCache', 'synapsedx.faststore', 1060, 1360, {
          operation: 'get',
          input: { key: 'customer360:{{ $json.customerId }}' },
        }),
        node('PermissionProbe', 'synapsedx.iam', 1280, 1360, {
          operation: 'authorize.check',
          input: { userId: '={{ $json.userId }}', action: 'read', resource: 'customer360' },
        }),
        node('FlowProbe', 'synapsedx.flow', 1500, 1360, {
          operation: 'workflows.list',
          input: {},
        }),
        node('ModelCore', 'synapseflow.model', 1720, 1360, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
        }),
      ],
      connections: {
        Intake: { main: [[edge('Normalize')]] },
        Normalize: { main: [[edge('Route'), edge('FlowCatalog'), edge('HasLDS')]] },
        HasLDS: { main: [[edge('PublishTimeline')], [edge('SkipLDS')]] },
        Route: {
          main: [
            [edge('BillingCalc')],
            [edge('IncidentAgent')],
            [edge('AccountPrep')],
            [edge('GrowthPlan')],
          ],
        },
        BillingCalc: { main: [[edge('BillingCache'), edge('BillingRecord')]] },
        BillingRecord: { main: [[edge('BillingDone')]] },
        BillingDone: { main: [[edge('Aggregate')]] },
        IncidentAgent: { main: [[edge('Aggregate')]] },
        AccountPrep: { main: [[edge('AccountAuth'), edge('AccountSnapshot'), edge('AccountRecord')]] },
        AccountRecord: { main: [[edge('AccountDone')]] },
        AccountDone: { main: [[edge('Aggregate')]] },
        GrowthPlan: { main: [[edge('GrowthRecord')]] },
        GrowthRecord: { main: [[edge('GrowthDone')]] },
        GrowthDone: { main: [[edge('Aggregate')]] },
        Aggregate: { main: [[edge('Metrics'), edge('RiskGate')]] },
        RiskGate: { main: [[edge('Escalate')], [edge('Done')]] },
        // tool/model sockets (auxiliary edges, never execution flow)
        KBLookup: { main: [[tool('IncidentAgent')]] },
        TraceCache: { main: [[tool('IncidentAgent')]] },
        PermissionProbe: { main: [[tool('IncidentAgent')]] },
        FlowProbe: { main: [[tool('IncidentAgent')]] },
        ModelCore: { main: [[model('IncidentAgent')]] },
      },
    };
  }
  if (name === 'ai-triage-ops') {
    const node = (n: string, type: string, x: number, y: number, parameters: any = {}) => ({
      id: wid(), name: n, type, typeVersion: 1, position: [x, y], parameters,
    });
    const edge = (target: string) => ({ node: target, type: 'main', index: 0 });
    const tool = (target: string) => ({ node: target, type: 'tools', index: 0, targetPort: 'tools' });
    const model = (target: string) => ({ node: target, type: 'model', index: 0, targetPort: 'model' });
    return {
      name: wname,
      settings: { onError: 'continue', timeoutMs: 300000 },
      nodes: [
        node('Intake', 'n8n-nodes-base.webhook', 80, 340, { path: 'ai-triage-demo', httpMethod: 'POST' }),
        node('Normalize', 'n8n-nodes-base.code', 330, 340, {
          code:
            'const p = $input || {};' +
            'const query = String(p.query || p.message || p.text || p.description || "").trim();' +
            'const urgent = /(urgent|asap|down|outage|production)/i.test(query);' +
            'return { ...p, query, ticketId: p.ticketId || ("T-" + Date.now()), priority: p.priority || (urgent ? "urgent" : "normal"), receivedAt: $now };',
        }),
        node('Triage', 'synapseflow.decision', 600, 340, {
          input: '={{ $json.query }}',
          choices: [
            { name: 'billing', description: 'billing, invoices, refunds, payments, subscription charges' },
            { name: 'technical', description: 'bugs, errors, API failures, outages, technical problems' },
            { name: 'account', description: 'login, password, profile, permissions, account access' },
            { name: 'sales', description: 'pricing, plans, purchase, upgrade, partnership' },
          ],
          instruction: 'Route this support ticket to the team best equipped to handle it.',
          fallbackBranch: 3,
          minConfidence: 0.3,
        }),
        node('BillingAgent', 'synapseflow.aiAgent', 900, 80, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt: 'You are the Billing specialist in SynapseFlow. Use SynapseBase and Faststore tools to ground every answer in real data. Be concise, cite amounts and invoice ids, and never invent a payment.',
          userPrompt: 'Handle this billing ticket. Customer says: "{{ $json.query }}". Ticket: {{ $json.ticketId }}. Look up the knowledge base/cache when useful, then produce the customer reply.',
          tools: ['synapsebase_query', 'faststore_cache', 'decision_eval', 'http_request', 'workflow_run'],
          maxSteps: 7,
          temperature: 0.2,
        }),
        node('TechAgent', 'synapseflow.aiAgent', 900, 320, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt: 'You are the Technical support specialist in SynapseFlow. Diagnose the issue, use the code sandbox for calculations/transforms, and call the HTTP tool only for public status endpoints. Give concrete next steps.',
          userPrompt: 'Diagnose and answer this technical ticket: "{{ $json.query }}". Priority: {{ $json.priority }}. Use the KB/status tools, then produce the customer reply.',
          tools: ['synapsebase_query', 'code_sandbox', 'logic_calculator', 'decision_eval', 'queue_publish', 'http_request'],
          maxSteps: 8,
          temperature: 0.2,
        }),
        node('AccountAgent', 'synapseflow.aiAgent', 900, 560, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
          systemPrompt: 'You are the Account & Access specialist in SynapseFlow. Use the IAM permission check and cache tools before making claims about access. Never disclose secrets or other tenants\' data.',
          userPrompt: 'Resolve this account/access ticket: "{{ $json.query }}". Customer id: {{ $json.customerId || "unknown" }}. Check permissions with tools, then produce the customer reply.',
          tools: ['iam_check_permission', 'faststore_cache', 'workflow_list', 'workflow_run'],
          maxSteps: 6,
          temperature: 0.2,
        }),
        node('SalesReply', 'n8n-nodes-base.set', 900, 800, {
          values: {
            department: 'sales',
            reply: 'Thanks for your interest in SynapseDX! Our sales team will reach out shortly with pricing and the right plan for your team.',
          },
        }),
        node('Aggregate', 'n8n-nodes-base.code', 1240, 340, {
          code:
            'const d = $input.decision || {};' +
            'const a = $input.agent || {};' +
            'return { ...$input, route: d.route || $input.department || "sales", confidence: d.confidence ?? $input.confidence ?? 1, reply: a.response || $input.reply || "", department: d.route || $input.department || "sales", processedAt: $now };',
        }),
        node('NeedsEscalation', 'n8n-nodes-base.if', 1500, 340, {
          condition: '={{ ($json.confidence ?? 1) < 0.55 || $json.priority === "urgent" }}',
        }),
        node('Escalate', 'synapsedx.queue', 1780, 220, {
          operation: 'publish',
          input: { queue: 'support-escalations', payload: '={{ $json }}', priority: 5 },
        }),
        node('Done', 'n8n-nodes-base.noOp', 1780, 460, {}),
        // ---- Canvas tools (connect to agents' Tools sockets) ----
        node('KBLookup', 'synapsedx.base', 620, 980, {
          operation: 'query-documents',
          input: { collection: 'support_kb', limit: 5 },
        }),
        node('CustomerCache', 'synapsedx.faststore', 620, 1120, {
          operation: 'get',
          input: { key: 'customer:={{ $json.customerId }}' },
        }),
        node('PermissionCheck', 'synapsedx.iam', 620, 1260, {
          operation: 'authorize.check',
          input: { userId: '={{ $json.userId }}', action: 'read', resource: 'support_ticket' },
        }),
        node('StatusAPI', 'n8n-nodes-base.httpRequest', 620, 1400, {
          url: 'https://api.example.com/health',
          method: 'GET',
        }),
        node('ModelCore', 'synapseflow.model', 620, 1540, {
          core: 'synapse-inference',
          model: 'liquid/lfm-2.5-2.6b:free',
        }),
      ],
      connections: {
        Intake: { main: [[edge('Normalize')]] },
        Normalize: { main: [[edge('Triage')]] },
        Triage: {
          main: [
            [edge('BillingAgent')],
            [edge('TechAgent')],
            [edge('AccountAgent')],
            [edge('SalesReply')],
          ],
        },
        BillingAgent: { main: [[edge('Aggregate')]] },
        TechAgent: { main: [[edge('Aggregate')]] },
        AccountAgent: { main: [[edge('Aggregate')]] },
        SalesReply: { main: [[edge('Aggregate')]] },
        Aggregate: { main: [[edge('NeedsEscalation')]] },
        NeedsEscalation: { main: [[edge('Escalate')], [edge('Done')]] },
        // tool/model sockets (not execution flow)
        KBLookup: { main: [[tool('BillingAgent')], [tool('TechAgent')]] },
        CustomerCache: { main: [[tool('BillingAgent')], [tool('AccountAgent')]] },
        PermissionCheck: { main: [[tool('AccountAgent')]] },
        StatusAPI: { main: [[tool('TechAgent')]] },
        ModelCore: { main: [[model('BillingAgent')]] },
      },
    };
  }
  if (name === 'vector-rag-orchestrator') {
    const node = (n: string, type: string, x: number, y: number, parameters: any = {}) => ({
      id: wid(), name: n, type, typeVersion: 1, position: [x, y], parameters,
    });
    const edge = (target: string) => ({ node: target, type: 'main', index: 0 });
    return {
      name: wname,
      settings: { onError: 'continue', timeoutMs: 300000 },
      nodes: [
        { ...node('Intake', 'n8n-nodes-base.webhook', 80, 360, { path: 'vector-rag-demo', httpMethod: 'POST' }), webhookId: wid() },
        node('Normalize', 'n8n-nodes-base.code', 300, 360, {
          code: 'const p = $input || {}; const query = String(p.query || p.message || p.question || "How to configure SSO").trim(); const incidentId = p.incidentId || ("inc-" + Date.now()); const category = p.category || "knowledge"; const urgency = /(urgent|critical|outage|down)/i.test(query) ? "high" : "normal"; return { ...p, query, incidentId, category, urgency, timestamp: $now };',
        }),
        node('KBVectorSearch', 'synapsedx.base', 540, 360, {
          operation: 'vector-search',
          input: {
            collection: 'kb_articles',
            query: '={{ $json.query }}',
            limit: 3,
            metric: 'cosine',
            as: 'object',
          },
        }),
        node('ScoreMatch', 'n8n-nodes-base.code', 780, 360, {
          code: 'const prev = $input || {}; const items = prev.items || []; const total = prev.total || items.length; const topItem = items[0] || null; const similarity = topItem ? Number(topItem.similarity || 0) : 0; const doc = topItem ? (topItem.object || topItem.data || {}) : {}; let route = "escalate"; if (similarity >= 0.85) route = "auto_resolve"; else if (similarity >= 0.50) route = "agent_triage"; return { ...prev, topDocId: topItem ? topItem.id : null, topDocTitle: doc.title || "No matching article", topDocSolution: doc.solution || doc.content || "Standard triage runbook", similarity, matchCount: total, route };',
        }),
        node('RouteByScore', 'synapseflow.decision', 1020, 360, {
          input: '={{ $json.route }}',
          choices: [
            { name: 'auto_resolve', description: 'High confidence semantic match above 0.85 similarity' },
            { name: 'agent_triage', description: 'Medium confidence match between 0.50 and 0.85 similarity requiring AI Agent investigation' },
            { name: 'escalate', description: 'Low confidence match below 0.50 or missing article' },
          ],
        }),
        node('AutoResolve', 'n8n-nodes-base.code', 1300, 200, {
          code: 'const p = $input || {}; return { status: "resolved", resolutionType: "automated_rag", incidentId: p.incidentId, query: p.query, matchedDocId: p.topDocId, matchedDocTitle: p.topDocTitle, similarity: p.similarity, solution: p.topDocSolution, actionTaken: "KB runbook automatically dispatched to customer", resolvedAt: $now };',
        }),
        node('AgentTriage', 'synapseflow.agent', 1300, 360, {
          systemPrompt: 'You are an intelligent SRE & Support Specialist in SynapseFlow. Use vector search and tools to investigate tickets, verify knowledge base articles, and generate concise resolution reports.',
          input: '={{ "Incident: " + $json.incidentId + ". Query: " + $json.query + ". Top KB match: " + $json.topDocTitle + " (similarity: " + $json.similarity + "). Please provide resolution recommendation." }}',
          tools: ['synapsebase_vector_search', 'synapsebase_query', 'faststore_get'],
        }),
        node('AgentFormat', 'n8n-nodes-base.code', 1540, 360, {
          code: 'const p = $input || {}; return { status: "resolved", resolutionType: "agent_assisted_rag", incidentId: p.incidentId, query: p.query, similarity: p.similarity, solution: p.output || p.result || "Agent verified resolution from KB context", resolvedAt: $now };',
        }),
        node('EscalateQueue', 'synapsedx.queue', 1300, 520, {
          operation: 'publish',
          input: {
            queue: 'incident-escalations',
            payload: '={{ $json }}',
          },
        }),
        node('EscalateFormat', 'n8n-nodes-base.code', 1540, 520, {
          code: 'const p = $input || {}; const incidentId = p.incidentId || p.message?.payload?.incidentId || p.payload?.incidentId; const query = p.query || p.message?.payload?.query || ""; const similarity = p.similarity ?? p.message?.payload?.similarity ?? 0; return { status: "escalated", resolutionType: "human_sre_queue", incidentId, query, similarity, queueId: p.id || p.messageId || "queued", actionTaken: "Dispatched to Tier-2 SRE queue", escalatedAt: $now };',
        }),
        node('CacheResult', 'synapsedx.faststore', 1800, 360, {
          operation: 'set',
          input: {
            key: '={{ "rag:incident:" + $json.incidentId }}',
            value: '={{ JSON.stringify($json) }}',
            ttl: 3600,
          },
        }),
        node('FinalSummary', 'n8n-nodes-base.code', 2040, 360, {
          code: 'const p = $input || {}; return { ok: true, summary: "Pipeline completed for incident " + (p.incidentId || "unknown"), incidentId: p.incidentId, resolutionType: p.resolutionType, status: p.status, similarity: p.similarity, solution: p.solution, actionTaken: p.actionTaken, completedAt: $now };',
        }),
      ],
      connections: {
        Intake: { main: [[edge('Normalize')]] },
        Normalize: { main: [[edge('KBVectorSearch')]] },
        KBVectorSearch: { main: [[edge('ScoreMatch')]] },
        ScoreMatch: { main: [[edge('RouteByScore')]] },
        RouteByScore: {
          main: [
            [edge('AutoResolve')],
            [edge('AgentTriage')],
            [edge('EscalateQueue')],
          ],
        },
        AutoResolve: { main: [[edge('CacheResult'), edge('FinalSummary')]] },
        AgentTriage: { main: [[edge('AgentFormat')]] },
        AgentFormat: { main: [[edge('CacheResult'), edge('FinalSummary')]] },
        EscalateQueue: { main: [[edge('EscalateFormat')]] },
        EscalateFormat: { main: [[edge('CacheResult'), edge('FinalSummary')]] },
      },
    };
  }
  return null;
}
const lastCronRun = new Map<string, number>();
function startCronLoop(): void {
  const everyMs = Math.max(10000, Number(process.env.WORKFLOW_CRON_TICK_MS || 15000));
  const tick = async () => {
    try {
      const actives = await listActiveCronWorkflows();
      const now = Date.now();
      for (const wf of actives) {
        const interval = workflowCronIntervalMs({ nodes: wf.nodes as any });
        const wallClock = !interval ? workflowCronNextRunAt({ nodes: wf.nodes as any }, now) : null;
        if (!interval && !wallClock) continue;
        const last = lastCronRun.get(wf.id) || 0;
        if (interval) {
          if (now - last < interval) continue;
        } else if (!(wallClock && wallClock <= now && last < wallClock)) {
          continue;
        }
        lastCronRun.set(wf.id, now);
        try {
          const startedAt = new Date().toISOString();
          const runPrincipal = workflowRunPrincipal(wf);
          const r = await runWorkflow(
            { nodes: wf.nodes as any, connections: wf.connections as any, name: wf.name, settings: wf.settings as any },
            { scheduledAt: startedAt },
            { triggeredBy: 'cron', principal: runPrincipal, credentialResolver: makeCredentialResolver(runPrincipal), synapsedxCall },
          );
          const finishedAt = new Date().toISOString();
          recordRun('cron', r.status, r.nodeRuns);
          await createExecutionRec({
            workflow_id: wf.id, workflow_name: wf.name, status: r.status,
            input: { scheduledAt: startedAt }, output: r.output, node_runs: r.nodeRuns as any,
            error: (r as any).error ?? null, triggered_by: 'cron',
            principal: runPrincipal, actor: actorFor(wf.id, runPrincipal), startedAt, finishedAt,
          });
          console.log(`[workflow][cron] ${wf.name} (${wf.id}) -> ${r.status}`);
        } catch (e: any) {
          console.error(`[workflow][cron] ${wf.id} failed:`, e?.message || e);
        }
      }
    } catch (e: any) {
      console.error('[workflow][cron] tick failed:', e?.message || e);
    }
  };
  setInterval(tick, everyMs).unref?.();
  // Jittered first tick so a fresh deploy doesn't thundering-herd crons.
  setTimeout(tick, Math.min(everyMs, 5000)).unref?.();
}

if (require.main === module) {
  ensureTables().catch(() => undefined).finally(() => {
    const app = createApp();
    startCronLoop();
    const server = app.listen(PORT, () => console.log(`[workflow] listening on :${PORT} engine=local db=${useDb() ? 'postgres' : 'memory'}`));
    const shutdown = () => {
      console.log('[workflow] shutting down...');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

// Exported for tests (start loop only under main).
export { detectCycle, ensureTables, startCronLoop };
