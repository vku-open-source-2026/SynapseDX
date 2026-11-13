// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Record CRUD, per-record publication, query, bulk and retention routes. */
import { Express, Request } from 'express';
import { randomUUID } from 'node:crypto';
import { SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from '../config';
import { apiError, ApiError } from '../errors';
import { handler } from '../http';
import { validateDatasetId, validateRecordId } from '../ids';
import { parsePagination, setPageHeaders } from '../pagination';
import {
  COLLECTIONS, CapabilityRecord, DatasetRecord, StoredDocument, buildEvent, claimIdempotency,
  correlationIdOf, emitEvent, getDocumentOrNull, idempotencyKeyOf, queryDocuments, recordAudit,
  requestFingerprint,
} from '../platform';
import {
  ingestRecord, ingestRecords, isRecordPublished, listDatasetRecords, rebuildProjection,
} from '../publication';
import {
  accessibleDataset, expectedVersion, readContext, requireVersionMatch, setVersionHeaders, writeContext,
} from './shared';

interface RecordResponse {
  id: string;
  data: Record<string, unknown>;
  version: number;
  published?: boolean;
  createdAt: string;
  updatedAt: string;
}

function recordResponse(document: StoredDocument<CapabilityRecord>): RecordResponse {
  const record = document.data;
  return {
    id: record.id || document.id,
    data: record.data,
    version: document.version,
    ...(record.published !== undefined ? { published: record.published } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function requireData(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw apiError(400, 'data_must_be_an_object', 'data must be a JSON object');
  }
  return data as Record<string, unknown>;
}

function publishFlag(body: Record<string, unknown>): boolean | undefined {
  if (body.publish === undefined) return undefined;
  if (typeof body.publish !== 'boolean') throw apiError(400, 'invalid_request', 'publish must be a boolean');
  return body.publish;
}

function requirePublishable(dataset: DatasetRecord): void {
  if (!dataset.public || dataset.status !== 'published') {
    throw apiError(409, 'dataset_not_published', 'the dataset must be public and published before records can be published');
  }
}

async function loadRecord(
  ctx: { client: import('@synapseone/sdk').SynapseOneClient },
  dataset: DatasetRecord,
  recordId: string,
): Promise<StoredDocument<CapabilityRecord>> {
  const id = validateRecordId(recordId);
  const document = await getDocumentOrNull<CapabilityRecord>(ctx.client, COLLECTIONS.records, id);
  if (!document || document.data.datasetId !== dataset.id) {
    throw apiError(404, 'record_not_found', 'record not found');
  }
  return document;
}

/* ------------------------------------------------------------------------- *
 * Projection helpers
 * ------------------------------------------------------------------------- */

/** Newly created record: incrementally ingest when possible. */
async function projectNewRecord(
  client: import('@synapseone/sdk').SynapseOneClient,
  dataset: DatasetRecord,
  record: CapabilityRecord,
  correlationId: string,
  idempotencyKey?: string,
): Promise<DatasetRecord> {
  if (!isRecordPublished(dataset, record)) return dataset;
  if (dataset.ldsDatasourceId) {
    await ingestRecord(client, dataset, dataset.ldsDatasourceId, record);
    return dataset;
  }
  return (await rebuildProjection(client, dataset, undefined, { correlationId, idempotencyKey })).data;
}

async function projectAfterChange(
  client: import('@synapseone/sdk').SynapseOneClient,
  dataset: DatasetRecord,
  record: CapabilityRecord,
  wasPublished: boolean,
  ifVersion: number | undefined,
  correlationId: string,
  idempotencyKey?: string,
): Promise<DatasetRecord> {
  const nowPublished = isRecordPublished(dataset, record);
  const datasourceId = dataset.ldsDatasourceId;
  if (wasPublished !== nowPublished || (!datasourceId && nowPublished)) {
    const rebuilt = await rebuildProjection(client, dataset, ifVersion, { correlationId, idempotencyKey });
    return rebuilt.data;
  }
  if (nowPublished && datasourceId) {
    await ingestRecord(client, dataset, datasourceId, record);
  }
  return dataset;
}

const RECORD_TOP_LEVEL_FIELDS = new Set(['$id', 'id', 'datasetId', 'published', 'createdAt', 'updatedAt']);

function qualifyField(field: string): string {
  if (field.startsWith('data.') || RECORD_TOP_LEVEL_FIELDS.has(field)) return field;
  return `data.${field}`;
}

/**
 * Record payload fields live under `data` in the Tier-1 document. Qualify
 * unqualified filters so callers can write `{status:'open'}` instead of
 * `{'data.status':'open'}`; explicit top-level fields stay addressable.
 */
export function qualifyRecordFilter(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(qualifyRecordFilter);
  if (!input || typeof input !== 'object') return input;
  const node = input as Record<string, unknown>;
  if (Array.isArray(node.and)) return { ...node, and: node.and.map(qualifyRecordFilter) };
  if (Array.isArray(node.or)) return { ...node, or: node.or.map(qualifyRecordFilter) };
  if (node.not !== undefined) return { ...node, not: qualifyRecordFilter(node.not) };
  if (typeof node.field === 'string') return { ...node, field: qualifyField(node.field) };
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) output[qualifyField(key)] = value;
  return output;
}

function qualifiedOrderBy(req: Request, value: unknown): { field: string; direction: 'asc' | 'desc' } | undefined {
  const order = normalizeOrderBy(value);
  if (!order) return undefined;
  return { field: qualifyField(order.field), direction: order.direction };
}

function bodyPagination(req: Request, body: Record<string, unknown>, maxPageSize: number) {
  const limitRaw = body.limit ?? req.query.limit;
  const offsetRaw = body.offset ?? req.query.offset;
  const synthetic = {
    query: { limit: limitRaw as any, offset: offsetRaw as any, cursor: (body.cursor ?? req.query.cursor) as any },
  } as unknown as Request;
  return parsePagination(synthetic, maxPageSize);
}

function normalizeOrderBy(value: unknown): { field: string; direction: 'asc' | 'desc' } | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const match = raw.match(/^([A-Za-z_$][A-Za-z0-9_$.-]{0,255})(?::(asc|desc))?$/i);
  if (!match) throw apiError(400, 'invalid_request', 'orderBy must be "field" or "field:asc|desc"');
  return { field: match[1], direction: (match[2]?.toLowerCase() as 'asc' | 'desc') || 'asc' };
}

export function registerRecordRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/datasets/:id/records', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, client } = await readContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'records');
    const pagination = parsePagination(req, config.maxPageSize);
    const publishedOnly = String(req.query.publishedOnly || '').toLowerCase() === 'true';
    const where = publishedOnly
      ? { and: [{ datasetId }, { or: [{ published: true }, { published: { exists: false } }] }] }
      : { datasetId };
    const result = await queryDocuments<CapabilityRecord>(client, COLLECTIONS.records, {
      where,
      orderBy: qualifiedOrderBy(req, req.query.orderBy) || { field: 'id', direction: 'asc' },
      limit: pagination.limit,
      offset: pagination.offset,
      ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({
      items: result.items.map(recordResponse),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  app.post('/v1/capabilities/datasets/:id/records/query', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, client } = await readContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'records');
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.where !== undefined && (typeof body.where !== 'object' || Array.isArray(body.where) && !body.where.length)) {
      throw apiError(400, 'invalid_request', 'where must be a filter object');
    }
    const pagination = bodyPagination(req, body, config.maxPageSize);
    const where = body.where === undefined
      ? { datasetId }
      : { and: [{ datasetId }, qualifyRecordFilter(body.where)] };
    const result = await queryDocuments<CapabilityRecord>(client, COLLECTIONS.records, {
      where,
      orderBy: qualifiedOrderBy(req, body.orderBy) || { field: 'id', direction: 'asc' },
      limit: pagination.limit,
      offset: pagination.offset,
      ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({
      items: result.items.map(recordResponse),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  app.post('/v1/capabilities/datasets/:id/records/bulk', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, principal, client } = await writeContext(req, config);
    const { document, data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const entries = body.records;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) {
      throw apiError(400, 'invalid_request', 'records must be an array of 1..100 entries');
    }
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, principal.tenantKey, idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      const errors: Array<{ index: number; code: string; message: string }> = [];
      let pendingEvents = false;
      let datasetVersion = document.version;
      const prepared: Array<{ index: number; record: CapabilityRecord }> = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = (entries[index] || {}) as Record<string, unknown>;
        try {
          const recordData = requireData(entry);
          const publish = publishFlag(entry);
          if (publish === true) requirePublishable(dataset);
          const id = entry.id !== undefined ? validateRecordId(entry.id) : randomUUID();
          const now = new Date().toISOString();
          prepared.push({
            index,
            record: {
              id, datasetId, data: recordData, createdAt: now, updatedAt: now,
              ...(publish !== undefined ? { published: publish } : {}),
            },
          });
        } catch (error) {
          const status = error instanceof ApiError ? error.status : 500;
          errors.push({
            index,
            code: error instanceof ApiError ? error.code : 'internal_error',
            message: status >= 500 ? 'internal error' : (error as Error).message,
          });
        }
      }

      const savedByIndex = new Map<number, StoredDocument<CapabilityRecord>>();
      if (prepared.length) {
        // One Base batch instead of one HTTP request per record. The old loop
        // was the dominant cost of large CSV imports (and could exceed the
        // gateway timeout before the first projection was built).
        const batch = await client.base.batch(
          COLLECTIONS.records,
          prepared.map((entry) => ({
            op: 'create',
            id: entry.record.id,
            data: entry.record as unknown as Record<string, unknown>,
          })),
        );
        for (const result of batch.results || []) {
          const index = Number(result.index);
          const entry = prepared[index];
          if (!entry) continue;
          if (!result.ok) {
            const message = String(result.message || '');
            const duplicate = result.error === 'conflict' || /already[_\s-]?exists|document_exists/i.test(message);
            errors.push({
              index: entry.index,
              code: duplicate ? 'record_already_exists' : 'internal_error',
              message: duplicate ? 'record already exists' : 'internal error',
            });
            continue;
          }
          const documentView = result.document || {};
          const saved: StoredDocument<CapabilityRecord> = {
            id: String(documentView.id || entry.record.id),
            version: Number(documentView.version) || 1,
            data: (documentView.data || entry.record) as CapabilityRecord,
          };
          savedByIndex.set(index, saved);
          datasetVersion = Math.max(datasetVersion, saved.version);
        }
      }

      const created: RecordResponse[] = [];
      for (const entry of prepared) {
        const saved = savedByIndex.get(entry.index);
        if (saved) created.push(recordResponse(saved));
      }

      // Project all newly published records with one LDS batch (or one rebuild
      // when the dataset has no datasource yet).
      const publishedRecords = prepared
        .map((entry) => savedByIndex.get(entry.index)?.data)
        .filter((record): record is CapabilityRecord => !!record && isRecordPublished(dataset, record));
      let projected = dataset;
      if (publishedRecords.length) {
        if (dataset.ldsDatasourceId) {
          await ingestRecords(client, dataset, dataset.ldsDatasourceId, publishedRecords);
        } else {
          projected = (await rebuildProjection(client, dataset, undefined, {
            correlationId: correlationIdOf(req), idempotencyKey,
          })).data;
        }
      }

      // Publish record events with bounded concurrency. A sequential loop of
      // 100 queue publishes dominated the import latency; five in flight keeps
      // the per-record event contract without making the caller wait seconds.
      const eventEntries = prepared.filter((entry) => savedByIndex.has(entry.index));
      for (let offset = 0; offset < eventEntries.length; offset += 5) {
        const wave = eventEntries.slice(offset, offset + 5);
        const delivered = await Promise.all(wave.map(async (entry) => {
          const saved = savedByIndex.get(entry.index)!;
          const event = buildEvent('record.created', {
            datasetId, recordId: saved.id, at: saved.data.createdAt, correlationId: correlationIdOf(req),
          }, idempotencyKey ? `${idempotencyKey}:${entry.index}` : undefined);
          const emitted = await emitEvent(client, config, projected, event);
          return emitted.delivered;
        }));
        if (delivered.some((ok) => !ok)) pendingEvents = true;
      }

      const response = { created, errors, total: created.length };
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'record.bulk_create',
        datasetId, correlationId: correlationIdOf(req),
        details: { requested: entries.length, created: created.length, failed: errors.length },
      });
      if (pendingEvents) res.setHeader('x-event-status', 'pending');
      setVersionHeaders(res, datasetVersion);
      const responseStatus = errors.length && !created.length ? 400 : 200;
      res.status(responseStatus).json(response);
      await claim?.complete(responseStatus, response);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.post('/v1/capabilities/datasets/:id/records', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, principal, client } = await writeContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const data = requireData(body);
    const publish = publishFlag(body);
    if (publish === true) requirePublishable(dataset);
    const id = body.id !== undefined ? validateRecordId(body.id) : randomUUID();
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, principal.tenantKey, idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      const now = new Date().toISOString();
      const record: CapabilityRecord = {
        id, datasetId, data, createdAt: now, updatedAt: now,
        ...(publish !== undefined ? { published: publish } : {}),
      };
      let saved: StoredDocument<CapabilityRecord>;
      try {
        const document = await client.base.createDocument(COLLECTIONS.records, {
          id, data: record as unknown as Record<string, unknown>,
        });
        saved = { id: document.id, version: document.version, data: document.data as unknown as CapabilityRecord };
      } catch (error) {
        if (error instanceof SynapseOneError && error.status === 409) throw apiError(409, 'record_already_exists', 'record already exists');
        throw error;
      }
      const projected = await projectNewRecord(
        client, dataset, saved.data, correlationIdOf(req), idempotencyKey,
      );
      const event = buildEvent('record.created', {
        datasetId, recordId: id, at: now, correlationId: correlationIdOf(req),
      }, idempotencyKey);
      const emitted = await emitEvent(client, config, projected, event);
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'record.create',
        datasetId, recordId: id, correlationId: correlationIdOf(req),
        details: { published: isRecordPublished(projected, saved.data) },
      });
      const response = recordResponse(saved);
      res.setHeader('location', `/v1/capabilities/datasets/${encodeURIComponent(datasetId)}/records/${encodeURIComponent(id)}`);
      if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
      res.status(201).json(response);
      await claim?.complete(201, response);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.get('/v1/capabilities/datasets/:id/records/:recordId', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, client } = await readContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'records');
    const document = await loadRecord({ client }, dataset, String(req.params.recordId));
    setVersionHeaders(res, document.version);
    res.json(recordResponse(document));
  }));

  app.patch('/v1/capabilities/datasets/:id/records/:recordId', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, principal, client } = await writeContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const data = requireData(body);
    const publish = publishFlag(body);
    if (publish === true) requirePublishable(dataset);
    const document = await loadRecord({ client }, dataset, String(req.params.recordId));
    const requestedVersion = expectedVersion(req, body);
    requireVersionMatch(requestedVersion, document.version, 'record');
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, principal.tenantKey, idempotencyKey,
      requestFingerprint('PATCH', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      const old = document.data;
      const wasPublished = isRecordPublished(dataset, old);
      const now = new Date().toISOString();
      const updated: CapabilityRecord = {
        ...old,
        data,
        updatedAt: now,
        ...(publish !== undefined ? { published: publish } : {}),
      };
      const savedDoc = await client.base.updateDocument(COLLECTIONS.records, document.id, {
        data: updated as unknown as Record<string, unknown>,
        ifVersion: requestedVersion ?? document.version,
      }).catch((error: unknown) => {
        if (error instanceof SynapseOneError && error.status === 409) {
          throw apiError(409, 'version_conflict', 'the record was modified by another request');
        }
        throw error;
      });
      const saved: StoredDocument<CapabilityRecord> = {
        id: savedDoc.id, version: savedDoc.version, data: savedDoc.data as unknown as CapabilityRecord,
      };
      const projected = await projectAfterChange(
        client, dataset, saved.data, wasPublished, undefined, correlationIdOf(req), idempotencyKey,
      );
      const event = buildEvent('record.updated', {
        datasetId, recordId: saved.id, at: now, correlationId: correlationIdOf(req),
        payload: {
          published: isRecordPublished(projected, saved.data),
          ...(publish !== undefined ? { publicationChanged: publish !== wasPublished } : {}),
        },
      }, idempotencyKey);
      const emitted = await emitEvent(client, config, projected, event);
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'record.update',
        datasetId, recordId: saved.id, correlationId: correlationIdOf(req),
        details: { published: isRecordPublished(projected, saved.data) },
      });
      const response = recordResponse(saved);
      if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
      setVersionHeaders(res, saved.version);
      res.json(response);
      await claim?.complete(200, response);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.delete('/v1/capabilities/datasets/:id/records/:recordId', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, principal, client } = await writeContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const document = await loadRecord({ client }, dataset, String(req.params.recordId));
    const requestedVersion = expectedVersion(req, body);
    requireVersionMatch(requestedVersion, document.version, 'record');
    const wasPublished = isRecordPublished(dataset, document.data);
    try {
      await client.base.deleteDocument(COLLECTIONS.records, document.id, {
        ...(requestedVersion ? { ifVersion: requestedVersion } : {}),
      });
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 404) throw apiError(404, 'record_not_found', 'record not found');
      if (error instanceof SynapseOneError && error.status === 409) throw apiError(409, 'version_conflict', 'the record was modified by another request');
      throw error;
    }
    let projected = dataset;
    if (wasPublished) {
      projected = (await rebuildProjection(client, dataset, undefined, {
        correlationId: correlationIdOf(req), idempotencyKey: idempotencyKeyOf(req),
      })).data;
    }
    const event = buildEvent('record.deleted', {
      datasetId, recordId: document.id, correlationId: correlationIdOf(req),
    }, idempotencyKeyOf(req));
    const emitted = await emitEvent(client, config, projected, event);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'record.delete',
      datasetId, recordId: document.id, correlationId: correlationIdOf(req),
    });
    if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
    res.status(204).end();
  }));

  app.post('/v1/capabilities/datasets/:id/records/purge-expired', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.params.id));
    const { caller, principal, client } = await writeContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    if (!dataset.retentionDays) {
      throw apiError(409, 'retention_not_configured', 'set retentionDays on the dataset before purging expired records');
    }
    const result = await purgeExpiredRecords(client, config, dataset, new Date(), correlationIdOf(req));
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'record.purge_expired',
      datasetId, correlationId: correlationIdOf(req), details: { purged: result.purged, cutoff: result.cutoff },
    });
    res.json(result);
  }));
}

export interface PurgeResult {
  purged: number;
  scanned: number;
  cutoff: string;
}

/**
 * Delete records older than the dataset retention window and rebuild the
 * projection once. Exported so the scheduled-jobs path and tests share it.
 */
export async function purgeExpiredRecords(
  client: import('@synapseone/sdk').SynapseOneClient,
  config: ServiceConfig,
  dataset: DatasetRecord,
  now: Date,
  correlationId: string,
): Promise<PurgeResult> {
  if (!dataset.retentionDays) throw apiError(409, 'retention_not_configured', 'dataset has no retention policy');
  const cutoffMs = now.getTime() - dataset.retentionDays * 86400_000;
  const records = await listDatasetRecords(client, dataset.id);
  let purged = 0;
  let projectionDirty = false;
  for (const record of records) {
    const created = Date.parse(record.data.createdAt);
    if (!Number.isFinite(created) || created >= cutoffMs) continue;
    try {
      await client.base.deleteDocument(COLLECTIONS.records, record.id);
      purged += 1;
      if (isRecordPublished(dataset, record.data)) projectionDirty = true;
    } catch (error) {
      if (!(error instanceof SynapseOneError && error.status === 404)) throw error;
    }
  }
  if (projectionDirty && dataset.status === 'published') {
    await rebuildProjection(client, dataset, undefined, { correlationId });
  }
  if (purged) {
    await emitEvent(client, config, dataset, buildEvent('retention.purged', {
      datasetId: dataset.id,
      correlationId,
      at: now.toISOString(),
      payload: { purged, cutoff: new Date(cutoffMs).toISOString() },
    }));
  }
  return { purged, scanned: records.length, cutoff: new Date(cutoffMs).toISOString() };
}
