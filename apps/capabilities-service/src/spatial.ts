// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dataset geo index: GeoJSON extraction, per-dataset Tier-1 geo collections and
 * best-effort index synchronisation.
 *
 * The spatial index lives in SynapseBase PostGIS and is reached through
 * @synapseone/sdk. Tier-2 keeps no spatial store of its own. Every operation is
 * scoped to one `synapsedx_geo_<datasetId>` collection so an index failure can
 * never read or delete another dataset's features.
 */
import { createHash } from 'node:crypto';
import { SynapseOneClient } from '@synapseone/sdk';
import { apiError } from './errors';
import { geometryError } from './geometry';
import { CapabilityRecord, DatasetRecord, isConflict, isNotFound } from './platform';
import { isRecordPublished } from './publication';

/** Dotted record-data path grammar for `dataset.geo.field`. */
export const GEO_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,5}$/;
const GEO_COLLECTION_PREFIX = 'synapsedx_geo_';
/** SynapseBase collection names: `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. */
const GEO_COLLECTION_MAX = 64;
const BANNED_FIELD_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export interface DatasetGeoConfig {
  /** Dotted path inside record.data holding a GeoJSON geometry. */
  field: string;
}

/** Validate the dataset geo binding (POST/PATCH /datasets). */
export function validateGeoConfig(value: unknown): DatasetGeoConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_geo_field', 'geo must be an object with a dotted field path');
  }
  const field = (value as Record<string, unknown>).field;
  if (typeof field !== 'string'
    || !GEO_FIELD_RE.test(field)
    || field.split('.').some((segment) => BANNED_FIELD_SEGMENTS.has(segment))) {
    throw apiError(
      400, 'invalid_geo_field',
      'geo.field must be 1..6 dot-separated path segments matching [A-Za-z_][A-Za-z0-9_]{0,63}',
    );
  }
  return { field };
}

/**
 * Tier-1 collection for one dataset. Dataset ids are slugs, but the name is
 * still sanitised; long slugs gain a short hash suffix so the 64-character
 * SynapseBase limit is never exceeded and distinct datasets stay distinct.
 */
export function geoCollectionName(datasetId: string): string {
  const slug = String(datasetId).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  const base = `${GEO_COLLECTION_PREFIX}${slug || 'dataset'}`;
  if (base.length <= GEO_COLLECTION_MAX) return base;
  const suffix = createHash('sha256').update(datasetId).digest('hex').slice(0, 8);
  return `${base.slice(0, GEO_COLLECTION_MAX - suffix.length - 1)}_${suffix}`;
}

/** Read a dotted path from record.data without touching inherited properties. */
export function readRecordPath(data: Record<string, unknown>, field: string): unknown {
  let value: unknown = data;
  for (const segment of field.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export interface ExtractedGeometry {
  geometry?: Record<string, unknown>;
  error?: string;
}

/**
 * Extract and validate one record's geometry. `null`/`undefined` means the
 * record has no feature (the existing one is removed); a non-geometry value is
 * rejected with a stable message the caller sees as `invalid_geometry`.
 */
export function extractRecordGeometry(data: Record<string, unknown>, field: string): ExtractedGeometry {
  const value = readRecordPath(data, field);
  if (value === undefined || value === null) return {};
  const error = geometryError(value);
  if (error) return { error };
  return { geometry: value as Record<string, unknown> };
}

export interface GeoFeatureView {
  id: string;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
  distanceMeters?: number;
}

/** Normalise a Tier-1 geo feature; anything unparsable is ignored. */
export function geoFeatureView(value: unknown): GeoFeatureView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : typeof item.id === 'number' ? String(item.id) : '';
  const geometry = item.geometry;
  if (!id || !geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return null;
  const properties = item.properties && typeof item.properties === 'object' && !Array.isArray(item.properties)
    ? item.properties as Record<string, unknown>
    : {};
  const rawDistance = item.distanceMeters ?? properties.distanceMeters;
  const distance = typeof rawDistance === 'number' ? rawDistance : Number.NaN;
  return {
    id,
    geometry: geometry as Record<string, unknown>,
    properties,
    ...(Number.isFinite(distance) ? { distanceMeters: distance } : {}),
  };
}

/** Feature payload stored for one source record. */
export function recordGeoFeature(
  dataset: DatasetRecord,
  record: CapabilityRecord,
  geometry: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'Feature',
    id: record.id,
    properties: {
      recordId: record.id,
      datasetId: dataset.id,
      published: isRecordPublished(dataset, record),
      updatedAt: record.updatedAt,
    },
    geometry,
  };
}

/** Lazily create the dataset geo collection (404 -> create, 409 -> exists). */
export async function ensureGeoCollection(client: SynapseOneClient, collection: string): Promise<void> {
  try {
    await client.base.getCollection(collection);
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await client.base.createCollection({ name: collection, description: `SynapseDX spatial index ${collection}` });
  } catch (error) {
    // A concurrent creator returns a conflict; that is success.
    if (!isConflict(error)) throw error;
  }
}

/** Best-effort feature delete; a missing collection/feature is not an error. */
export async function deleteGeoFeature(
  client: SynapseOneClient,
  collection: string,
  recordId: string,
): Promise<boolean> {
  try {
    await client.base.geoDelete(collection, recordId);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function warnGeo(action: string, datasetId: string, recordId: string | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[synapsedx] spatial index ${action} failed for dataset ${datasetId}`
    + `${recordId ? ` record ${recordId}` : ''}: ${message}`,
  );
}

/** Upsert or remove one record's feature. Never throws: Base is the source of truth. */
export async function syncRecordGeo(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  record: CapabilityRecord,
  geometry: Record<string, unknown> | undefined,
): Promise<void> {
  if (!dataset.geo) return;
  const collection = geoCollectionName(dataset.id);
  try {
    await ensureGeoCollection(client, collection);
    if (geometry) {
      await client.base.geoUpsert(collection, [recordGeoFeature(dataset, record, geometry)]);
    } else {
      await deleteGeoFeature(client, collection, record.id);
    }
  } catch (error) {
    warnGeo(geometry ? 'upsert' : 'delete', dataset.id, record.id, error);
  }
}

export interface RecordGeoBatchEntry {
  record: CapabilityRecord;
  geometry?: Record<string, unknown>;
}

/** Bulk variant: one geo upsert per 500 features plus best-effort deletes. */
export async function syncRecordsGeoBatch(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  entries: RecordGeoBatchEntry[],
): Promise<void> {
  if (!dataset.geo || !entries.length) return;
  const collection = geoCollectionName(dataset.id);
  try {
    await ensureGeoCollection(client, collection);
    const features = entries
      .filter((entry): entry is RecordGeoBatchEntry & { geometry: Record<string, unknown> } => !!entry.geometry)
      .map((entry) => recordGeoFeature(dataset, entry.record, entry.geometry));
    for (let index = 0; index < features.length; index += 500) {
      await client.base.geoUpsert(collection, features.slice(index, index + 500));
    }
  } catch (error) {
    warnGeo('bulk upsert', dataset.id, undefined, error);
    return;
  }
  for (const entry of entries) {
    if (entry.geometry) continue;
    try {
      await deleteGeoFeature(client, collection, entry.record.id);
    } catch (error) {
      warnGeo('bulk delete', dataset.id, entry.record.id, error);
    }
  }
}

/** Best-effort removal used by record delete, retention purge and dataset purge. */
export async function removeRecordGeo(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  recordId: string,
): Promise<void> {
  if (!dataset.geo) return;
  try {
    await deleteGeoFeature(client, geoCollectionName(dataset.id), recordId);
  } catch (error) {
    warnGeo('delete', dataset.id, recordId, error);
  }
}

/** Best-effort removal of every feature of a dataset (used by a purging delete). */
export async function removeAllRecordGeo(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  recordIds: string[],
): Promise<void> {
  if (!dataset.geo) return;
  for (const recordId of recordIds) await removeRecordGeo(client, dataset, recordId);
}
