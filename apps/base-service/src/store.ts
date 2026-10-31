/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseBase persistence — Drizzle ORM on Postgres with in-memory fallback
 * (dev/test). Tables and indexes are defined in ./schema.ts and applied by
 * versioned Drizzle migrations.
 */
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { BaseMapping, cloneJson, deepMerge, getPath, setPath } from './mapping';
import { baseCollections, baseDocuments, baseVectors } from './schema';
import { VectorSearchSpec, VectorSearchResult, applyVectorSearch } from './query';

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
let db: NodePgDatabase<typeof import('./schema')> | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[base][db] pool error', e.message));
  db = drizzle(pool, { schema: { baseCollections, baseDocuments, baseVectors } });
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
      const migrationDb = drizzle(client, { schema: { baseCollections, baseDocuments, baseVectors } });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapseone_base_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_base',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapseone_base_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[base][db] migrations failed:', e?.message || e);
  }
}

export function useDb(): boolean {
  return !!db;
}

function nowIso(): string {
  return new Date().toISOString();
}

function iso(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : nowIso();
}

function rowToCollection(r: typeof baseCollections.$inferSelect): StoredCollection {
  return {
    id: String(r.id),
    name: String(r.name || ''),
    description: r.description != null ? String(r.description) : null,
    mapping: r.mapping && typeof r.mapping === 'object' ? (r.mapping as BaseMapping) : { fields: {} },
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    created_by: r.createdBy != null ? String(r.createdBy) : null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function rowToDocument(r: typeof baseDocuments.$inferSelect): StoredDocument {
  return {
    collection_id: String(r.collectionId),
    id: String(r.id),
    data: r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {},
    version: Number(r.version) || 1,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function isUniqueViolation(e: any): boolean {
  return String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message));
}

// ---- in-memory fallback ----
const memCollections = new Map<string, StoredCollection>();
const memDocuments = new Map<string, Map<string, StoredDocument>>(); // collectionId -> id -> doc

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
  if (db) {
    await ensureTables();
    const rows = await db.insert(baseCollections).values({
      id: rec.id,
      name: rec.name,
      description: rec.description,
      mapping: rec.mapping,
      orgId: rec.org_id,
      accountId: rec.account_id,
      createdBy: rec.created_by,
    }).onConflictDoNothing().returning();
    if (!rows[0]) throw new StoreError('conflict', `collection '${input.name}' already exists in this scope`);
    return rowToCollection(rows[0]);
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
  if (db) {
    await ensureTables();
    let where;
    if (scope.platform && !scope.org_id && !scope.account_id) {
      where = and(eq(baseCollections.name, name), isNull(baseCollections.orgId), isNull(baseCollections.accountId));
    } else if (scope.org_id) {
      where = and(eq(baseCollections.name, name), eq(baseCollections.orgId, scope.org_id));
    } else {
      where = and(
        eq(baseCollections.name, name),
        isNull(baseCollections.orgId),
        eq(baseCollections.accountId, scope.account_id ?? ''),
      );
    }
    const rows = await db.select().from(baseCollections).where(where).orderBy(asc(baseCollections.createdAt)).limit(2);
    if (rows.length > 1) {
      throw new StoreError('conflict', `collection '${name}' is ambiguous in this org; add accountId to disambiguate`);
    }
    return rows[0] ? rowToCollection(rows[0]) : null;
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
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseCollections).where(eq(baseCollections.id, id)).limit(1);
    return rows[0] ? rowToCollection(rows[0]) : null;
  }
  return memCollections.get(id) || null;
}

export async function listCollectionRecs(): Promise<StoredCollection[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseCollections).orderBy(asc(baseCollections.name), asc(baseCollections.createdAt));
    return rows.map(rowToCollection);
  }
  return [...memCollections.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function updateCollectionRec(
  id: string,
  patch: { name?: string; description?: string | null; mapping?: BaseMapping },
): Promise<StoredCollection | null> {
  if (db) {
    await ensureTables();
    const values: Partial<typeof baseCollections.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.mapping !== undefined) values.mapping = patch.mapping;
    try {
      const rows = await db.update(baseCollections).set(values).where(eq(baseCollections.id, id)).returning();
      return rows[0] ? rowToCollection(rows[0]) : null;
    } catch (e: any) {
      if (isUniqueViolation(e)) throw new StoreError('conflict', 'collection name already exists in this scope');
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
  if (db) {
    await ensureTables();
    const rows = await db.delete(baseCollections).where(eq(baseCollections.id, id)).returning({ id: baseCollections.id });
    return rows.length > 0;
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
  if (db) {
    await ensureTables();
    const rows = await db.insert(baseDocuments).values({
      collectionId,
      id,
      data: rec.data,
      version: 1,
    }).onConflictDoNothing().returning();
    if (!rows[0]) throw new StoreError('conflict', `document '${id}' already exists`);
    return rowToDocument(rows[0]);
  }
  const docs = memDocuments.get(collectionId) || new Map<string, StoredDocument>();
  if (docs.has(id)) throw new StoreError('conflict', `document '${id}' already exists`);
  memDocuments.set(collectionId, docs);
  docs.set(id, rec);
  return cloneJson(rec);
}

export async function getDocumentRec(collectionId: string, id: string): Promise<StoredDocument | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(baseDocuments)
      .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id)))
      .limit(1);
    return rows[0] ? rowToDocument(rows[0]) : null;
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
  if (db) {
    await ensureTables();
    const base = db.select().from(baseDocuments).where(
      opts.since
        ? and(eq(baseDocuments.collectionId, collectionId), gt(baseDocuments.updatedAt, new Date(opts.since)))
        : eq(baseDocuments.collectionId, collectionId),
    );
    const rows = opts.since
      ? await base.orderBy(asc(baseDocuments.updatedAt), asc(baseDocuments.id)).limit(limit)
      : await base.orderBy(asc(baseDocuments.id)).limit(limit);
    return rows.map(rowToDocument);
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
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const cur = await tx.select().from(baseDocuments)
        .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id)))
        .for('update')
        .limit(1);
      if (!cur[0]) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new StoreError('version_conflict', `document '${id}' does not exist`);
        }
        const rows = await tx.insert(baseDocuments).values({
          collectionId,
          id,
          data: cloneJson(data),
          version: 1,
        }).returning();
        return { doc: rowToDocument(rows[0]), created: true };
      }
      const prev = rowToDocument(cur[0]);
      if (opts.ifVersion !== undefined && prev.version !== opts.ifVersion) {
        throw new StoreError('version_conflict', `document version is ${prev.version}, expected ${opts.ifVersion}`);
      }
      const next = opts.merge ? deepMerge(prev.data, data) : cloneJson(data);
      const rows = await tx.update(baseDocuments).set({
        data: next,
        version: prev.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id))).returning();
      return { doc: rowToDocument(rows[0]), created: false };
    });
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
  if (db) {
    await ensureTables();
    if (opts.ifVersion !== undefined) {
      const rows = await db.delete(baseDocuments).where(and(
        eq(baseDocuments.collectionId, collectionId),
        eq(baseDocuments.id, id),
        eq(baseDocuments.version, opts.ifVersion),
      )).returning({ id: baseDocuments.id });
      if (rows.length > 0) return true;
      const exists = await getDocumentRec(collectionId, id);
      if (exists) throw new StoreError('version_conflict', `document version is ${exists.version}, expected ${opts.ifVersion}`);
      throw new StoreError('not_found', `document '${id}' not found`);
    }
    const rows = await db.delete(baseDocuments).where(and(
      eq(baseDocuments.collectionId, collectionId),
      eq(baseDocuments.id, id),
    )).returning({ id: baseDocuments.id });
    return rows.length > 0;
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
  if (db) {
    await ensureTables();
    return db.transaction(async (tx) => {
      const cur = await tx.select().from(baseDocuments)
        .where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id)))
        .for('update')
        .limit(1);
      let prev: StoredDocument;
      let created = false;
      if (!cur[0]) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new StoreError('version_conflict', `document '${id}' does not exist`);
        }
        prev = { collection_id: collectionId, id, data: {}, version: 0, created_at: nowIso(), updated_at: nowIso() };
        created = true;
      } else {
        prev = rowToDocument(cur[0]);
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
        const rows = await tx.insert(baseDocuments).values({
          collectionId,
          id,
          data: next,
          version: 1,
        }).returning();
        return rowToDocument(rows[0]);
      }
      const rows = await tx.update(baseDocuments).set({
        data: next,
        version: prev.version + 1,
        updatedAt: new Date(),
      }).where(and(eq(baseDocuments.collectionId, collectionId), eq(baseDocuments.id, id))).returning();
      return rowToDocument(rows[0]);
    });
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
  if (db) {
    await ensureTables();
    const rows = await db.select({
      documents: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(octet_length(${baseDocuments.data}::text)), 0)::bigint`,
      lastUpdatedAt: sql<Date | null>`max(${baseDocuments.updatedAt})`,
    }).from(baseDocuments).where(eq(baseDocuments.collectionId, collectionId));
    const row = rows[0] || {} as any;
    return {
      documents: Number(row.documents) || 0,
      bytes: Number(row.bytes) || 0,
      lastUpdatedAt: row.lastUpdatedAt ? iso(row.lastUpdatedAt) : null,
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

/** Vector search over collection documents with metadata filtering. */
export async function vectorSearchRec(
  collectionId: string,
  spec: VectorSearchSpec,
  mapping?: BaseMapping | null,
  scanLimit = 10000,
): Promise<VectorSearchResult> {
  const docs = await listDocumentRecs(collectionId, { scanLimit });
  return applyVectorSearch(docs, spec, mapping);
}

/** Test helper: wipe in-memory state (no effect when Postgres is configured). */
export function __clearBaseMem(): void {
  memCollections.clear();
  memDocuments.clear();
}
