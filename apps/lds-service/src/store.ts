/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseLDS persistence — Drizzle ORM on Postgres with in-memory fallback
 * (dev/test). Tables/indexes live in ./schema.ts and are applied by versioned
 * Drizzle migrations.
 */
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { RegistryAttribute, StoredRecord } from './projector';
import { ldsAttributes, ldsDatasources, ldsRecords } from './schema';

export interface StoredDatasource {
  id: string;
  slug: string;
  name: string;
  entity_type: string;
  license: string;
  license_url: string | null;
  contexts: string[];
  default_visibility: 'public' | 'internal';
  description: string | null;
  org_id: string | null;
  account_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const DATABASE_URL = process.env.DATABASE_URL || '';
let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[lds][db] pool error', (e as any)?.message || e));
}
const db = pool ? drizzle(pool, { schema: { ldsAttributes, ldsDatasources, ldsRecords } }) : null;

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

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!db || ensured) return;
  ensured = true;
  try {
    const client = await pool!.connect();
    try {
      // Hold the advisory lock on the same dedicated session that runs the
      // migration (pool connections are not guaranteed to be reused).
      const migrationDb = drizzle(client, { schema: { ldsAttributes, ldsDatasources, ldsRecords } });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapsedx_lds_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_lds',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapsedx_lds_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[lds][db] migrations failed:', e?.message || e);
  }
}

// ---- in-memory fallback ----
const memDatasources = new Map<string, StoredDatasource>();
const memAttributes = new Map<string, Map<string, RegistryAttribute>>();
const memRecords = new Map<string, Map<string, StoredRecord>>(); // datasourceId -> entityId -> record

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'conflict' });
}

function isUniqueViolation(e: any): boolean {
  return String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message));
}

function rowToDatasource(r: typeof ldsDatasources.$inferSelect): StoredDatasource {
  return {
    id: String(r.id),
    slug: String(r.slug || ''),
    name: String(r.name || ''),
    entity_type: String(r.entityType || ''),
    license: String(r.license || ''),
    license_url: r.licenseUrl != null ? String(r.licenseUrl) : null,
    contexts: Array.isArray(r.contexts) ? r.contexts.map((x: any) => String(x)) : [],
    default_visibility: r.defaultVisibility === 'public' ? 'public' : 'internal',
    description: r.description != null ? String(r.description) : null,
    org_id: r.orgId != null ? String(r.orgId) : null,
    account_id: r.accountId != null ? String(r.accountId) : null,
    created_by: r.createdBy != null ? String(r.createdBy) : null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
  };
}

function rowToAttribute(r: typeof ldsAttributes.$inferSelect): RegistryAttribute {
  const out: RegistryAttribute = {
    name: String(r.name),
    ngsiLdType: ['Property', 'Relationship', 'GeoProperty'].includes(r.ngsiLdType) ? r.ngsiLdType as RegistryAttribute['ngsiLdType'] : 'Property',
    visibility: ['public', 'restricted', 'internal'].includes(r.visibility) ? r.visibility as RegistryAttribute['visibility'] : 'internal',
  };
  if (r.description != null) out.description = String(r.description);
  if (r.sourceField != null) out.sourceField = String(r.sourceField);
  return out;
}

function rowToRecord(r: typeof ldsRecords.$inferSelect): StoredRecord {
  return {
    datasourceId: String(r.datasourceId),
    entityId: String(r.entityId),
    sourceRecordId: r.sourceRecordId != null ? String(r.sourceRecordId) : null,
    version: Number(r.version) || 1,
    core: r.core && typeof r.core === 'object' ? r.core : {},
    entity: r.entity && typeof r.entity === 'object' ? r.entity : { id: String(r.entityId), type: '' },
    attributes: r.attributes && typeof r.attributes === 'object' ? r.attributes : {},
  };
}

// ---------- datasources ----------

export async function createDatasourceRec(data: {
  slug: string;
  name: string;
  entity_type: string;
  license: string;
  license_url?: string | null;
  contexts?: string[];
  default_visibility?: 'public' | 'internal';
  description?: string | null;
  org_id?: string | null;
  account_id?: string | null;
  created_by?: string | null;
}): Promise<StoredDatasource> {
  const rec: StoredDatasource = {
    id: randomUUID(),
    slug: data.slug,
    name: data.name,
    entity_type: data.entity_type,
    license: data.license,
    license_url: data.license_url ?? null,
    contexts: data.contexts || [],
    default_visibility: data.default_visibility === 'public' ? 'public' : 'internal',
    description: data.description ?? null,
    org_id: data.org_id ?? null,
    account_id: data.account_id ?? null,
    created_by: data.created_by ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (db) {
    await ensureTables();
    try {
      const rows = await db.insert(ldsDatasources).values({
        id: rec.id,
        slug: rec.slug,
        name: rec.name,
        entityType: rec.entity_type,
        license: rec.license,
        licenseUrl: rec.license_url,
        contexts: rec.contexts,
        defaultVisibility: rec.default_visibility,
        description: rec.description,
        orgId: rec.org_id,
        accountId: rec.account_id,
        createdBy: rec.created_by,
      }).returning();
      return rowToDatasource(rows[0]);
    } catch (e: any) {
      if (isUniqueViolation(e)) throw conflict(`datasource slug '${data.slug}' already exists in this scope`);
      throw e;
    }
  }
  for (const d of memDatasources.values()) {
    if ((d.org_id || '') === (rec.org_id || '') && d.slug === rec.slug) {
      throw conflict(`datasource slug '${data.slug}' already exists in this scope`);
    }
  }
  memDatasources.set(rec.id, rec);
  return rec;
}

export async function getDatasourceRec(id: string): Promise<StoredDatasource | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(ldsDatasources).where(eq(ldsDatasources.id, id)).limit(1);
    return rows[0] ? rowToDatasource(rows[0]) : null;
  }
  return memDatasources.get(id) || null;
}

export async function listDatasourceRecs(filter?: { orgId?: string; accountId?: string }): Promise<StoredDatasource[]> {
  if (db) {
    await ensureTables();
    const conds = [];
    if (filter?.orgId) conds.push(eq(ldsDatasources.orgId, filter.orgId));
    if (filter?.accountId) conds.push(eq(ldsDatasources.accountId, filter.accountId));
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(ldsDatasources).where(where).orderBy(asc(ldsDatasources.createdAt));
    return rows.map(rowToDatasource);
  }
  let arr = [...memDatasources.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (filter?.orgId) arr = arr.filter((d) => d.org_id === filter.orgId);
  if (filter?.accountId) arr = arr.filter((d) => d.account_id === filter.accountId);
  return arr;
}

export async function updateDatasourceRec(
  id: string,
  patch: Partial<Pick<StoredDatasource, 'slug' | 'name' | 'entity_type' | 'license' | 'license_url' | 'contexts' | 'default_visibility' | 'description'>>,
): Promise<StoredDatasource | null> {
  if (db) {
    await ensureTables();
    const values: Partial<typeof ldsDatasources.$inferInsert> = { updatedAt: new Date() };
    if (patch.slug !== undefined) values.slug = patch.slug;
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.entity_type !== undefined) values.entityType = patch.entity_type;
    if (patch.license !== undefined) values.license = patch.license;
    if (patch.license_url !== undefined) values.licenseUrl = patch.license_url;
    if (patch.contexts !== undefined) values.contexts = patch.contexts;
    if (patch.default_visibility !== undefined) values.defaultVisibility = patch.default_visibility;
    if (patch.description !== undefined) values.description = patch.description;
    try {
      const rows = await db.update(ldsDatasources).set(values).where(eq(ldsDatasources.id, id)).returning();
      return rows[0] ? rowToDatasource(rows[0]) : null;
    } catch (e: any) {
      if (isUniqueViolation(e)) throw conflict(`datasource slug '${patch.slug}' already exists in this scope`);
      throw e;
    }
  }
  const cur = memDatasources.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updated_at: nowIso() };
  memDatasources.set(id, next);
  return next;
}

export async function deleteDatasourceRec(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(ldsDatasources).where(eq(ldsDatasources.id, id)).returning({ id: ldsDatasources.id });
    return rows.length > 0; // attributes + records cascade
  }
  const existed = memDatasources.delete(id);
  memAttributes.delete(id);
  memRecords.delete(id);
  return existed;
}

// ---------- attribute registry ----------

export async function getAttributesRec(datasourceId: string): Promise<RegistryAttribute[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(ldsAttributes)
      .where(eq(ldsAttributes.datasourceId, datasourceId))
      .orderBy(asc(ldsAttributes.name));
    return rows.map(rowToAttribute);
  }
  return [...(memAttributes.get(datasourceId)?.values() || [])].sort((a, b) => a.name.localeCompare(b.name));
}

export async function replaceAttributesRec(datasourceId: string, attributes: RegistryAttribute[]): Promise<RegistryAttribute[]> {
  if (db) {
    await ensureTables();
    await db.transaction(async (tx) => {
      await tx.delete(ldsAttributes).where(eq(ldsAttributes.datasourceId, datasourceId));
      if (attributes.length > 0) {
        await tx.insert(ldsAttributes).values(attributes.map((a) => ({
          datasourceId,
          name: a.name,
          ngsiLdType: a.ngsiLdType,
          visibility: a.visibility,
          description: a.description ?? null,
          sourceField: a.sourceField ?? null,
        })));
      }
    });
    return getAttributesRec(datasourceId);
  }
  const m = new Map<string, RegistryAttribute>();
  for (const a of attributes) m.set(a.name, a);
  memAttributes.set(datasourceId, m);
  return getAttributesRec(datasourceId);
}

// ---------- records ----------

export async function upsertRecordRec(rec: StoredRecord): Promise<{ record: StoredRecord; created: boolean }> {
  const core = { ...(rec.core || {}) };
  if (!core.internalId) core.internalId = randomUUID();
  const stored: StoredRecord = { ...rec, core };
  if (db) {
    await ensureTables();
    // `attributes` is intentionally created with a null prototype in the
    // projector. Drizzle's type guard assumes Object.prototype exists, so pass
    // it a plain-object copy at the persistence boundary.
    const attributes = Object.assign({}, stored.attributes);
    const rows = await db.insert(ldsRecords).values({
      datasourceId: stored.datasourceId,
      entityId: stored.entityId,
      sourceRecordId: stored.sourceRecordId,
      version: stored.version,
      core: stored.core,
      entity: stored.entity,
      attributes,
    }).onConflictDoUpdate({
      target: [ldsRecords.datasourceId, ldsRecords.entityId],
      set: {
        sourceRecordId: sql`excluded.source_record_id`,
        // Atomic bump: concurrent ingests serialize here without losing versions.
        version: sql`${ldsRecords.version} + 1`,
        // Keep the existing private identity/timestamps; refresh the rest.
        core: sql`excluded.core || jsonb_build_object(
          'internalId', ${ldsRecords.core}->>'internalId',
          'createdAt', ${ldsRecords.core}->>'createdAt')`,
        entity: sql`excluded.entity`,
        attributes: sql`excluded.attributes`,
        updatedAt: sql`now()`,
      },
    }).returning({
      ...getTableColumns(ldsRecords),
      inserted: sql<boolean>`(xmax = 0)`,
    });
    return { record: rowToRecord(rows[0]), created: !!rows[0].inserted };
  }
  const m = memRecords.get(stored.datasourceId) || new Map<string, StoredRecord>();
  const created = !m.has(stored.entityId);
  m.set(stored.entityId, stored);
  memRecords.set(stored.datasourceId, m);
  return { record: stored, created };
}

export async function getRecordRec(datasourceId: string, entityId: string): Promise<StoredRecord | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select().from(ldsRecords).where(and(
      eq(ldsRecords.datasourceId, datasourceId),
      eq(ldsRecords.entityId, entityId),
    )).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }
  return memRecords.get(datasourceId)?.get(entityId) || null;
}

export async function listRecordRecs(
  datasourceId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: StoredRecord[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (db) {
    await ensureTables();
    const [rows, countRows] = await Promise.all([
      db.select().from(ldsRecords)
        .where(eq(ldsRecords.datasourceId, datasourceId))
        .orderBy(asc(ldsRecords.entityId))
        .limit(limit)
        .offset(offset),
      db.select({ n: sql<number>`count(*)::int` }).from(ldsRecords)
        .where(eq(ldsRecords.datasourceId, datasourceId)),
    ]);
    return { items: rows.map(rowToRecord), total: Number(countRows[0]?.n) || 0 };
  }
  const all = [...(memRecords.get(datasourceId)?.values() || [])].sort((a, b) => a.entityId.localeCompare(b.entityId));
  return { items: all.slice(offset, offset + limit), total: all.length };
}

export async function datasourceStatsRec(
  datasourceId: string,
): Promise<{ records: number; attributes: { public: number; restricted: number; internal: number }; lastIngestAt: string | null }> {
  const attrs = await getAttributesRec(datasourceId);
  const counts = { public: 0, restricted: 0, internal: 0 };
  for (const a of attrs) counts[a.visibility] = (counts[a.visibility] || 0) + 1;
  let records = 0;
  let lastIngestAt: string | null = null;
  if (db) {
    await ensureTables();
    const rows = await db.select({
      n: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${ldsRecords.updatedAt})`,
    }).from(ldsRecords).where(eq(ldsRecords.datasourceId, datasourceId));
    records = Number(rows[0]?.n) || 0;
    lastIngestAt = rows[0]?.last ? iso(rows[0].last) : null;
  } else {
    const all = [...(memRecords.get(datasourceId)?.values() || [])];
    records = all.length;
    for (const rec of all) {
      const t = rec.core?.updatedAt ? String(rec.core.updatedAt) : null;
      if (t && (!lastIngestAt || t > lastIngestAt)) lastIngestAt = t;
    }
  }
  return { records, attributes: counts, lastIngestAt };
}

export function __clearLdsMem(): void {
  memDatasources.clear();
  memAttributes.clear();
  memRecords.clear();
}
