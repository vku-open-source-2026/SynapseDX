// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dataset record spatial queries (nearby, bounding box, polygon).
 *
 * Tier-2 only owns the semantics: features are stored in the dataset's
 * SynapseBase PostGIS collection and every hit is re-checked against the
 * normal record visibility rules before it is returned. A caller therefore
 * never sees a record the record API would hide, even if the index is stale.
 */
import { Express } from 'express';
import { SynapseOneClient } from '@synapseone/sdk';
import { ServiceConfig } from '../config';
import { apiError, envelope } from '../errors';
import { geometryError } from '../geometry';
import { handler } from '../http';
import { validateDatasetId } from '../ids';
import {
  COLLECTIONS, CapabilityRecord, DatasetRecord, StoredDocument, correlationIdOf, isNotFound,
  queryDocuments, recordAudit,
} from '../platform';
import { isRecordPublished } from '../publication';
import {
  GeoFeatureView, deleteGeoFeature, ensureGeoCollection, extractRecordGeometry, geoCollectionName,
  geoFeatureView, recordGeoFeature,
} from '../spatial';
import { accessibleDataset, canReadRecordDrafts, readContext, writeContext } from './shared';
import { RecordResponse, recordResponse } from './records';

export const SPATIAL_DEFAULT_LIMIT = 100;
export const SPATIAL_MAX_LIMIT = 500;
export const SPATIAL_MAX_RADIUS_METERS = 100_000;
export const SPATIAL_REINDEX_MAX_RECORDS = 5_000;
/** Bounded over-fetch so hidden drafts do not shrink a visible page below `limit`. */
const SPATIAL_FETCH_FACTOR = 3;
const SPATIAL_TIER1_MAX = 1_000;
const RECORD_LOAD_CHUNK = 200;

export type SpatialMode = 'near' | 'bbox' | 'within';

export interface SpatialQuery {
  mode: SpatialMode;
  limit: number;
  lat?: number;
  lng?: number;
  radiusMeters?: number;
  bbox?: [number, number, number, number];
  geometry?: Record<string, unknown>;
}

export interface SpatialFeatureResponse {
  type: 'Feature';
  id: string;
  geometry: Record<string, unknown>;
  properties: { recordId: string; distanceMeters?: number };
}

export interface SpatialQueryResponse {
  type: 'FeatureCollection';
  features: SpatialFeatureResponse[];
  items: RecordResponse[];
  total: number;
  limit: number;
  mode: SpatialMode;
}

export interface SpatialReindexResponse {
  dataset_id: string;
  collection: string;
  offset: number;
  scanned: number;
  indexed: number;
  removed: number;
  skipped: number;
  failed: number;
  truncated: boolean;
}

export interface SpatialStatusResponse {
  configured: boolean;
  field?: string;
  collection?: string;
  features?: number;
  extent?: unknown;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw apiError(400, 'invalid_request', `${label} must be a finite number`);
  }
  return value;
}

function spatialLimit(value: unknown): number {
  if (value === undefined || value === null) return SPATIAL_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > SPATIAL_MAX_LIMIT) {
    throw apiError(400, 'invalid_limit', `limit must be an integer 1..${SPATIAL_MAX_LIMIT}`);
  }
  return value;
}

/** Validate one spatial query body; exported for focused unit tests. */
export function parseSpatialQuery(body: Record<string, unknown>): SpatialQuery {
  const mode = String(body.mode ?? '');
  const limit = spatialLimit(body.limit);
  if (mode === 'near') {
    const lat = finiteNumber(body.lat, 'lat');
    const lng = finiteNumber(body.lng, 'lng');
    const radiusMeters = finiteNumber(body.radiusMeters, 'radiusMeters');
    if (lat < -90 || lat > 90) throw apiError(400, 'invalid_request', 'lat must be between -90 and 90');
    if (lng < -180 || lng > 180) throw apiError(400, 'invalid_request', 'lng must be between -180 and 180');
    if (radiusMeters < 1 || radiusMeters > SPATIAL_MAX_RADIUS_METERS) {
      throw apiError(400, 'invalid_request', `radiusMeters must be between 1 and ${SPATIAL_MAX_RADIUS_METERS}`);
    }
    return { mode, limit, lat, lng, radiusMeters };
  }
  if (mode === 'bbox') {
    const raw = body.bbox;
    if (!Array.isArray(raw) || raw.length !== 4) {
      throw apiError(400, 'invalid_request', 'bbox must be [west, south, east, north]');
    }
    const [west, south, east, north] = raw.map((value) => finiteNumber(value, 'bbox'));
    if (west < -180 || west > 180 || east < -180 || east > 180) {
      throw apiError(400, 'invalid_request', 'bbox longitudes must be between -180 and 180');
    }
    if (south < -90 || south > 90 || north < -90 || north > 90) {
      throw apiError(400, 'invalid_request', 'bbox latitudes must be between -90 and 90');
    }
    if (west > east) throw apiError(400, 'invalid_request', 'bbox west must not exceed east');
    if (south > north) throw apiError(400, 'invalid_request', 'bbox south must not exceed north');
    return { mode, limit, bbox: [west, south, east, north] };
  }
  if (mode === 'within') {
    const geometry = body.geometry;
    if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) {
      throw apiError(400, 'invalid_geometry', 'geometry must be a GeoJSON Polygon or MultiPolygon');
    }
    const type = String((geometry as Record<string, unknown>).type || '');
    if (type !== 'Polygon' && type !== 'MultiPolygon') {
      throw apiError(400, 'invalid_geometry', 'geometry must be a GeoJSON Polygon or MultiPolygon');
    }
    const error = geometryError(geometry);
    if (error) throw apiError(400, 'invalid_geometry', error);
    return { mode, limit, geometry: geometry as Record<string, unknown> };
  }
  throw apiError(400, 'invalid_request', 'mode must be "near", "bbox" or "within"');
}

function requireGeo(dataset: DatasetRecord): { field: string } {
  if (!dataset.geo) {
    throw apiError(400, 'geo_not_configured', 'this dataset has no geo field; set dataset.geo.field first');
  }
  return dataset.geo;
}

async function queryTier1(
  client: SynapseOneClient,
  collection: string,
  query: SpatialQuery,
): Promise<GeoFeatureView[]> {
  const fetchLimit = Math.min(query.limit * SPATIAL_FETCH_FACTOR, SPATIAL_TIER1_MAX);
  try {
    const result = query.mode === 'near'
      ? await client.base.geoNear(collection, {
        lat: query.lat!, lng: query.lng!, radiusMeters: query.radiusMeters!, limit: fetchLimit,
      })
      : query.mode === 'bbox'
        ? await client.base.geoList(collection, { bbox: query.bbox!.join(','), limit: fetchLimit })
        : await client.base.geoWithin(collection, { geometry: query.geometry!, limit: fetchLimit });
    return (Array.isArray(result?.features) ? result.features : [])
      .map(geoFeatureView)
      .filter((feature): feature is GeoFeatureView => feature !== null);
  } catch (error) {
    // A dataset that has never been indexed has no collection yet.
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** Load only the candidate records, in `$id` chunks, through Base documents. */
async function loadCandidateRecords(
  client: SynapseOneClient,
  datasetId: string,
  ids: string[],
): Promise<Map<string, StoredDocument<CapabilityRecord>>> {
  const found = new Map<string, StoredDocument<CapabilityRecord>>();
  for (let offset = 0; offset < ids.length; offset += RECORD_LOAD_CHUNK) {
    const chunk = ids.slice(offset, offset + RECORD_LOAD_CHUNK);
    const result = await queryDocuments<CapabilityRecord>(client, COLLECTIONS.records, {
      where: { and: [{ datasetId }, { field: '$id', op: 'in', value: chunk }] },
      limit: chunk.length,
    });
    for (const item of result.items) {
      if (item.data.datasetId === datasetId) found.set(item.id, item);
    }
  }
  return found;
}

function featureResponse(feature: GeoFeatureView): SpatialFeatureResponse {
  return {
    type: 'Feature',
    id: feature.id,
    geometry: feature.geometry,
    properties: {
      recordId: feature.id,
      ...(feature.distanceMeters !== undefined ? { distanceMeters: feature.distanceMeters } : {}),
    },
  };
}

/** Page dataset records for reindex, bounded to one call's work budget. */
async function loadRecordsForReindex(
  client: SynapseOneClient,
  datasetId: string,
  startOffset: number,
): Promise<{ items: StoredDocument<CapabilityRecord>[]; truncated: boolean }> {
  const items: StoredDocument<CapabilityRecord>[] = [];
  const seen = new Set<string>();
  let offset = startOffset;
  let total = 0;
  const pageSize = 500;
  for (;;) {
    const remaining = SPATIAL_REINDEX_MAX_RECORDS - items.length;
    if (remaining <= 0) break;
    const page = await queryDocuments<CapabilityRecord>(client, COLLECTIONS.records, {
      where: { datasetId },
      orderBy: { field: 'id', direction: 'asc' },
      limit: Math.min(pageSize, remaining),
      offset,
    });
    total = page.total;
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    if (page.items.length < Math.min(pageSize, remaining)) break;
    offset += page.items.length;
  }
  return { items, truncated: total > startOffset + items.length };
}

/**
 * Reusable spatial read used by the dataset route and the declarative map
 * widget. Visibility is re-checked against the authoritative record, so the
 * index cannot widen access.
 */
export async function querySpatialRecords(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  caller: Parameters<typeof canReadRecordDrafts>[1],
  body: Record<string, unknown>,
): Promise<{ query: SpatialQuery; features: SpatialFeatureResponse[]; items: RecordResponse[] }> {
  requireGeo(dataset);
  const query = parseSpatialQuery(body);
  const collection = geoCollectionName(dataset.id);
  const candidates = await queryTier1(client, collection, query);
  const records = await loadCandidateRecords(client, dataset.id, [...new Set(candidates.map((item) => item.id))]);
  const drafts = canReadRecordDrafts(dataset, caller);

  const features: SpatialFeatureResponse[] = [];
  const items: RecordResponse[] = [];
  for (const feature of candidates) {
    const document = records.get(feature.id);
    if (!document) continue;
    if (!drafts && !isRecordPublished(dataset, document.data)) continue;
    features.push(featureResponse(feature));
    items.push(recordResponse(document));
    if (items.length >= query.limit) break;
  }
  return { query, features, items };
}

export function registerSpatialRecordRoutes(app: Express, config: ServiceConfig): void {
  // `/records/spatial` is also a syntactically valid record id, so the generic
  // record route would otherwise answer GET/PATCH/DELETE with 404. Reserve the
  // path for POST here (this module registers before the record routes).
  app.all('/v1/capabilities/datasets/:id/records/spatial', (req, res, next) => {
    if (req.method === 'POST' || req.method === 'OPTIONS') {
      next();
      return;
    }
    res.setHeader('allow', 'POST, OPTIONS');
    res.status(405).json(envelope(
      'method_not_allowed', 'Method not allowed for this route', req.synapseDxRequestId || '',
    ));
  });

  app.post('/v1/capabilities/datasets/:id/records/spatial', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, client } = await readContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'records');
    const geo = requireGeo(dataset);
    const { query, features, items } = await querySpatialRecords(
      client,
      dataset,
      caller,
      (req.body || {}) as Record<string, unknown>,
    );
    const response: SpatialQueryResponse = {
      type: 'FeatureCollection',
      features,
      items,
      total: items.length,
      limit: query.limit,
      mode: query.mode,
    };
    res.setHeader('x-spatial-field', geo.field);
    res.setHeader('x-spatial-collection', geoCollectionName(dataset.id));
    res.json(response);
  }));

  app.post('/v1/capabilities/datasets/:id/records/spatial/reindex', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, principal, client } = await writeContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    const geo = requireGeo(dataset);
    const collection = geoCollectionName(dataset.id);
    await ensureGeoCollection(client, collection);
    const body = (req.body || {}) as Record<string, unknown>;
    const rawOffset = body.offset;
    if (rawOffset !== undefined && (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0)) {
      throw apiError(400, 'invalid_offset', 'offset must be a non-negative integer');
    }
    const startOffset = Number(rawOffset || 0);
    const { items: records, truncated } = await loadRecordsForReindex(client, datasetId, startOffset);

    let scanned = 0;
    let indexed = 0;
    let removed = 0;
    let skipped = 0;
    let failed = 0;
    const seen = new Set<string>();
    const pending: Array<{ record: CapabilityRecord; geometry: Record<string, unknown> }> = [];
    for (const document of records) {
      scanned += 1;
      seen.add(document.id);
      const extracted = extractRecordGeometry(document.data.data || {}, geo.field);
      if (extracted.error) {
        skipped += 1;
        // Do not keep serving geometry that no longer validates.
        try {
          if (await deleteGeoFeature(client, collection, document.id)) removed += 1;
        } catch {
          /* best effort; the record stays skipped */
        }
        continue;
      }
      if (!extracted.geometry) {
        try {
          if (await deleteGeoFeature(client, collection, document.id)) removed += 1;
          else skipped += 1;
        } catch {
          failed += 1;
        }
        continue;
      }
      pending.push({ record: document.data, geometry: extracted.geometry });
      if (pending.length >= 500) {
        const batch = pending.splice(0, pending.length);
        try {
          await client.base.geoUpsert(collection, batch.map((entry) => (
            recordGeoFeature(dataset, entry.record, entry.geometry)
          )));
          indexed += batch.length;
        } catch {
          failed += batch.length;
        }
      }
    }
    if (pending.length) {
      try {
        await client.base.geoUpsert(collection, pending.map((entry) => (
          recordGeoFeature(dataset, entry.record, entry.geometry)
        )));
        indexed += pending.length;
      } catch {
        failed += pending.length;
      }
    }

    // Stale-feature cleanup is safe only when this call scanned the whole
    // dataset from the first record; a truncated or offset pass cannot know
    // which ids still exist outside its window.
    if (startOffset === 0 && !truncated) {
      try {
        const listed = await client.base.geoList(collection, { limit: SPATIAL_TIER1_MAX });
        for (const raw of Array.isArray(listed?.features) ? listed.features : []) {
          const feature = geoFeatureView(raw);
          if (!feature || seen.has(feature.id)) continue;
          try {
            if (await deleteGeoFeature(client, collection, feature.id)) removed += 1;
            else skipped += 1;
          } catch {
            failed += 1;
          }
        }
      } catch (error) {
        if (!isNotFound(error)) failed += 1;
      }
    }

    const response: SpatialReindexResponse = {
      dataset_id: dataset.id,
      collection,
      offset: startOffset,
      scanned,
      indexed,
      removed,
      skipped,
      failed,
      truncated,
    };
    await recordAudit(client, config, {
      actor: principal.subject,
      tenant: principal.tenantKey,
      action: 'record.spatial_reindex',
      datasetId: dataset.id,
      correlationId: correlationIdOf(req),
      details: { ...response },
    });
    res.json(response);
  }));

  app.get('/v1/capabilities/datasets/:id/records/spatial/status', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, client } = await readContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'records');
    if (!dataset.geo) {
      const response: SpatialStatusResponse = { configured: false };
      res.json(response);
      return;
    }
    const collection = geoCollectionName(dataset.id);
    let features: number | undefined;
    let extent: unknown;
    try {
      const stats = await client.base.geoStats(collection);
      const count = Number(stats?.features ?? 0);
      features = Number.isFinite(count) ? count : 0;
      if (stats?.extent !== undefined && stats.extent !== null) extent = stats.extent;
    } catch (error) {
      if (isNotFound(error)) features = 0;
      else console.warn(`[synapsedx] spatial stats unavailable for dataset ${dataset.id}: ${(error as Error).message}`);
    }
    const response: SpatialStatusResponse = {
      configured: true,
      field: dataset.geo.field,
      collection,
      ...(features !== undefined ? { features } : {}),
      ...(extent !== undefined ? { extent } : {}),
    };
    res.json(response);
  }));
}
