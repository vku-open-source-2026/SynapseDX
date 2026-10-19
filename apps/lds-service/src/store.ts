/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseLDS persistence — Postgres with in-memory fallback (dev/test).
 * Tables are auto-created on boot (additive migrations, no data loss).
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { RegistryAttribute, StoredRecord } from './projector';

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

export function useDb(): boolean {
  return !!pool;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- in-memory fallback ----
const memDatasources = new Map<string, StoredDatasource>();
const memAttributes = new Map<string, Map<string, RegistryAttribute>>();
const memRecords = new Map<string, Map<string, StoredRecord>>(); // datasourceId -> entityId -> record

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS lds_datasources (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  license TEXT NOT NULL,
  license_url TEXT,
  contexts JSONB NOT NULL DEFAULT '[]',
  default_visibility TEXT NOT NULL DEFAULT 'internal',
  description TEXT,
  org_id TEXT,
  account_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lds_datasources_scope_slug
  ON lds_datasources (COALESCE(org_id, ''), slug);
CREATE INDEX IF NOT EXISTS idx_lds_datasources_tenant ON lds_datasources(org_id, account_id);

CREATE TABLE IF NOT EXISTS lds_attributes (
  datasource_id TEXT NOT NULL REFERENCES lds_datasources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ngsi_ld_type TEXT NOT NULL DEFAULT 'Property',
  visibility TEXT NOT NULL DEFAULT 'internal',
  description TEXT,
  source_field TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (datasource_id, name)
);

CREATE TABLE IF NOT EXISTS lds_records (
  datasource_id TEXT NOT NULL REFERENCES lds_datasources(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  source_record_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  core JSONB NOT NULL DEFAULT '{}',
  entity JSONB NOT NULL DEFAULT '{}',
  attributes JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (datasource_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_lds_records_ds ON lds_records(datasource_id, updated_at DESC);
`;

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!pool || ensured) return;
  ensured = true;
  try {
    await pool.query(CREATE_SQL);
  } catch (e: any) {
    ensured = false;
    console.error('[lds][db] ensureTables failed:', e?.message || e);
  }
}

function rowToDatasource(r: any): StoredDatasource {
  return {
    id: String(r.id),
    slug: String(r.slug || ''),
    name: String(r.name || ''),
    entity_type: String(r.entity_type || ''),
    license: String(r.license || ''),
    license_url: r.license_url != null ? String(r.license_url) : null,
    contexts: Array.isArray(r.contexts) ? r.contexts.map((x: any) => String(x)) : [],
    default_visibility: r.default_visibility === 'public' ? 'public' : 'internal',
    description: r.description != null ? String(r.description) : null,
    org_id: r.org_id != null ? String(r.org_id) : null,
    account_id: r.account_id != null ? String(r.account_id) : null,
    created_by: r.created_by != null ? String(r.created_by) : null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at || nowIso()),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at || nowIso()),
  };
}

function rowToAttribute(r: any): RegistryAttribute {
  const out: RegistryAttribute = {
    name: String(r.name),
    ngsiLdType: ['Property', 'Relationship', 'GeoProperty'].includes(r.ngsi_ld_type) ? r.ngsi_ld_type : 'Property',
    visibility: ['public', 'restricted', 'internal'].includes(r.visibility) ? r.visibility : 'internal',
  };
  if (r.description != null) out.description = String(r.description);
  if (r.source_field != null) out.sourceField = String(r.source_field);
  return out;
}

function rowToRecord(r: any): StoredRecord {
  return {
    datasourceId: String(r.datasource_id),
    entityId: String(r.entity_id),
    sourceRecordId: r.source_record_id != null ? String(r.source_record_id) : null,
    version: Number(r.version) || 1,
    core: r.core && typeof r.core === 'object' ? r.core : {},
    entity: r.entity && typeof r.entity === 'object' ? r.entity : { id: String(r.entity_id), type: '' },
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
  if (pool) {
    await ensureTables();
    try {
      const r = await pool.query(
        `INSERT INTO lds_datasources (id, slug, name, entity_type, license, license_url, contexts, default_visibility, description, org_id, account_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
         RETURNING *`,
        [rec.id, rec.slug, rec.name, rec.entity_type, rec.license, rec.license_url, JSON.stringify(rec.contexts),
          rec.default_visibility, rec.description, rec.org_id, rec.account_id, rec.created_by],
      );
      return rowToDatasource(r.rows[0]);
    } catch (e: any) {
      if (String(e?.code) === '23505' || /duplicate|unique/i.test(String(e?.message))) {
        const err = new Error(`datasource slug '${data.slug}' already exists in this scope`) as any;
        err.code = 'conflict';
        throw err;
      }
      throw e;
    }
  }
  for (const d of memDatasources.values()) {
    if ((d.org_id || '') === (rec.org_id || '') && d.slug === rec.slug) {
      const err = new Error(`datasource slug '${data.slug}' already exists in this scope`) as any;
      err.code = 'conflict';
      throw err;
    }
  }
  memDatasources.set(rec.id, rec);
  return rec;
}

export async function getDatasourceRec(id: string): Promise<StoredDatasource | null> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('SELECT * FROM lds_datasources WHERE id=$1', [id]);
    return r.rows[0] ? rowToDatasource(r.rows[0]) : null;
  }
  return memDatasources.get(id) || null;
}

export async function listDatasourceRecs(filter?: { orgId?: string; accountId?: string }): Promise<StoredDatasource[]> {
  if (pool) {
    await ensureTables();
    const conds: string[] = [];
    const params: any[] = [];
    if (filter?.orgId) { params.push(filter.orgId); conds.push(`org_id=$${params.length}`); }
    if (filter?.accountId) { params.push(filter.accountId); conds.push(`account_id=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM lds_datasources ${where} ORDER BY created_at ASC`, params);
    return r.rows.map(rowToDatasource);
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
  if (pool) {
    await ensureTables();
    const cur = await getDatasourceRec(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const r = await pool.query(
      `UPDATE lds_datasources SET slug=$2, name=$3, entity_type=$4, license=$5, license_url=$6, contexts=$7::jsonb,
        default_visibility=$8, description=$9, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, next.slug, next.name, next.entity_type, next.license, next.license_url, JSON.stringify(next.contexts),
        next.default_visibility, next.description],
    );
    return r.rows[0] ? rowToDatasource(r.rows[0]) : null;
  }
  const cur = memDatasources.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updated_at: nowIso() };
  memDatasources.set(id, next);
  return next;
}

export async function deleteDatasourceRec(id: string): Promise<boolean> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('DELETE FROM lds_datasources WHERE id=$1', [id]); // attributes + records cascade
    return (r.rowCount || 0) > 0;
  }
  const existed = memDatasources.delete(id);
  memAttributes.delete(id);
  memRecords.delete(id);
  return existed;
}

// ---------- attribute registry ----------

export async function getAttributesRec(datasourceId: string): Promise<RegistryAttribute[]> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('SELECT * FROM lds_attributes WHERE datasource_id=$1 ORDER BY name ASC', [datasourceId]);
    return r.rows.map(rowToAttribute);
  }
  return [...(memAttributes.get(datasourceId)?.values() || [])].sort((a, b) => a.name.localeCompare(b.name));
}

export async function replaceAttributesRec(datasourceId: string, attributes: RegistryAttribute[]): Promise<RegistryAttribute[]> {
  if (pool) {
    await ensureTables();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM lds_attributes WHERE datasource_id=$1', [datasourceId]);
      for (const a of attributes) {
        await client.query(
          `INSERT INTO lds_attributes (datasource_id, name, ngsi_ld_type, visibility, description, source_field)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [datasourceId, a.name, a.ngsiLdType, a.visibility, a.description ?? null, a.sourceField ?? null],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
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
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      `INSERT INTO lds_records (datasource_id, entity_id, source_record_id, version, core, entity, attributes)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)
       ON CONFLICT (datasource_id, entity_id) DO UPDATE SET
         source_record_id=EXCLUDED.source_record_id,
         -- Atomic bump: concurrent ingests can serialize here without losing
         -- versions (the read-modify-write in the caller is best-effort).
         version=lds_records.version + 1,
         -- Keep the existing private identity/timestamps; refresh the rest.
         core=EXCLUDED.core || jsonb_build_object(
           'internalId', lds_records.core->>'internalId',
           'createdAt', lds_records.core->>'createdAt'),
         entity=EXCLUDED.entity,
         attributes=EXCLUDED.attributes,
         updated_at=now()
       RETURNING *, (xmax = 0) AS inserted`,
      [stored.datasourceId, stored.entityId, stored.sourceRecordId, stored.version,
        JSON.stringify(stored.core), JSON.stringify(stored.entity), JSON.stringify(stored.attributes)],
    );
    return { record: rowToRecord(r.rows[0]), created: !!r.rows[0].inserted };
  }
  const m = memRecords.get(stored.datasourceId) || new Map<string, StoredRecord>();
  const created = !m.has(stored.entityId);
  m.set(stored.entityId, stored);
  memRecords.set(stored.datasourceId, m);
  return { record: stored, created };
}

export async function getRecordRec(datasourceId: string, entityId: string): Promise<StoredRecord | null> {
  if (pool) {
    await ensureTables();
    const r = await pool.query('SELECT * FROM lds_records WHERE datasource_id=$1 AND entity_id=$2', [datasourceId, entityId]);
    return r.rows[0] ? rowToRecord(r.rows[0]) : null;
  }
  return memRecords.get(datasourceId)?.get(entityId) || null;
}

export async function listRecordRecs(
  datasourceId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: StoredRecord[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (pool) {
    await ensureTables();
    const [r, c] = await Promise.all([
      pool.query(
        'SELECT * FROM lds_records WHERE datasource_id=$1 ORDER BY entity_id ASC LIMIT $2 OFFSET $3',
        [datasourceId, limit, offset],
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM lds_records WHERE datasource_id=$1', [datasourceId]),
    ]);
    return { items: r.rows.map(rowToRecord), total: c.rows[0]?.n ?? 0 };
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
  if (pool) {
    await ensureTables();
    const r = await pool.query(
      'SELECT COUNT(*)::int AS n, MAX(updated_at) AS last FROM lds_records WHERE datasource_id=$1',
      [datasourceId],
    );
    records = r.rows[0]?.n ?? 0;
    const last = r.rows[0]?.last;
    lastIngestAt = last instanceof Date ? last.toISOString() : last ? String(last) : null;
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
