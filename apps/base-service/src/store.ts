/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseBase persistence — Postgres with in-memory fallback (dev/test).
 * Tables are auto-created on boot (additive, idempotent).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { BaseMapping, cloneJson, deepMerge, getPath, setPath } from './mapping';

export interface StoredCollection {
  id: string;
  name: string;
  description: string | null;
  mapping: BaseMapping;
  org_id: string | null;
  account_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredDocument {
  collection_id: string;
  id: string;
  data: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export type StoreErrorCode = 'conflict' | 'version_conflict' | 'not_found' | 'invalid';

export class StoreError extends Error {
  code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'StoreError';
  }
}

const DATABASE_URL = process.env.DATABASE_URL || '';
let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[base][db] pool error', (e as any)?.message || e));
}

export function useDb(): boolean {
  return !!pool;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- in-memory fallback ----
const memCollections = new Map<string, StoredCollection>();
const memDocuments = new Map<string, Map<string, StoredDocument>>(); // collectionId -> id -> doc

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS synapsedx_base_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  mapping JSONB NOT NULL DEFAULT '{"fields":{}}',
  org_id TEXT,
  account_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_base_collections_scope_name
  ON synapsedx_base_collections (COALESCE(org_id, ''), COALESCE(account_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_base_collections_tenant
  ON synapsedx_base_collections (org_id, account_id);

CREATE TABLE IF NOT EXISTS synapsedx_base_documents (
  collection_id TEXT NOT NULL REFERENCES synapsedx_base_collections(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, id)
);
CREATE INDEX IF NOT EXISTS idx_base_documents_updated
  ON synapsedx_base_documents (collection_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_base_documents_data
  ON synapsedx_base_documents USING GIN (data jsonb_path_ops);
`;

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!pool || ensured) return;
  ensured = true;
  try {
    await pool.query(CREATE_SQL);
  } catch (e: any) {
    ensured = false;
    console.error('[base][db] ensureTables failed:', e?.message || e);
  }
}

function rowToCollection(r: any): StoredCollection {
  let mapping: BaseMapping = { fields: {} };
  if (r.mapping && typeof r.mapping === 'object' && !Array.isArray(r.mapping)) {
    mapping = r.mapping as BaseMapping;
  }
  return {
    id: String(r.id),
    name: String(r.name || ''),
    description: r.description != null ? String(r.description) : null,
    mapping,
    org_id: r.org_id != null ? String(r.org_id) : null,
    account_id: r.account_id != null ? String(r.account_id) : null,
    created_by: r.created_by != null ? String(r.created_by) : null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || nowIso()),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || nowIso()),
  };
}

function rowToDocument(r: any): StoredDocument {
  return {
    collection_id: String(r.collection_id),
    id: String(r.id),
    data: r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {},
    version: Number(r.version) || 1,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || nowIso()),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || nowIso()),
  };
}

// ---------- collections ----------

function sameScope(a: { org_id?: string | null; account_id?: string | null }, b: { org_id?: string | null; account_id?: string | null }): boolean {
  return (a.org_id || '') === (b.org_id || '') && (a.account_id || '') === (b.account_id || '');
}

export async function createCollectionRec(input: {
  name: string;
  description?: string | null;
  mapping: BaseMapping;
  org_id?: string | null;
  account_id?: string | null;
  created_by?: string | null;
}): Promise<StoredCollection> {
  const rec: StoredCollection = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    mapping: input.mapping,
    org_id: input.org_id ?? null,
    account_id: input.account_id ?? null,
    created_by: input.created_by ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (pool) {
    await ensureTables();
    try {
      const r = await pool.query(
        `INSERT INTO synapsedx_base_collections (id, name, description, mapping, org_id, account_id, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
        [rec.id, rec.name, rec.description, JSON.stringify(rec.mapping), rec.org_id, rec.account_id, rec.created_by],
      );
      return rowToCollection(r.rows[0]);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        throw new StoreError('conflict', `collection '${input.name}' already exists in this scope`);
      }
      throw e;
    }
  }
  for (const c of memCollections.values()) {
    if (c.name === rec.name && sameScope(c, rec)) {
      throw new StoreError('conflict', `collection '${input.name}' already exists in this scope`);
    }
  }
  memCollections.set(rec.id, rec);
  return rec;
}

/**
 * Resolve a collection by name inside a caller scope.
 *  - org callers: any collection owned by that org (account is informational);
 *  - account-only callers: unbound-org, account-owned collections;
 *  - platform callers: an explicit org/account scope, otherwise unbound tables.
 */
export async function findCollectionRec(
  name: string,
  scope: { org_id?: string | null; account_id?: string | null; platform?: boolean },
): Promise<StoredCollection | null> {
  if (pool) {
    await ensureTables();
    let r;
    if (scope.platform && !scope.org_id && !scope.account_id) {
      r = await pool.query(
        `SELECT * FROM synapsedx_base_collections WHERE name=$1 AND org_id IS NULL AND account_id IS NULL
         ORDER BY created_at ASC LIMIT 2`,
        [name],
      );
    } else if (scope.org_id) {
      r = await pool.query(
        `SELECT * FROM synapsedx_base_collections WHERE name=$1 AND org_id=$2 ORDER BY created_at ASC LIMIT 2`,
        [name, scope.org_id],
      );
    } else {
      r = await pool.query(
        `SELECT * FROM synapsedx_base_collections WHERE name=$1 AND org_id IS NULL AND account_id=$2
         ORDER BY created_at ASC LIMIT 2`,
        [name, scope.account_id ?? ''],
      );
    }
    if (r.rows.length > 1) {
      throw new StoreError('conflict', `collection '${name}' is ambiguous in this org; add accountId to disambiguate`);
    }
    return r.rows[0] ? rowToCollection(r.rows[0]) : null;
  }
  const candidates = [...memCollections.values()].filter((c) => {
    if (c.name !== name) return false;
    if (scope.platform && !scope.org_id && !scope.account_id) return !c.org_id && !c.account_id;
    if (scope.org_id) return c.org_id === scope.org_id;
    return !c.org_id && c.account_id === (scope.account_id ?? '');
  });
  if (candidates.length > 1) {
    throw new StoreError('conflict', `collection '${name}' is ambiguous in this org; add accountId to disambiguate`);
  }
  return candidates[0] || null;
}

export async function getCollectionRec(id: string): Promise<StoredCollection | null> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('SELECT * FROM synapsedx_base_collections WHERE id=$1', [id]);
    return r.rows[0] ? rowToCollection(r.rows[0]) : null;
  }
  return memCollections.get(id) || null;
}

export async function listCollectionRecs(): Promise<StoredCollection[]> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('SELECT * FROM synapsedx_base_collections ORDER BY name ASC, created_at ASC');
    return r.rows.map(rowToCollection);
  }
  return [...memCollections.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateCollectionRec(
  id: string,
  patch: { name?: string; description?: string | null; mapping?: BaseMapping },
): Promise<StoredCollection | null> {
  if (pool) {
    await ensureTables();
    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (patch.name !== undefined) { sets.push(`name=$${i++}`); vals.push(patch.name); }
    if (patch.description !== undefined) { sets.push(`description=$${i++}`); vals.push(patch.description); }
    if (patch.mapping !== undefined) { sets.push(`mapping=$${i++}::jsonb`); vals.push(JSON.stringify(patch.mapping)); }
    if (!sets.length) return getCollectionRec(id);
    vals.push(id);
    try {
      const r = await pool.query(
        `UPDATE synapsedx_base_collections SET ${sets.join(', ')}, updated_at=now() WHERE id=$${i} RETURNING *`,
        vals,
      );
      return r.rows[0] ? rowToCollection(r.rows[0]) : null;
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        throw new StoreError('conflict', 'collection name already exists in this scope');
      }
      throw e;
    }
  }
  const cur = memCollections.get(id);
  if (!cur) return null;
  if (patch.name !== undefined && patch.name !== cur.name) {
    for (const c of memCollections.values()) {
      if (c.id !== id && c.name === patch.name && sameScope(c, cur)) {
        throw new StoreError('conflict', 'collection name already exists in this scope');
      }
    }
  }
  const next: StoredCollection = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.mapping !== undefined ? { mapping: patch.mapping } : {}),
    updated_at: nowIso(),
  };
  memCollections.set(id, next);
  return next;
}

export async function deleteCollectionRec(id: string): Promise<boolean> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('DELETE FROM synapsedx_base_collections WHERE id=$1', [id]);
    return (r.rowCount || 0) > 0;
  }
  memDocuments.delete(id);
  return memCollections.delete(id);
}

// ---------- documents ----------

export async function createDocumentRec(
  collectionId: string,
  id: string,
  data: Record<string, unknown>,
): Promise<StoredDocument> {
  const rec: StoredDocument = {
    collection_id: collectionId,
    id,
    data: cloneJson(data),
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (pool) {
    await ensureTables();
    try {
      const r = await pool.query(
        `INSERT INTO synapsedx_base_documents (collection_id, id, data, version)
         VALUES ($1,$2,$3::jsonb,1) RETURNING *`,
        [collectionId, id, JSON.stringify(rec.data)],
      );
      return rowToDocument(r.rows[0]);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        throw new StoreError('conflict', `document '${id}' already exists`);
      }
      throw e;
    }
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  if (docs.has(id)) throw new StoreError('conflict', `document '${id}' already exists`);
  memDocuments.set(collectionId, docs);
  docs.set(id, rec);
  return cloneJson(rec);
}

export async function getDocumentRec(collectionId: string, id: string): Promise<StoredDocument | null> {
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      'SELECT * FROM synapsedx_base_documents WHERE collection_id=$1 AND id=$2',
      [collectionId, id],
    );
    return r.rows[0] ? rowToDocument(r.rows[0]) : null;
  }
  const rec = memDocuments.get(collectionId)?.get(id);
  return rec ? cloneJson(rec) : null;
}

/** List documents (optionally changed after `since`) for the in-service query engine. */
export async function listDocumentRecs(
  collectionId: string,
  opts: { since?: string; scanLimit?: number } = {},
): Promise<StoredDocument[]> {
  const limit = Math.min(Math.max(Number(opts.scanLimit) || 10001, 1), 50001);
  if (pool) {
    await ensureTables();
    const r = opts.since
      ? await pool.query(
          `SELECT * FROM synapsedx_base_documents WHERE collection_id=$1 AND updated_at > $2::timestamptz
           ORDER BY updated_at ASC, id ASC LIMIT $3`,
          [collectionId, opts.since, limit],
        )
      : await pool.query(
          `SELECT * FROM synapsedx_base_documents WHERE collection_id=$1 ORDER BY id ASC LIMIT $2`,
          [collectionId, limit],
        );
    return r.rows.map(rowToDocument);
  }
  let docs = [...(memDocuments.get(collectionId)?.values() || [])];
  if (opts.since) {
    const since = Date.parse(opts.since);
    docs = docs.filter((d) => Date.parse(d.updated_at) > since);
    docs.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
  } else {
    docs.sort((a, b) => a.id.localeCompare(b.id));
  }
  return docs.slice(0, limit).map(cloneJson);
}

export async function setDocumentRec(
  collectionId: string,
  id: string,
  data: Record<string, unknown>,
  opts: { merge?: boolean; ifVersion?: number } = {},
): Promise<{ doc: StoredDocument; created: boolean }> {
  if (pool) {
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM synapsedx_base_documents WHERE collection_id=$1 AND id=$2 FOR UPDATE',
        [collectionId, id],
      );
      if (!cur.rows[0]) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new StoreError('version_conflict', `document '${id}' does not exist`);
        }
        const r = await client.query(
          `INSERT INTO synapsedx_base_documents (collection_id, id, data, version)
           VALUES ($1,$2,$3::jsonb,1) RETURNING *`,
          [collectionId, id, JSON.stringify(data)],
        );
        await client.query('COMMIT');
        return { doc: rowToDocument(r.rows[0]), created: true };
      }
      const prev = rowToDocument(cur.rows[0]);
      if (opts.ifVersion !== undefined && prev.version !== opts.ifVersion) {
        throw new StoreError('version_conflict', `document version is ${prev.version}, expected ${opts.ifVersion}`);
      }
      const next = opts.merge ? deepMerge(prev.data, data) : cloneJson(data);
      const r = await client.query(
        `UPDATE synapsedx_base_documents SET data=$3::jsonb, version=version+1, updated_at=now()
         WHERE collection_id=$1 AND id=$2 RETURNING *`,
        [collectionId, id, JSON.stringify(next)],
      );
      await client.query('COMMIT');
      return { doc: rowToDocument(r.rows[0]), created: false };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection gone */ }
      throw e;
    } finally {
      client.release();
    }
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  const cur = docs.get(id);
  if (!cur) {
    if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
      throw new StoreError('version_conflict', `document '${id}' does not exist`);
    }
    const rec: StoredDocument = {
      collection_id: collectionId,
      id,
      data: cloneJson(data),
      version: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    memDocuments.set(collectionId, docs);
    docs.set(id, rec);
    return { doc: cloneJson(rec), created: true };
  }
  if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
    throw new StoreError('version_conflict', `document version is ${cur.version}, expected ${opts.ifVersion}`);
  }
  const rec: StoredDocument = {
    ...cur,
    data: opts.merge ? deepMerge(cur.data, data) : cloneJson(data),
    version: cur.version + 1,
    updated_at: nowIso(),
  };
  docs.set(id, rec);
  return { doc: cloneJson(rec), created: false };
}

export async function deleteDocumentRec(
  collectionId: string,
  id: string,
  opts: { ifVersion?: number } = {},
): Promise<boolean> {
  if (pool) {
    await ensureTables();
    if (opts.ifVersion !== undefined) {
      const r = await pool.query(
        'DELETE FROM synapsedx_base_documents WHERE collection_id=$1 AND id=$2 AND version=$3',
        [collectionId, id, opts.ifVersion],
      );
      if ((r.rowCount || 0) > 0) return true;
      const exists = await getDocumentRec(collectionId, id);
      if (exists) throw new StoreError('version_conflict', `document version is ${exists.version}, expected ${opts.ifVersion}`);
      throw new StoreError('not_found', `document '${id}' not found`);
    }
    const r = await pool.query(
      'DELETE FROM synapsedx_base_documents WHERE collection_id=$1 AND id=$2',
      [collectionId, id],
    );
    return (r.rowCount || 0) > 0;
  }
  const docs = memDocuments.get(collectionId);
  const cur = docs?.get(id);
  if (!cur) throw new StoreError('not_found', `document '${id}' not found`);
  if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
    throw new StoreError('version_conflict', `document version is ${cur.version}, expected ${opts.ifVersion}`);
  }
  return !!docs!.delete(id);
}

export async function incrementDocumentRec(
  collectionId: string,
  id: string,
  field: string,
  by: number,
  opts: { ifVersion?: number } = {},
): Promise<StoredDocument> {
  if (pool) {
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM synapsedx_base_documents WHERE collection_id=$1 AND id=$2 FOR UPDATE',
        [collectionId, id],
      );
      let prev: StoredDocument;
      let created = false;
      if (!cur.rows[0]) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new StoreError('version_conflict', `document '${id}' does not exist`);
        }
        prev = { collection_id: collectionId, id, data: {}, version: 0, created_at: nowIso(), updated_at: nowIso() };
        created = true;
      } else {
        prev = rowToDocument(cur.rows[0]);
        if (opts.ifVersion !== undefined && prev.version !== opts.ifVersion) {
          throw new StoreError('version_conflict', `document version is ${prev.version}, expected ${opts.ifVersion}`);
        }
      }
      const current = getPath(prev.data, field);
      if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current))) {
        throw new StoreError('invalid', `field '${field}' is not numeric`);
      }
      const next = deepMerge(prev.data, {});
      setPath(next, field, (typeof current === 'number' ? current : 0) + by);
      if (created) {
        const r = await client.query(
          `INSERT INTO synapsedx_base_documents (collection_id, id, data, version)
           VALUES ($1,$2,$3::jsonb,1) RETURNING *`,
          [collectionId, id, JSON.stringify(next)],
        );
        await client.query('COMMIT');
        return rowToDocument(r.rows[0]);
      }
      const r = await client.query(
        `UPDATE synapsedx_base_documents SET data=$3::jsonb, version=version+1, updated_at=now()
         WHERE collection_id=$1 AND id=$2 RETURNING *`,
        [collectionId, id, JSON.stringify(next)],
      );
      await client.query('COMMIT');
      return rowToDocument(r.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection gone */ }
      throw e;
    } finally {
      client.release();
    }
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  const cur = docs.get(id);
  if (cur && opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
    throw new StoreError('version_conflict', `document version is ${cur.version}, expected ${opts.ifVersion}`);
  }
  const current = cur ? getPath(cur.data, field) : undefined;
  if (current !== undefined && (typeof current !== 'number' || !Number.isFinite(current))) {
    throw new StoreError('invalid', `field '${field}' is not numeric`);
  }
  const data = deepMerge(cur?.data || {}, {});
  setPath(data, field, (typeof current === 'number' ? current : 0) + by);
  const rec: StoredDocument = cur
    ? { ...cur, data, version: cur.version + 1, updated_at: nowIso() }
    : { collection_id: collectionId, id, data, version: 1, created_at: nowIso(), updated_at: nowIso() };
  memDocuments.set(collectionId, docs);
  docs.set(id, rec);
  return cloneJson(rec);
}

export async function documentStatsRec(collectionId: string): Promise<{ documents: number; bytes: number; lastUpdatedAt: string | null }> {
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      `SELECT COUNT(*)::int AS documents,
              COALESCE(SUM(octet_length(data::text)), 0)::bigint AS bytes,
              MAX(updated_at) AS last_updated
       FROM synapsedx_base_documents WHERE collection_id=$1`,
      [collectionId],
    );
    const row = r.rows[0] || {};
    return {
      documents: Number(row.documents) || 0,
      bytes: Number(row.bytes) || 0,
      lastUpdatedAt: row.last_updated ? new Date(row.last_updated).toISOString() : null,
    };
  }
  const docs = [...(memDocuments.get(collectionId)?.values() || [])];
  let bytes = 0;
  let last: string | null = null;
  for (const d of docs) {
    bytes += Buffer.byteLength(JSON.stringify(d.data), 'utf8');
    if (!last || d.updated_at > last) last = d.updated_at;
  }
  return { documents: docs.length, bytes, lastUpdatedAt: last };
}

/** Test helper: wipe in-memory state (no effect when Postgres is configured). */
export function __clearBaseMem(): void {
  memCollections.clear();
  memDocuments.clear();
}
