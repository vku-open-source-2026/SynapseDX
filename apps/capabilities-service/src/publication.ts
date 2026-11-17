// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dataset lifecycle and SynapseLDS projection.
 *
 * State machine:
 *
 *   draft --publish--> published --revoke/unpublish--> revoked
 *     ^                    |                              |
 *     |                    +--publish (idempotent)        |
 *     +-------------------------publish------------------+
 *
 * `published` is only reachable for a `public` dataset. Publishing reconciles
 * the datasource metadata and attribute visibility; revoking/unpublishing
 * restricts every exported attribute *and* deletes the datasource so the Tier-1
 * public entity route can no longer expose previously published data.
 */
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from './config';
import { apiError } from './errors';
import { datasourceSlug, entityId } from './ids';
import {
  COLLECTIONS, CapabilityEvent, CapabilityRecord, DatasetRecord, StoredDocument,
  buildEvent, getDocumentOrNull, isConflict, isNotFound, queryDocuments,
} from './platform';

export interface DatasetDocument {
  document: StoredDocument<DatasetRecord>;
  data: DatasetRecord;
}

export async function loadDataset(client: SynapseOneClient, id: string): Promise<DatasetDocument | null> {
  const document = await getDocumentOrNull<DatasetRecord>(client, COLLECTIONS.datasets, id);
  if (!document) return null;
  return { document, data: document.data };
}

export async function saveDataset(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  ifVersion?: number,
): Promise<DatasetDocument> {
  try {
    const saved = await client.base.updateDocument(COLLECTIONS.datasets, dataset.id, {
      data: dataset as unknown as Record<string, unknown>,
      ...(ifVersion ? { ifVersion } : {}),
    });
    return { document: { id: saved.id, version: saved.version, data: saved.data as unknown as DatasetRecord }, data: saved.data as unknown as DatasetRecord };
  } catch (error) {
    if (isConflict(error)) {
      throw apiError(409, 'version_conflict', 'the dataset was modified by another request', { currentVersion: await currentVersion(client, dataset.id) });
    }
    throw error;
  }
}

async function currentVersion(client: SynapseOneClient, id: string): Promise<number | undefined> {
  try {
    const doc = await getDocumentOrNull<DatasetRecord>(client, COLLECTIONS.datasets, id);
    return doc?.version;
  } catch {
    return undefined;
  }
}

function hiddenAttributes(visible: boolean) {
  const visibility = visible ? 'public' as const : 'restricted' as const;
  return [
    { name: 'recordId', ngsiLdType: 'Property' as const, visibility },
    { name: 'data', ngsiLdType: 'Property' as const, visibility },
  ];
}

function datasourceInput(dataset: DatasetRecord, slug: string, visible: boolean) {
  return {
    name: dataset.name,
    slug,
    entityType: dataset.entityType,
    license: dataset.license,
    ...(dataset.licenseUrl ? { licenseUrl: dataset.licenseUrl } : {}),
    ...(dataset.description ? { description: dataset.description } : {}),
    defaultVisibility: (visible ? 'public' : 'internal') as 'public' | 'internal',
  };
}

/** Create the public datasource for a dataset and register exported attributes. */
export async function createDatasource(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  visible: boolean,
): Promise<string> {
  const discriminator = String(Date.now()).slice(-8);
  const slug = datasourceSlug(dataset.id, discriminator);
  let created: any;
  try {
    created = await client.lds.createDatasource(datasourceInput(dataset, slug, visible));
  } catch (error) {
    if (error instanceof SynapseOneError && error.status === 409) {
      // A rebuild raced with an unfinished delete; a second unique slug is safe.
      created = await client.lds.createDatasource(datasourceInput(dataset, datasourceSlug(dataset.id, `${discriminator}x`), visible));
    } else if (error instanceof SynapseOneError && error.status === 400) {
      throw apiError(409, 'illegal_transition', 'SynapseLDS rejected the datasource definition', { reason: 'datasource_invalid' });
    } else {
      throw error;
    }
  }
  const datasourceId = String(created?.id || created?.datasourceId || created?.datasource?.id || '');
  if (!datasourceId) throw apiError(503, 'dependency_unavailable', 'SynapseLDS did not return a datasource id');
  await client.lds.setAttributes(datasourceId, hiddenAttributes(visible));
  return datasourceId;
}

export async function syncDatasourceMetadata(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  datasourceId: string,
  visible: boolean,
): Promise<void> {
  try {
    await client.lds.updateDatasource(datasourceId, {
      name: dataset.name,
      entityType: dataset.entityType,
      license: dataset.license,
      ...(dataset.licenseUrl ? { licenseUrl: dataset.licenseUrl } : {}),
      ...(dataset.description ? { description: dataset.description } : {}),
      defaultVisibility: visible ? 'public' : 'internal',
    });
    await client.lds.setAttributes(datasourceId, hiddenAttributes(visible));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function deleteDatasource(client: SynapseOneClient, datasourceId: string): Promise<void> {
  try {
    await client.lds.deleteDatasource(datasourceId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export function isRecordPublished(dataset: DatasetRecord, record: Pick<CapabilityRecord, 'published'>): boolean {
  if (dataset.status !== 'published') return false;
  if (record.published === false) return false;
  return true;
}

function recordPayload(dataset: DatasetRecord, record: CapabilityRecord) {
  return { id: entityId(dataset.slug, record.id), recordId: record.id, data: record.data };
}

export async function ingestRecords(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  datasourceId: string,
  records: CapabilityRecord[],
): Promise<void> {
  for (let index = 0; index < records.length; index += 100) {
    const batch = records.slice(index, index + 100);
    if (!batch.length) continue;
    await client.lds.ingest(datasourceId, batch.map((record) => recordPayload(dataset, record)));
  }
}

export async function ingestRecord(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  datasourceId: string,
  record: CapabilityRecord,
): Promise<void> {
  await client.lds.ingest(datasourceId, recordPayload(dataset, record));
}

/** All records of one dataset (paged; used by publish/rebuild/purge). */
export async function listDatasetRecords(
  client: SynapseOneClient,
  datasetId: string,
  pageSize = 500,
): Promise<StoredDocument<CapabilityRecord>[]> {
  const all: StoredDocument<CapabilityRecord>[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (;;) {
    const result = await queryDocuments<CapabilityRecord>(client, COLLECTIONS.records, {
      where: { datasetId },
      orderBy: { field: 'id', direction: 'asc' },
      limit: pageSize,
      offset,
    });
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
    if (result.items.length < pageSize) break;
    offset += result.items.length;
  }
  return all;
}

export interface PublishOptions {
  correlationId: string;
  idempotencyKey?: string;
  ifVersion?: number;
}

export interface DatasetTransition {
  dataset: DatasetDocument;
  event?: CapabilityEvent;
}

/** Restrict a projection before deleting it so a failed delete cannot expose data. */
async function restrictDatasource(client: SynapseOneClient, datasourceId: string): Promise<void> {
  try {
    await client.lds.setAttributes(datasourceId, hiddenAttributes(false));
    await client.lds.updateDatasource(datasourceId, { defaultVisibility: 'internal' });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Remove committed/stale projections and persist any ids that still need cleanup. */
async function cleanupAfterCommit(
  client: SynapseOneClient,
  document: DatasetDocument,
): Promise<DatasetDocument> {
  const ids = [...new Set((document.data.projectionCleanup || []).filter(Boolean))];
  if (!ids.length) return document;
  const remaining: string[] = [];
  for (const id of ids) {
    try {
      await restrictDatasource(client, id);
      await deleteDatasource(client, id);
    } catch {
      remaining.push(id);
    }
  }
  const updated: DatasetRecord = { ...document.data, updatedAt: new Date().toISOString() };
  if (remaining.length) updated.projectionCleanup = remaining;
  else delete updated.projectionCleanup;
  try {
    return await saveDataset(client, updated, document.document.version);
  } catch {
    // The committed dataset is already correct; a stale cleanup marker is
    // harmless and will be retried by the next transition.
    return document;
  }
}

/** Best-effort removal of a projection created by a failed transition. */
async function discardProjection(client: SynapseOneClient, datasourceId: string | undefined): Promise<void> {
  if (!datasourceId) return;
  try {
    await restrictDatasource(client, datasourceId);
    await deleteDatasource(client, datasourceId);
  } catch {
    /* the next publish/rebuild will not reference this id */
  }
}

/**
 * Publish (or re-publish) a dataset. Public datasets only. A status transition
 * persists a pending marker with CAS *before* touching LDS, builds the
 * projection, then commits `published` with a second CAS. On any failure the
 * new projection is removed and the previous non-public state restored.
 */
export async function publishDataset(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  ifVersion: number | undefined,
  options: PublishOptions,
): Promise<DatasetTransition> {
  if (!dataset.public) {
    throw apiError(409, 'dataset_not_public', 'only public datasets can be published');
  }
  const transition = dataset.status !== 'published';
  const now = new Date().toISOString();

  if (!transition) {
    // Idempotent reconcile of an already-published dataset. It is already
    // public, so no draft data can leak while metadata/records are synced.
    let datasourceId = dataset.ldsDatasourceId;
    let createdId: string | undefined;
    if (datasourceId) {
      await syncDatasourceMetadata(client, dataset, datasourceId, true);
    } else {
      createdId = await createDatasource(client, dataset, true);
      datasourceId = createdId;
      await ingestRecords(client, dataset, datasourceId,
        (await listDatasetRecords(client, dataset.id))
          .map((item) => item.data)
          .filter((record) => isRecordPublished(dataset, record)));
    }
    const updated: DatasetRecord = {
      ...dataset,
      status: 'published',
      everPublished: true,
      ldsDatasourceId: datasourceId,
      updatedAt: now,
    };
    delete updated.projectionPending;
    try {
      return { dataset: await saveDataset(client, updated, ifVersion) };
    } catch (error) {
      await discardProjection(client, createdId);
      throw error;
    }
  }

  const previousDatasourceId = dataset.ldsDatasourceId;
  const pending: DatasetRecord = {
    ...dataset,
    updatedAt: now,
    projectionPending: { action: 'publish', startedAt: now },
  };
  delete pending.ldsDatasourceId;
  let saved: DatasetDocument;
  try {
    saved = await saveDataset(client, pending, ifVersion);
  } catch (error) {
    throw error;
  }

  let createdDatasourceId: string | undefined;
  try {
    createdDatasourceId = await createDatasource(client, saved.data, true);
    const records = (await listDatasetRecords(client, dataset.id))
      .map((item) => item.data)
      .filter((record) => isRecordPublished({ ...dataset, status: 'published' }, record));
    await ingestRecords(client, { ...dataset, status: 'published' }, createdDatasourceId, records);

    const cleanup = [...new Set([
      ...(saved.data.projectionCleanup || []),
      ...(previousDatasourceId && previousDatasourceId !== createdDatasourceId ? [previousDatasourceId] : []),
    ])];
    const updated: DatasetRecord = {
      ...saved.data,
      status: 'published',
      everPublished: true,
      ldsDatasourceId: createdDatasourceId,
      updatedAt: new Date().toISOString(),
      ...(cleanup.length ? { projectionCleanup: cleanup } : {}),
    };
    delete updated.projectionPending;
    const committed = await saveDataset(client, updated, saved.document.version);
    return {
      dataset: await cleanupAfterCommit(client, committed),
      event: buildEvent('dataset.published', {
        datasetId: updated.id,
        version: updated.schemaVersion,
        at: now,
        correlationId: options.correlationId,
      }, options.idempotencyKey),
    };
  } catch (error) {
    await discardProjection(client, createdDatasourceId);
    // Restore the previous non-public state. If a concurrent writer won the
    // CAS, the pending marker may remain; the projection is already gone and
    // the next transition overwrites the marker, so no public data survives.
    try {
      const restored: DatasetRecord = { ...saved.data, updatedAt: new Date().toISOString() };
      delete restored.projectionPending;
      if (previousDatasourceId) restored.ldsDatasourceId = previousDatasourceId;
      else delete restored.ldsDatasourceId;
      await saveDataset(client, restored, saved.document.version);
    } catch {
      /* keep the durable pending marker for the next attempt */
    }
    throw error;
  }
}

/** Restrict + delete the public projection so direct LDS reads stop working. */
export async function revokeProjection(
  client: SynapseOneClient,
  dataset: DatasetRecord,
): Promise<string | undefined> {
  const ids = [...new Set([
    dataset.ldsDatasourceId,
    dataset.projectionPending?.datasourceId,
    ...(dataset.projectionCleanup || []),
  ].filter((value): value is string => Boolean(value)))];
  for (const datasourceId of ids) {
    await restrictDatasource(client, datasourceId);
    await deleteDatasource(client, datasourceId);
  }
  return undefined;
}

/**
 * Revoke or unpublish a dataset. The revoked status is persisted with CAS
 * *before* the public projection is touched, so a concurrent/failed delete can
 * never leave a published dataset pointing at a missing projection. Cleanup is
 * retried on the next revoke/publish transition via `projectionCleanup`.
 */
export async function revokeDataset(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  ifVersion: number | undefined,
  options: PublishOptions & { reason?: string },
): Promise<DatasetTransition> {
  const transition = dataset.status !== 'revoked';
  const now = new Date().toISOString();
  const datasourceIds = [...new Set([
    dataset.ldsDatasourceId,
    dataset.projectionPending?.datasourceId,
    ...(dataset.projectionCleanup || []),
  ].filter((value): value is string => Boolean(value)))];

  if (!transition && !datasourceIds.length) {
    return { dataset: { document: { id: dataset.id, version: ifVersion || 0, data: dataset }, data: dataset } };
  }

  const revoked: DatasetRecord = {
    ...dataset,
    status: 'revoked',
    updatedAt: now,
    ...(datasourceIds.length ? { projectionCleanup: datasourceIds } : {}),
  };
  delete revoked.ldsDatasourceId;
  delete revoked.projectionPending;
  const saved = await saveDataset(client, revoked, ifVersion);
  const cleaned = await cleanupAfterCommit(client, saved);
  const event = buildEvent('dataset.revoked', {
    datasetId: cleaned.data.id,
    at: now,
    correlationId: options.correlationId,
    ...(options.reason ? { payload: { reason: options.reason } } : {}),
  }, options.idempotencyKey);
  return { dataset: cleaned, ...(transition ? { event } : {}) };
}

/**
 * Rebuild the public projection from the current record set. The replacement
 * datasource is fully created and ingested before it is committed; the old one
 * is removed only after the new id is durable. Any failure leaves the old
 * projection (and dataset state) untouched.
 */
export async function rebuildProjection(
  client: SynapseOneClient,
  dataset: DatasetRecord,
  ifVersion: number | undefined,
  options: PublishOptions,
): Promise<DatasetDocument> {
  if (dataset.status !== 'published' || !dataset.public) {
    return { document: { id: dataset.id, version: ifVersion || 0, data: dataset }, data: dataset };
  }
  const records = (await listDatasetRecords(client, dataset.id))
    .map((item) => item.data)
    .filter((record) => isRecordPublished(dataset, record));
  const oldDatasourceId = dataset.ldsDatasourceId;
  const now = new Date().toISOString();

  if (!records.length) {
    // Restrict the old projection first; a failures leaves the dataset pointing
    // at an empty (not stale) public export.
    if (oldDatasourceId) await restrictDatasource(client, oldDatasourceId);
    const cleared: DatasetRecord = {
      ...dataset,
      updatedAt: now,
      ...(oldDatasourceId ? { projectionCleanup: [...new Set([...(dataset.projectionCleanup || []), oldDatasourceId])] } : {}),
    };
    delete cleared.ldsDatasourceId;
    delete cleared.projectionPending;
    return cleanupAfterCommit(client, await saveDataset(client, cleared, ifVersion));
  }

  let datasourceId: string | undefined;
  try {
    datasourceId = await createDatasource(client, dataset, true);
    await ingestRecords(client, dataset, datasourceId, records);
  } catch (error) {
    await discardProjection(client, datasourceId);
    throw error;
  }

  const cleanup = [...new Set([
    ...(dataset.projectionCleanup || []),
    ...(oldDatasourceId && oldDatasourceId !== datasourceId ? [oldDatasourceId] : []),
  ])];
  const updated: DatasetRecord = {
    ...dataset,
    ldsDatasourceId: datasourceId,
    updatedAt: new Date().toISOString(),
    ...(cleanup.length ? { projectionCleanup: cleanup } : {}),
  };
  delete updated.projectionPending;
  try {
    const saved = await saveDataset(client, updated, ifVersion);
    return cleanupAfterCommit(client, saved);
  } catch (error) {
    await discardProjection(client, datasourceId);
    throw error;
  }
}
