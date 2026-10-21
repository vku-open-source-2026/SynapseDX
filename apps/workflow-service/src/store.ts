/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Local workflow persistence — Drizzle ORM on Postgres with in-memory
 * fallback for dev/test. Tables/indexes live in ./schema.ts and are applied by
 * versioned Drizzle migrations.
 */
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isWebhookType, isCronType } from './engine';
import { credentials, executions, workflows } from './schema';

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
const db = pool ? drizzle(pool, { schema: { credentials, executions, workflows } }) : null;

export function useDb(): boolean {
  return !!db;
}

// ---- in-memory fallback ----
const memWorkflows = new Map<string, StoredWorkflow>();
const memExecutions = new Map<string, StoredExecution>();
// newest-first ordering helper
const memExecOrder: string[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function iso(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return String(v);
  }
  return nowIso();
}

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!db || ensured) return;
  ensured = true;
  try {
    const client = await pool!.connect();
    try {
      // Hold the advisory lock on the same dedicated session that runs the
      // migration (pool connections are not guaranteed to be reused).
      const migrationDb = drizzle(client, { schema: { credentials, executions, workflows } });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapsedx_workflow_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_workflow',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapsedx_workflow_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[workflow][db] migrations failed:', e?.message || e);
  }
}

function cleanTenant(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s.length > 128 || /[\r\n]/.test(s)) return null;
  return s;
}

function rowToWorkflow(r: typeof workflows.$inferSelect): StoredWorkflow {
  return {
    id: String(r.id),
    name: String(r.name || ''),
    nodes: Array.isArray(r.nodes) ? r.nodes : [],
    connections: r.connections && typeof r.connections === 'object' ? r.connections : {},
    settings: r.settings && typeof r.settings === 'object' ? r.settings : {},
    active: !!r.active,
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    owner_sub: r.ownerSub != null ? String(r.ownerSub) : null,
    run_as: r.runAs != null ? String(r.runAs) : null,
    revision: Number.isFinite(Number(r.revision)) ? Number(r.revision) : 1,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function rowToExecution(r: typeof executions.$inferSelect): StoredExecution {
  let principal: Principal | null = null;
  try {
    const p = r.principal;
    if (p && typeof p === 'object' && typeof (p as any).sub === 'string') principal = p as Principal;
  } catch { /* ignore */ }
  return {
    id: String(r.id),
    workflow_id: String(r.workflowId || ''),
    workflow_name: String(r.workflowName || ''),
    status: r.status === 'error' ? 'error' : r.status === 'running' ? 'running' : 'success',
    input: r.input ?? {},
    output: r.output ?? null,
    node_runs: Array.isArray(r.nodeRuns) ? r.nodeRuns : [],
    error: r.error ?? null,
    triggered_by: String(r.triggeredBy || 'manual'),
    principal,
    actor: r.actor != null ? String(r.actor) : null,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
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
  if (db) {
    await ensureTables();
    const rows = await db.insert(workflows).values({
      id: rec.id,
      name: rec.name,
      nodes: rec.nodes,
      connections: rec.connections,
      settings: rec.settings,
      active: rec.active,
      orgId: rec.org_id,
      accountId: rec.account_id,
      ownerSub: rec.owner_sub,
      runAs: rec.run_as,
      revision: 1,
    }).returning();
    return rowToWorkflow(rows[0]);
  }
  memWorkflows.set(rec.id, rec);
  return rec;
}

export async function getWorkflowRec(id: string): Promise<StoredWorkflow | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    return rows[0] ? rowToWorkflow(rows[0]) : null;
  }
  return memWorkflows.get(id) || null;
}

export async function listWorkflowRecs(filter?: { orgId?: string; accountId?: string }): Promise<StoredWorkflow[]> {
  if (db) {
    await ensureTables();
    const conds = [];
    if (filter?.orgId) conds.push(eq(workflows.orgId, filter.orgId));
    if (filter?.accountId) conds.push(eq(workflows.accountId, filter.accountId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(workflows).where(where).orderBy(asc(workflows.createdAt));
    return rows.map(rowToWorkflow);
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
  if (db) {
    await ensureTables();
    const cur = await getWorkflowRec(id);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      nodes: patch.nodes ?? cur.nodes,
      connections: patch.connections ?? cur.connections,
      settings: patch.settings ?? cur.settings,
      active: patch.active ?? cur.active,
      orgId: patch.org_id !== undefined ? cleanTenant(patch.org_id) : cur.org_id,
      accountId: patch.account_id !== undefined ? cleanTenant(patch.account_id) : cur.account_id,
      runAs: patch.run_as !== undefined ? cleanTenant(patch.run_as) : cur.run_as,
    };
    const rows = await db.update(workflows).set({
      ...next,
      revision: sql`${workflows.revision} + 1`,
      updatedAt: new Date(),
    }).where(eq(workflows.id, id)).returning();
    return rows[0] ? rowToWorkflow(rows[0]) : null;
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
  if (db) {
    await ensureTables();
    const rows = await db.delete(workflows).where(eq(workflows.id, id)).returning({ id: workflows.id });
    return rows.length > 0;
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
  if (db) {
    await ensureTables();
    const rows = await db.insert(executions).values({
      id: rec.id,
      workflowId: rec.workflow_id,
      workflowName: rec.workflow_name,
      status: rec.status,
      input: rec.input ?? {},
      output: rec.output ?? null,
      nodeRuns: rec.node_runs ?? [],
      error: rec.error,
      triggeredBy: rec.triggered_by,
      principal: rec.principal,
      actor: rec.actor,
      startedAt: new Date(rec.startedAt),
      finishedAt: new Date(rec.finishedAt),
    }).returning();
    return rowToExecution(rows[0]);
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
  if (db) {
    await ensureTables();
    const rows = await db.select().from(executions).where(eq(executions.id, id)).limit(1);
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
  return memExecutions.get(id) || null;
}

export async function listExecutionRecs(opts: {
  workflowId?: string;
  status?: string;
  triggeredBy?: string;
  /** Tenant filters (P0-3/#6): match the principal snapshot stored at run time. */
  orgId?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: StoredExecution[]; total?: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (db) {
    await ensureTables();
    const conds = [];
    if (opts.workflowId) conds.push(eq(executions.workflowId, opts.workflowId));
    if (opts.status) conds.push(eq(executions.status, opts.status));
    if (opts.triggeredBy) conds.push(eq(executions.triggeredBy, opts.triggeredBy));
    if (opts.orgId) conds.push(sql`${executions.principal}->>'org' = ${opts.orgId}`);
    if (opts.accountId) conds.push(sql`${executions.principal}->>'account' = ${opts.accountId}`);
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(executions)
      .where(where)
      .orderBy(desc(executions.startedAt))
      .limit(limit)
      .offset(offset);
    return { items: rows.map(rowToExecution) };
  }
  let arr = memExecOrder.map((id) => memExecutions.get(id)!).filter(Boolean);
  if (opts.workflowId) arr = arr.filter((e) => e.workflow_id === opts.workflowId);
  if (opts.status) arr = arr.filter((e) => e.status === opts.status);
  if (opts.triggeredBy) arr = arr.filter((e) => e.triggered_by === opts.triggeredBy);
  if (opts.orgId) arr = arr.filter((e) => (e.principal?.org || null) === opts.orgId);
  if (opts.accountId) arr = arr.filter((e) => (e.principal?.account || null) === opts.accountId);
  return { items: arr.slice(offset, offset + limit) };
}

export async function findActiveWebhookWorkflow(path: string): Promise<StoredWorkflow | null> {
  const clean = String(path || '').replace(/^\/+|\/+$/g, '');
  if (!clean) return null;
  const all = await listWorkflowRecs();
  for (const w of all) {
    if (!w.active) continue;
    for (const n of w.nodes || []) {
      if (!isWebhookType((n as any)?.type)) continue;
      const p = String((n as any)?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
      if (p === clean) return w;
    }
  }
  return null;
}

export async function listActiveCronWorkflows(): Promise<StoredWorkflow[]> {
  const all = await listWorkflowRecs();
  return all.filter((w) => w.active && (w.nodes || []).some((n) => isCronType((n as any)?.type)));
}

// ---------- credentials (P0-4): account-scoped secrets, encrypted at rest ----------

export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'hmac';

export interface StoredCredential {
  id: string;
  account_id: string;
  /** Owning org (P0-4/#5): null only for legacy/anonymous dev credentials. */
  org_id?: string | null;
  name: string;
  kind: CredentialKind;
  /** AES-256-GCM envelope: {iv, tag, data} base64 (never the raw secret). */
  secret_enc: string;
  created_at: string;
  updated_at: string;
}

/** Kept for callers/back-compat; credentials are part of the same migration set. */
export async function ensureCredentialTables(): Promise<void> {
  await ensureTables();
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

function rowToCredential(r: typeof credentials.$inferSelect): StoredCredential {
  return {
    id: String(r.id),
    account_id: String(r.accountId || ''),
    org_id: r.orgId ? String(r.orgId) : null,
    name: String(r.name || ''),
    kind: (['bearer', 'api-key', 'basic', 'hmac'].includes(r.kind) ? r.kind : 'bearer') as CredentialKind,
    secret_enc: String(r.secretEnc || ''),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

/** Public metadata shape — never includes secret material. */
export function toPublicCredential(c: StoredCredential): any {
  return { id: c.id, accountId: c.account_id, name: c.name, kind: c.kind, createdAt: c.created_at, updatedAt: c.updated_at };
}

export async function createCredentialRec(data: { account_id: string; org_id?: string | null; name: string; kind: CredentialKind; secret: string }): Promise<StoredCredential> {
  const rec: StoredCredential = {
    id: randomUUID(), account_id: data.account_id, org_id: data.org_id ?? null, name: data.name, kind: data.kind,
    secret_enc: encryptSecret(data.secret), created_at: nowIso(), updated_at: nowIso(),
  };
  if (db) {
    await ensureCredentialTables();
    try {
      const rows = await db.insert(credentials).values({
        id: rec.id,
        accountId: rec.account_id,
        orgId: rec.org_id,
        name: rec.name,
        kind: rec.kind,
        secretEnc: rec.secret_enc,
      }).returning();
      return rowToCredential(rows[0]);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        throw Object.assign(new Error(`credential name '${data.name}' already exists in this account`), { code: 'conflict' });
      }
      throw e;
    }
  }
  for (const c of memCredentials.values()) {
    if (c.account_id === rec.account_id && c.name === rec.name) {
      throw Object.assign(new Error(`credential name '${data.name}' already exists in this account`), { code: 'conflict' });
    }
  }
  memCredentials.set(rec.id, rec);
  return rec;
}

export async function getCredentialRec(id: string): Promise<StoredCredential | null> {
  if (db) {
    await ensureCredentialTables();
    const rows = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1);
    return rows[0] ? rowToCredential(rows[0]) : null;
  }
  return memCredentials.get(id) || null;
}

/** List credential metadata. `accountId` narrows by owning account; `orgId`
 *  (P0-4/#5) narrows by owning org — org-scoped callers must not see legacy
 *  rows without an org binding. */
export async function listCredentialRecs(accountId?: string, orgId?: string): Promise<StoredCredential[]> {
  if (db) {
    await ensureCredentialTables();
    const conds = [];
    if (accountId) conds.push(eq(credentials.accountId, accountId));
    if (orgId) conds.push(eq(credentials.orgId, orgId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(credentials).where(where).orderBy(asc(credentials.createdAt));
    return rows.map(rowToCredential);
  }
  let arr = [...memCredentials.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (accountId) arr = arr.filter((c) => c.account_id === accountId);
  if (orgId) arr = arr.filter((c) => (c.org_id || null) === orgId);
  return arr;
}

export async function deleteCredentialRec(id: string): Promise<boolean> {
  if (db) {
    await ensureCredentialTables();
    const rows = await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id });
    return rows.length > 0;
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
