/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * LDS (linked-data service) client: datasources, attributes, records,
 * NGSI-LD entities, stats and licenses.
 */

import { HttpClient } from './_http';

/** LDS attribute/datasource visibility (`internal` is settable but not listable via `?visibility`). */
export type LdsVisibility = 'public' | 'restricted' | 'internal';

/** NGSI-LD attribute types accepted by PUT /v1/lds/datasources/:id/attributes. */
export type LdsAttributeType = 'Property' | 'Relationship' | 'GeoProperty';

/** Body of POST /v1/lds/datasources; PATCH accepts a partial of this. */
export interface LdsDatasourceInput {
  name: string;
  slug?: string;
  entityType: string;
  license: string;
  licenseUrl?: string;
  contexts?: string[];
  defaultVisibility?: LdsVisibility;
  description?: string;
  orgId?: string;
  accountId?: string;
}

/** One attribute row for PUT /v1/lds/datasources/:id/attributes. */
export interface LdsAttributeInput {
  name: string;
  ngsiLdType?: LdsAttributeType;
  visibility?: LdsVisibility;
  description?: string;
  sourceField?: string;
}

/** Query for GET /v1/lds/datasources/:id/entities (limit 1..500, default 100). */
export interface LdsEntitiesQuery {
  limit?: number;
  offset?: number;
  visibility?: 'public' | 'restricted';
}

/** Result of POST /v1/lds/datasources/:id/records (quarantine reasons are per field). */
export interface LdsIngestResult {
  ingested: number;
  created: number;
  updated: number;
  quarantined: { field: string; reason: string }[];
  entities: { id: string; entityId: string; sourceRecordId?: string }[];
}

export class LdsService {
  constructor(private readonly http: HttpClient) {}

  licenses(): Promise<any[]> { return this.http.req('/v1/lds/licenses'); }

  datasources(query: { orgId?: string; accountId?: string } = {}): Promise<any[]> {
    const params = new URLSearchParams();
    if (query.orgId) params.set('orgId', query.orgId);
    if (query.accountId) params.set('accountId', query.accountId);
    const s = params.toString();
    return this.http.req(`/v1/lds/datasources${s ? `?${s}` : ''}`);
  }

  createDatasource(input: LdsDatasourceInput) {
    return this.http.req('/v1/lds/datasources', { method: 'POST', body: JSON.stringify(input) });
  }
  datasource(id: string) { return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}`); }
  updateDatasource(id: string, patch: Partial<LdsDatasourceInput>) {
    return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }
  deleteDatasource(id: string) {
    return this.http.req<{ ok: boolean }>(`/v1/lds/datasources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  attributes(id: string): Promise<any[]> {
    return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}/attributes`);
  }
  setAttributes(id: string, attributes: LdsAttributeInput[]): Promise<any[]> {
    return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}/attributes`, {
      method: 'PUT', body: JSON.stringify({ attributes }),
    });
  }
  /**
   * Ingest into a datasource. `records` accepts a single record object, an
   * array (wrapped as `{records}`), or a pre-wrapped `{records}`/`{record}`
   * body — all three shapes the endpoint accepts.
   */
  ingest(id: string, records: Record<string, unknown> | Record<string, unknown>[]): Promise<LdsIngestResult> {
    const body = Array.isArray(records)
      ? { records }
      : records && typeof records === 'object' && ('records' in records || 'record' in records)
        ? records
        : { record: records };
    return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}/records`, {
      method: 'POST', body: JSON.stringify(body),
    });
  }
  /** List NGSI-LD entities; limit 1..500 (default 100), visibility public|restricted only. */
  entities(id: string, query: LdsEntitiesQuery = {}): Promise<any[]> {
    const allowed = ['limit', 'offset', 'visibility'] as const;
    const params = new URLSearchParams();
    for (const k of allowed) {
      const v = query[k];
      if (v !== undefined && v !== null && String(v) !== '') params.set(k, String(v));
    }
    const s = params.toString();
    return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}/entities${s ? `?${s}` : ''}`);
  }
  entity(id: string, entityId: string) {
    return this.http.req(`/v1/lds/datasources/${encodeURIComponent(id)}/entities/${encodeURIComponent(entityId)}`);
  }
  stats(id: string) {
    return this.http.req<{ records: number; attributes: { public: number; restricted: number; internal: number }; lastIngestAt: string | null }>(
      `/v1/lds/datasources/${encodeURIComponent(id)}/stats`,
    );
  }
}
