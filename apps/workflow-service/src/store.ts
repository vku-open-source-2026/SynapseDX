/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Local workflow persistence — Postgres with in-memory fallback (dev/test).
 * Apache-2.0, no third-party engine. Tables are auto-created on boot.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

/** Caller principal stamped by the gateway (P0-2). Anonymous when called
 *  directly with only the internal secret (dev/tests). */
export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

export interface StoredWorkflow {
  id: string;
  name: string;
  nodes: any[];
  connections: Record<string, any>;
  settings: Record<string, any>;
  active: boolean;
  /** Tenant binding (P0-3): null = legacy global workflow. */
  org_id?: string | null;
  account_id?: string | null;
  owner_sub?: string | null;
  run_as?: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface StoredExecution {
  id: string;
  workflow_id: string;
  workflow_name?: string;
  status: 'success' | 'error' | 'running';
  input: any;
  output: any;
  node_runs: Array<{
    node: string;
    type: string;
    status: 'success' | 'error' | 'skipped';
    input: any;
    output: any;
    error?: string;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
  }>;
  error?: string | null;
  triggered_by: string;
  /** Principal snapshot at run time (P0-2/P0-3) + audit actor string. */
  principal?: Principal | null;
  actor?: string | null;
  startedAt: string;
  finishedAt: string;
}

const DATABASE_URL = process.env.DATABASE_URL || '';
let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[workflow][db] pool error', (e as any)?.message || e));
}

export function useDb(): boolean {
  return !!pool;
}

// ---- in-memory fallback ----
const memWorkflows = new Map<string, StoredWorkflow>();
const memExecutions = new Map<string, StoredExecution>();
// newest-first ordering helper
const memExecOrder: string[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

const CREATE_WORKFLOWS_SQL = `
CREATE TABLE IF NOT EXISTS synapsedx_workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nodes JSONB NOT NULL DEFAULT '[]',
  connections JSONB NOT NULL DEFAULT '{}',
  settings JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  org_id TEXT,
  account_id TEXT,
  owner_sub TEXT,
  run_as TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_synapsedx_workflows_active ON synapsedx_workflows(active);
CREATE INDEX IF NOT EXISTS idx_synapsedx_workflows_tenant ON synapsedx_workflows(org_id, account_id);
`;

const CREATE_EXECUTIONS_SQL = `
CREATE TABLE IF NOT EXISTS synapsedx_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'success',
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  node_runs JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'manual',
  principal JSONB,
  actor TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_synapsedx_exec_workflow ON synapsedx_executions(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_synapsedx_exec_status ON synapsedx_executions(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_synapsedx_exec_time ON synapsedx_executions(started_at DESC);
`;

// Additive migrations for pre-existing tables (no data loss, idempotent).
const MIGRATE_SQL = `
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS owner_sub TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS run_as TEXT;
ALTER TABLE synapsedx_workflows ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_synapsedx_workflows_tenant ON synapsedx_workflows(org_id, account_id);
ALTER TABLE synapsedx_executions ADD COLUMN IF NOT EXISTS principal JSONB;
ALTER TABLE synapsedx_executions ADD COLUMN IF NOT EXISTS actor TEXT;
`;

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!pool || ensured) return;
  ensured = true;
  try {
    await pool.query(CREATE_WORKFLOWS_SQL);
    await pool.query(CREATE_EXECUTIONS_SQL);
    await pool.query(MIGRATE_SQL);
  } catch (e: any) {
    ensured = false;
    console.error('[workflow][db] ensureTables failed:', e?.message || e);
  }
}

function cleanTenant(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function rowToWorkflow(r: any): StoredWorkflow {
  return {
    id: String(r.id),
    name: String(r.name || ''),
    nodes: Array.isArray(r.nodes) ? r.nodes : [],
    connections: r.connections && typeof r.connections === 'object' ? r.connections : {},
    settings: r.settings && typeof r.settings === 'object' ? r.settings : {},
    active: !!r.active,
    org_id: r.org_id != null ? String(r.org_id) : null,
    account_id: r.account_id != null ? String(r.account_id) : null,
    owner_sub: r.owner_sub != null ? String(r.owner_sub) : null,
    run_as: r.run_as != null ? String(r.run_as) : null,
    revision: Number.isFinite(Number(r.revision)) ? Number(r.revision) : 1,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || nowIso()),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || nowIso()),
  };
}

function rowToExecution(r: any): StoredExecution {
  let principal: Principal | null = null;
  try {
    const p = r.principal;
    if (p && typeof p === 'object' && typeof (p as any).sub === 'string') principal = p as Principal;
  } catch { /* ignore */ }
  return {
    id: String(r.id),
    workflow_id: String(r.workflow_id || ''),
    workflow_name: String(r.workflow_name || ''),
    status: r.status === 'error' ? 'error' : r.status === 'running' ? 'running' : 'success',
    input: r.input ?? {},
    output: r.output ?? null,
    node_runs: Array.isArray(r.node_runs) ? r.node_runs : [],
    error: r.error ?? null,
    triggered_by: String(r.triggered_by || 'manual'),
    principal,
    actor: r.actor != null ? String(r.actor) : null,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at || nowIso()),
    finishedAt: r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at || nowIso()),
  };
}

export async function createWorkflowRec(data: {
  name: string;
  nodes: any[];
  connections: Record<string, any>;
  settings?: Record<string, any>;
  active?: boolean;
  org_id?: string | null;
  account_id?: string | null;
  owner_sub?: string | null;
  run_as?: string | null;
}): Promise<StoredWorkflow> {
  const rec: StoredWorkflow = {
    id: randomUUID(),
    name: data.name,
    nodes: data.nodes || [],
    connections: data.connections || {},
    settings: data.settings || {},
    active: !!data.active,
    org_id: cleanTenant(data.org_id),
    account_id: cleanTenant(data.account_id),
    owner_sub: cleanTenant(data.owner_sub),
    run_as: cleanTenant(data.run_as),
    revision: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      `INSERT INTO synapsedx_workflows (id, name, nodes, connections, settings, active, org_id, account_id, owner_sub, run_as, revision)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,1)
       RETURNING id, name, nodes, connections, settings, active, org_id, account_id, owner_sub, run_as, revision, created_at, updated_at`,
      [rec.id, rec.name, JSON.stringify(rec.nodes), JSON.stringify(rec.connections), JSON.stringify(rec.settings), rec.active,
        rec.org_id, rec.account_id, rec.owner_sub, rec.run_as],
    );
    return rowToWorkflow(r.rows[0]);
  }
  memWorkflows.set(rec.id, rec);
  return rec;
}

export async function getWorkflowRec(id: string): Promise<StoredWorkflow | null> {
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      'SELECT id, name, nodes, connections, settings, active, org_id, account_id, owner_sub, run_as, revision, created_at, updated_at FROM synapsedx_workflows WHERE id=$1',
      [id],
    );
    return r.rows[0] ? rowToWorkflow(r.rows[0]) : null;
  }
  return memWorkflows.get(id) || null;
}

export async function listWorkflowRecs(filter?: { orgId?: string; accountId?: string }): Promise<StoredWorkflow[]> {
  if (pool) {
    await ensureTables();
    const conds: string[] = [];
    const params: any[] = [];
    if (filter?.orgId) { params.push(filter.orgId); conds.push(`org_id=$${params.length}`); }
    if (filter?.accountId) { params.push(filter.accountId); conds.push(`account_id=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT id, name, nodes, connections, settings, active, org_id, account_id, owner_sub, run_as, revision, created_at, updated_at FROM synapsedx_workflows ${where} ORDER BY created_at ASC`,
      params,
    );
    return r.rows.map(rowToWorkflow);
  }
  let arr = [...memWorkflows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (filter?.orgId) arr = arr.filter((w) => w.org_id === filter.orgId);
  if (filter?.accountId) arr = arr.filter((w) => w.account_id === filter.accountId);
  return arr;
}

export async function updateWorkflowRec(
  id: string,
  patch: { name?: string; nodes?: any[]; connections?: Record<string, any>; settings?: Record<string, any>; active?: boolean; org_id?: string | null; account_id?: string | null; run_as?: string | null },
): Promise<StoredWorkflow | null> {
  if (pool) {
    await ensureTables();
    const cur = await getWorkflowRec(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      nodes: patch.nodes ?? cur.nodes,
      connections: patch.connections ?? cur.connections,
      settings: patch.settings ?? cur.settings,
      active: patch.active ?? cur.active,
      org_id: patch.org_id !== undefined ? cleanTenant(patch.org_id) : cur.org_id,
      account_id: patch.account_id !== undefined ? cleanTenant(patch.account_id) : cur.account_id,
      run_as: patch.run_as !== undefined ? cleanTenant(patch.run_as) : cur.run_as,
    };
    const r = await pool.query(
      `UPDATE synapsedx_workflows SET name=$2, nodes=$3::jsonb, connections=$4::jsonb, settings=$5::jsonb,
        active=$6, org_id=$7, account_id=$8, run_as=$9, revision=revision+1, updated_at=now()
       WHERE id=$1
       RETURNING id, name, nodes, connections, settings, active, org_id, account_id, owner_sub, run_as, revision, created_at, updated_at`,
      [id, next.name, JSON.stringify(next.nodes), JSON.stringify(next.connections), JSON.stringify(next.settings), next.active,
        next.org_id, next.account_id, next.run_as],
    );
    return r.rows[0] ? rowToWorkflow(r.rows[0]) : null;
  }
  const cur = memWorkflows.get(id);
  if (!cur) return null;
  const next: StoredWorkflow = {
    ...cur,
    name: patch.name ?? cur.name,
    nodes: patch.nodes ?? cur.nodes,
    connections: patch.connections ?? cur.connections,
    settings: patch.settings ?? cur.settings,
    active: patch.active ?? cur.active,
    org_id: patch.org_id !== undefined ? cleanTenant(patch.org_id) : cur.org_id,
    account_id: patch.account_id !== undefined ? cleanTenant(patch.account_id) : cur.account_id,
    run_as: patch.run_as !== undefined ? cleanTenant(patch.run_as) : cur.run_as,
    revision: (cur.revision || 1) + 1,
    updated_at: nowIso(),
  };
  memWorkflows.set(id, next);
  return next;
}

export async function deleteWorkflowRec(id: string): Promise<boolean> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('DELETE FROM synapsedx_workflows WHERE id=$1', [id]);
    return (r.rowCount || 0) > 0;
  }
  return memWorkflows.delete(id);
}

export async function createExecutionRec(data: {
  workflow_id: string;
  workflow_name?: string;
  status: 'success' | 'error' | 'running';
  input: any;
  output: any;
  node_runs: StoredExecution['node_runs'];
  error?: string | null;
  triggered_by: string;
  principal?: Principal | null;
  actor?: string | null;
  startedAt: string;
  finishedAt: string;
  id?: string;
}): Promise<StoredExecution> {
  const rec: StoredExecution = {
    id: data.id || randomUUID(),
    workflow_id: data.workflow_id,
    workflow_name: data.workflow_name || '',
    status: data.status,
    input: data.input ?? {},
    output: data.output ?? null,
    node_runs: data.node_runs || [],
    error: data.error ?? null,
    triggered_by: data.triggered_by || 'manual',
    principal: data.principal ?? null,
    actor: data.actor ?? null,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
  };
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      `INSERT INTO synapsedx_executions
        (id, workflow_id, workflow_name, status, input, output, node_runs, error, triggered_by, principal, actor, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13)
       RETURNING id, workflow_id, workflow_name, status, input, output, node_runs, error, triggered_by, principal, actor, started_at, finished_at`,
      [
        rec.id, rec.workflow_id, rec.workflow_name, rec.status,
        JSON.stringify(rec.input ?? {}), JSON.stringify(rec.output ?? null),
        JSON.stringify(rec.node_runs ?? []), rec.error, rec.triggered_by,
        JSON.stringify(rec.principal ?? null), rec.actor,
        rec.startedAt, rec.finishedAt,
      ],
    );
    return rowToExecution(r.rows[0]);
  }
  memExecutions.set(rec.id, rec);
  memExecOrder.unshift(rec.id);
  if (memExecOrder.length > 2000) {
    const drop = memExecOrder.pop();
    if (drop) memExecutions.delete(drop);
  }
  return rec;
}

export async function getExecutionRec(id: string): Promise<StoredExecution | null> {
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      `SELECT id, workflow_id, workflow_name, status, input, output, node_runs, error, triggered_by, principal, actor, started_at, finished_at
       FROM synapsedx_executions WHERE id=$1`,
      [id],
    );
    return r.rows[0] ? rowToExecution(r.rows[0]) : null;
  }
  return memExecutions.get(id) || null;
}

export async function listExecutionRecs(opts: {
  workflowId?: string;
  status?: string;
  triggeredBy?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: StoredExecution[]; total?: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (pool) {
    await ensureTables();
    const conds: string[] = [];
    const params: any[] = [];
    if (opts.workflowId) {
      params.push(opts.workflowId);
      conds.push(`workflow_id=$${params.length}`);
    }
    if (opts.status) {
      params.push(opts.status);
      conds.push(`status=$${params.length}`);
    }
    if (opts.triggeredBy) {
      params.push(opts.triggeredBy);
      conds.push(`triggered_by=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    params.push(offset);
    const r = await pool.query(
      `SELECT id, workflow_id, workflow_name, status, input, output, node_runs, error, triggered_by, principal, actor, started_at, finished_at
       FROM synapsedx_executions ${where} ORDER BY started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows.map(rowToExecution) };
  }
  let arr = memExecOrder.map((id) => memExecutions.get(id)!).filter(Boolean);
  if (opts.workflowId) arr = arr.filter((e) => e.workflow_id === opts.workflowId);
  if (opts.status) arr = arr.filter((e) => e.status === opts.status);
  if (opts.triggeredBy) arr = arr.filter((e) => e.triggered_by === opts.triggeredBy);
  return { items: arr.slice(offset, offset + limit) };
}

export async function findActiveWebhookWorkflow(path: string): Promise<StoredWorkflow | null> {
  const clean = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  const all = await listWorkflowRecs();
  for (const w of all) {
    if (!w.active) continue;
    for (const n of w.nodes || []) {
      if ((n as any)?.type !== 'n8n-nodes-base.webhook') continue;
      const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
      if (p === clean) return w;
    }
  }
  return null;
}

export async function listActiveCronWorkflows(): Promise<StoredWorkflow[]> {
  const all = await listWorkflowRecs();
  return all.filter((w) => w.active && (w.nodes || []).some((n) => (n as any)?.type === 'n8n-nodes-base.cron'));
}

// ---------- credentials (P0-4): account-scoped secrets, encrypted at rest ----------

export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'hmac';

export interface StoredCredential {
  id: string;
  account_id: string;
  name: string;
  kind: CredentialKind;
  /** AES-256-GCM envelope: {iv, tag, data} base64 (never the raw secret). */
  secret_enc: string;
  created_at: string;
  updated_at: string;
}

const MIGRATE_CRED_SQL = `
CREATE TABLE IF NOT EXISTS synapsedx_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'bearer',
  secret_enc TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_synapsedx_credentials_account ON synapsedx_credentials(account_id);
`;

export async function ensureCredentialTables(): Promise<void> {
  if (!pool) return;
  await ensureTables();
  try {
    await pool.query(MIGRATE_CRED_SQL);
  } catch (e: any) {
    console.error('[workflow][db] ensureCredentialTables failed:', e?.message || e);
  }
}

const memCredentials = new Map<string, StoredCredential>();

function credKey(): Buffer {
  // Production requires an explicit 32-byte hex key; dev falls back to an
  // ephemeral key (secrets don't survive restart — fail-safe, never plaintext).
  const raw = (process.env.SYNAPSEDX_CREDENTIAL_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[workflow] SYNAPSEDX_CREDENTIAL_KEY must be a 32-byte hex string in production');
  }
  if (!(globalThis as any).__synapsedxCredKey) {
    console.warn('[workflow][security] SYNAPSEDX_CREDENTIAL_KEY not set — using an ephemeral dev key (credentials reset on restart).');
    (globalThis as any).__synapsedxCredKey = require('crypto').randomBytes(32);
  }
  return (globalThis as any).__synapsedxCredKey;
}

/** Encrypt a secret envelope (AES-256-GCM). Returns opaque base64 JSON. */
export function encryptSecret(plain: string): string {
  const crypto = require('crypto');
  const key = credKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.from(JSON.stringify({
    iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64'),
  })).toString('base64');
}

/** Decrypt an envelope produced by encryptSecret. Throws on tamper. */
export function decryptSecret(enc: string): string {
  const crypto = require('crypto');
  const key = credKey();
  const { iv, tag, data } = JSON.parse(Buffer.from(String(enc), 'base64').toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function rowToCredential(r: any): StoredCredential {
  return {
    id: String(r.id),
    account_id: String(r.account_id || ''),
    name: String(r.name || ''),
    kind: (['bearer', 'api-key', 'basic', 'hmac'].includes(r.kind) ? r.kind : 'bearer') as CredentialKind,
    secret_enc: String(r.secret_enc || ''),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || nowIso()),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || nowIso()),
  };
}

/** Public metadata shape — never includes secret material. */
export function toPublicCredential(c: StoredCredential): any {
  return { id: c.id, accountId: c.account_id, name: c.name, kind: c.kind, createdAt: c.created_at, updatedAt: c.updated_at };
}

export async function createCredentialRec(data: { account_id: string; name: string; kind: CredentialKind; secret: string }): Promise<StoredCredential> {
  const rec: StoredCredential = {
    id: randomUUID(), account_id: data.account_id, name: data.name, kind: data.kind,
    secret_enc: encryptSecret(data.secret), created_at: nowIso(), updated_at: nowIso(),
  };
  if (pool) {
    await ensureCredentialTables();
    try {
      const r = await pool.query(
        `INSERT INTO synapsedx_credentials (id, account_id, name, kind, secret_enc)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, account_id, name, kind, secret_enc, created_at, updated_at`,
        [rec.id, rec.account_id, rec.name, rec.kind, rec.secret_enc],
      );
      return rowToCredential(r.rows[0]);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        const err = new Error(`credential name '${data.name}' already exists in this account`) as any;
        err.code = 'conflict';
        throw err;
      }
      throw e;
    }
  }
  for (const c of memCredentials.values()) {
    if (c.account_id === rec.account_id && c.name === rec.name) {
      const err = new Error(`credential name '${data.name}' already exists in this account`) as any;
      err.code = 'conflict';
      throw err;
    }
  }
  memCredentials.set(rec.id, rec);
  return rec;
}

export async function getCredentialRec(id: string): Promise<StoredCredential | null> {
  if (pool) {
    await ensureCredentialTables();
    const r = await pool.query(
      'SELECT id, account_id, name, kind, secret_enc, created_at, updated_at FROM synapsedx_credentials WHERE id=$1', [id],
    );
    return r.rows[0] ? rowToCredential(r.rows[0]) : null;
  }
  return memCredentials.get(id) || null;
}

export async function listCredentialRecs(accountId?: string): Promise<StoredCredential[]> {
  if (pool) {
    await ensureCredentialTables();
    const r = accountId
      ? await pool.query('SELECT id, account_id, name, kind, secret_enc, created_at, updated_at FROM synapsedx_credentials WHERE account_id=$1 ORDER BY created_at ASC', [accountId])
      : await pool.query('SELECT id, account_id, name, kind, secret_enc, created_at, updated_at FROM synapsedx_credentials ORDER BY created_at ASC');
    return r.rows.map(rowToCredential);
  }
  const arr = [...memCredentials.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return accountId ? arr.filter((c) => c.account_id === accountId) : arr;
}

export async function deleteCredentialRec(id: string): Promise<boolean> {
  if (pool) {
    await ensureCredentialTables();
    const r = await pool.query('DELETE FROM synapsedx_credentials WHERE id=$1', [id]);
    return (r.rowCount || 0) > 0;
  }
  return memCredentials.delete(id);
}

export function __clearCredentials(): void {
  memCredentials.clear();
}

export function __clearMem(): void {
  memWorkflows.clear();
  memExecutions.clear();
  memExecOrder.length = 0;
  memCredentials.clear();
}
