// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 platform plumbing: Tier-1 clients, collections, documents, pagination,
 * capability events (queue + stream outbox), idempotency and audit projection.
 *
 * All persistence and messaging goes through @synapseone/sdk. There is no
 * Tier-2 database, queue, cache or filesystem store; the only process-local
 * state is the per-request auth result.
 */
import { createHash, randomUUID } from 'node:crypto';
import { BaseFilter, BaseQueryResult, SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from './config';
import { apiError } from './errors';

export const COLLECTIONS = {
  datasets: 'synapsedx_capability_datasets',
  records: 'synapsedx_capability_records',
  jobs: 'synapsedx_capability_jobs',
  jobRuns: 'synapsedx_capability_job_runs',
  files: 'synapsedx_capability_files',
  notificationTemplates: 'synapsedx_capability_notification_templates',
  notificationRefs: 'synapsedx_capability_notification_refs',
  notificationPreferences: 'synapsedx_capability_notification_preferences',
  audit: 'synapsedx_capability_audit',
} as const;

export type DatasetStatus = 'draft' | 'published' | 'revoked';

export interface CapabilityEvent {
  eventId: string;
  type: 'dataset.created' | 'dataset.updated' | 'dataset.published' | 'dataset.revoked' | 'dataset.deleted'
    | 'record.created' | 'record.updated' | 'record.deleted' | 'retention.purged';
  schemaVersion: 1;
  datasetId: string;
  recordId?: string;
  version?: string;
  at: string;
  correlationId: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
}

export interface DatasetRecord {
  id: string;
  slug: string;
  name: string;
  entityType: string;
  license: string;
  licenseUrl?: string;
  description?: string;
  public: boolean;
  owner?: string;
  tenant?: string;
  schemaVersion: string;
  status: DatasetStatus;
  ldsDatasourceId?: string;
  retentionDays?: number;
  everPublished?: boolean;
  pendingEvents?: CapabilityEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRecord {
  id: string;
  datasetId: string;
  data: Record<string, unknown>;
  /** Explicit per-record publication decision. undefined = inherit dataset. */
  published?: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface StoredDocument<T> {
  id: string;
  version: number;
  data: T;
  createdAt?: string;
  updatedAt?: string;
}

export interface JobSchedule {
  cron?: string;
  everySeconds?: number;
}

export interface JobRecord {
  id: string;
  name: string;
  kind: string;
  /** `workflow` = Tier-1 cron workflow; `runner` = Tier-3 lease contract. */
  executor: 'workflow' | 'runner';
  schedule: JobSchedule;
  payload?: Record<string, unknown>;
  datasetId?: string;
  enabled: boolean;
  workflowId: string;
  tenant?: string;
  timeoutSeconds?: number;
  maxAttempts?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  id: string;
  at: string;
  actor: string;
  tenant: string;
  action: string;
  datasetId?: string;
  recordId?: string;
  correlationId: string;
  details?: Record<string, unknown>;
}

export function serviceClient(config: ServiceConfig, timeoutMs?: number): SynapseOneClient {
  return new SynapseOneClient({
    baseUrl: config.tier1BaseUrl,
    ...(config.serviceToken ? { token: config.serviceToken } : {}),
    ...(config.serviceApiKey ? { apiKey: config.serviceApiKey } : {}),
    ...(config.serviceTenant ? { tenant: config.serviceTenant } : {}),
    timeoutMs: timeoutMs ?? config.requestTimeoutMs,
  });
}

/** Credential-free client for public Tier-1 auth flows (login/refresh/OIDC). */
export function anonymousClient(config: ServiceConfig, timeoutMs?: number): SynapseOneClient {
  return new SynapseOneClient({
    baseUrl: config.tier1BaseUrl,
    timeoutMs: timeoutMs ?? config.requestTimeoutMs,
  });
}

export function documentData<T>(document: any): T {
  return (document?.data ?? document?.object ?? document) as T;
}

export function storedDocument<T>(document: any): StoredDocument<T> {
  return {
    id: String(document?.id ?? ''),
    version: Number(document?.version ?? 0),
    data: documentData<T>(document),
    ...(document?.createdAt ? { createdAt: String(document.createdAt) } : {}),
    ...(document?.updatedAt ? { updatedAt: String(document.updatedAt) } : {}),
  };
}

export function isNotFound(error: unknown): boolean {
  return error instanceof SynapseOneError && error.status === 404;
}

export function isConflict(error: unknown): boolean {
  return error instanceof SynapseOneError && error.status === 409;
}

export async function ensureCollections(client: SynapseOneClient): Promise<void> {
  for (const name of Object.values(COLLECTIONS)) {
    try {
      await client.base.getCollection(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await client.base.createCollection({ name, description: `SynapseDX capability ${name}` });
      } catch (createError) {
        // A concurrent creator returns a conflict; that is success.
        if (!isConflict(createError)) throw createError;
      }
    }
  }
}

export async function getDocumentOrNull<T>(
  client: SynapseOneClient,
  collection: string,
  id: string,
): Promise<StoredDocument<T> | null> {
  try {
    return storedDocument<T>(await client.base.getDocument(collection, id, { as: 'data' }));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export interface QueryOptions {
  where?: BaseFilter | BaseFilter[] | Record<string, unknown>;
  orderBy?: { field: string; direction?: 'asc' | 'desc' } | string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export async function queryDocuments<T>(
  client: SynapseOneClient,
  collection: string,
  options: QueryOptions,
): Promise<{ items: StoredDocument<T>[]; total: number; limit: number; offset: number; nextCursor: string | null }> {
  let result: BaseQueryResult<any>;
  try {
    result = await client.base.queryDocuments(collection, {
      ...(options.where ? { where: options.where } : {}),
      ...(options.orderBy ? { orderBy: options.orderBy as any } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      as: 'data',
    }) as BaseQueryResult<any>;
  } catch (error) {
    if (isNotFound(error)) {
      return { items: [], total: 0, limit: options.limit || 0, offset: options.offset || 0, nextCursor: null };
    }
    if (error instanceof SynapseOneError && error.status === 413) {
      throw apiError(503, 'dependency_unavailable', 'the capability collection is too large for a single Tier-1 query', {
        dependency: 'synapseone-base',
        reason: 'query_scan_limit',
      });
    }
    throw error;
  }
  return {
    items: (result.items || []).map((item) => storedDocument<T>(item)),
    total: Number(result.total || 0),
    limit: Number(result.limit || options.limit || 0),
    offset: Number(result.offset || options.offset || 0),
    nextCursor: result.nextCursor ?? null,
  };
}

/** Read every page of a filtered query (bounded, used for projections/purges). */
export async function collectAll<T>(
  client: SynapseOneClient,
  collection: string,
  options: Omit<QueryOptions, 'limit' | 'offset' | 'cursor'>,
  pageSize = 500,
  maxDocuments = 20000,
): Promise<StoredDocument<T>[]> {
  const all: StoredDocument<T>[] = [];
  let offset = 0;
  while (offset < maxDocuments) {
    const result = await queryDocuments<T>(client, collection, { ...options, limit: pageSize, offset });
    all.push(...result.items);
    if (result.items.length < pageSize) break;
    offset += result.items.length;
  }
  return all;
}

/* ------------------------------------------------------------------------- *
 * Capability events
 * ------------------------------------------------------------------------- */

/** Deterministic event id so retries with the same idempotency key dedupe. */
export function eventIdFor(parts: Array<string | undefined>): string {
  const hash = createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex');
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

async function ensureQueue(client: SynapseOneClient, queue: string): Promise<void> {
  try {
    await client.queue.createQueue(queue, { maxAttempts: 8, visibilityTimeoutSeconds: 30 });
  } catch (error) {
    if (!(error instanceof SynapseOneError && (error.status === 400 || error.status === 409))) throw error;
  }
}

async function publishToQueue(client: SynapseOneClient, queue: string, event: CapabilityEvent): Promise<void> {
  try {
    await client.queue.publish(queue, event, { id: event.eventId, dedupeKey: event.eventId });
  } catch (error) {
    // A publish-only key cannot create the queue; only create it when the
    // publish reports that it does not exist.
    if (!isNotFound(error)) throw error;
    await ensureQueue(client, queue);
    await client.queue.publish(queue, event, { id: event.eventId, dedupeKey: event.eventId });
  }
}

async function publishToStream(client: SynapseOneClient, topic: string, event: CapabilityEvent): Promise<void> {
  // Stream ids must look like `<ms>-<seq>`; the event id lives in the payload.
  // Delivery is at-least-once, so consumers dedupe on `event.eventId`.
  try {
    await client.stream.publish(topic, event, { key: event.datasetId });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      await client.stream.createTopic(topic, { maxLen: 100000, retentionMs: 604800000 });
      await client.stream.publish(topic, event, { key: event.datasetId });
    } catch (createError) {
      if (createError instanceof SynapseOneError && (createError.status === 400 || createError.status === 409)) {
        await client.stream.publish(topic, event, { key: event.datasetId });
        return;
      }
      throw createError;
    }
  }
}

/**
 * Publish one capability event to the Tier-1 queue (durable delivery) and the
 * stream topic (non-destructive consumption by Tier-3 with a cursor).
 */
export async function publishEvent(client: SynapseOneClient, config: ServiceConfig, event: CapabilityEvent): Promise<void> {
  await publishToQueue(client, config.eventsQueue, event);
  try {
    await publishToStream(client, config.eventsStream, event);
  } catch (error) {
    // The queue is the delivery guarantee; the stream feed is best-effort and
    // its failure must not turn a successful write into a 5xx.
    console.warn(`[synapsedx] event ${event.eventId} queued but stream publish failed: ${(error as Error).message}`);
  }
}

export function buildEvent(
  type: CapabilityEvent['type'],
  fields: Omit<CapabilityEvent, 'eventId' | 'schemaVersion' | 'at' | 'type'> & { at?: string },
  idempotencyKey?: string,
): CapabilityEvent {
  const at = fields.at || new Date().toISOString();
  return {
    eventId: eventIdFor([idempotencyKey || fields.correlationId, type, fields.datasetId, fields.recordId, fields.version]),
    type,
    schemaVersion: 1,
    datasetId: fields.datasetId,
    ...(fields.recordId ? { recordId: fields.recordId } : {}),
    ...(fields.version ? { version: fields.version } : {}),
    at,
    correlationId: fields.correlationId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(fields.payload ? { payload: fields.payload } : {}),
  };
}

export interface EmitResult {
  delivered: boolean;
  event: CapabilityEvent;
}

/**
 * Emit an event and fall back to the dataset outbox when the queue is down.
 * The write itself never fails because the event transport is unavailable.
 */
export async function emitEvent(
  client: SynapseOneClient,
  config: ServiceConfig,
  dataset: DatasetRecord,
  event: CapabilityEvent,
): Promise<EmitResult> {
  const pending = await flushPendingEvents(client, config, dataset);
  const merged = { ...dataset, ...pending };
  try {
    await publishEvent(client, config, event);
    return { delivered: true, event };
  } catch (error) {
    console.warn(`[synapsedx] event ${event.eventId} pending in outbox: ${(error as Error).message}`);
    const queue = [...(merged.pendingEvents || []), event].slice(-50);
    try {
      const doc = await getDocumentOrNull<DatasetRecord>(client, COLLECTIONS.datasets, dataset.id);
      if (doc) {
        await client.base.updateDocument(COLLECTIONS.datasets, dataset.id, {
          data: { ...doc.data, pendingEvents: queue, updatedAt: new Date().toISOString() } as unknown as Record<string, unknown>,
          ...(doc.version ? { ifVersion: doc.version } : {}),
        });
      }
    } catch (outboxError) {
      console.error(`[synapsedx] failed to persist event outbox for ${dataset.id}: ${(outboxError as Error).message}`);
    }
    return { delivered: false, event };
  }
}

/** Retry events left in the dataset outbox; returns the updated dataset fields. */
export async function flushPendingEvents(
  client: SynapseOneClient,
  config: ServiceConfig,
  dataset: DatasetRecord,
): Promise<Partial<DatasetRecord>> {
  if (!dataset.pendingEvents?.length) return {};
  const remaining: CapabilityEvent[] = [];
  for (const event of dataset.pendingEvents) {
    try {
      await publishEvent(client, config, event);
    } catch {
      remaining.push(event);
    }
  }
  if (remaining.length === dataset.pendingEvents.length) return {};
  const updated = { pendingEvents: remaining, updatedAt: new Date().toISOString() };
  try {
    const doc = await getDocumentOrNull<DatasetRecord>(client, COLLECTIONS.datasets, dataset.id);
    if (doc) {
      await client.base.updateDocument(COLLECTIONS.datasets, dataset.id, {
        data: { ...doc.data, ...updated } as unknown as Record<string, unknown>,
        ...(doc.version ? { ifVersion: doc.version } : {}),
      });
    }
  } catch (error) {
    console.warn(`[synapsedx] failed to clear event outbox for ${dataset.id}: ${(error as Error).message}`);
  }
  return updated;
}

/* ------------------------------------------------------------------------- *
 * Idempotency (Tier-1 Faststore; no Tier-2 store)
 * ------------------------------------------------------------------------- */

export interface IdempotencyClaim {
  key: string;
  replay?: { status: number; body: unknown };
  complete(status: number, body: unknown): Promise<void>;
  release(): Promise<void>;
}

interface IdempotencyRecord {
  state: 'in_progress' | 'completed';
  fingerprint: string;
  status?: number;
  body?: unknown;
  at: string;
}

function idempotencyStoreKey(tenant: string, key: string): string {
  return `synapsedx:idem:${tenant.replace(/[^A-Za-z0-9_.@:-]/g, '_')}:${key}`;
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method}|${path}|${JSON.stringify(body ?? null)}`).digest('hex');
}

/**
 * Claim an Idempotency-Key. Returns undefined when the caller did not send one.
 * A completed claim replays the stored response; an in-flight claim returns 409.
 */
export async function claimIdempotency(
  client: SynapseOneClient,
  config: ServiceConfig,
  tenant: string,
  key: string | undefined,
  fingerprint: string,
): Promise<IdempotencyClaim | undefined> {
  if (!key) return undefined;
  if (!config.idempotencyEnabled) {
    throw apiError(503, 'idempotency_unavailable', 'idempotency is disabled on this deployment');
  }
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) {
    throw apiError(400, 'idempotency_key_required', 'Idempotency-Key must be 8..200 characters of [A-Za-z0-9_.:-]');
  }
  const storeKey = idempotencyStoreKey(tenant, key);
  const ttl = config.idempotencyTtlSeconds;
  const read = async (): Promise<IdempotencyRecord | null> => {
    try {
      const raw: any = await client.faststore.get(storeKey);
      if (!raw) return null;
      // Faststore returns `{key,type,value,ttlSeconds}`; accept a bare value too.
      const value = raw && typeof raw === 'object' && 'value' in raw && 'type' in raw ? raw.value : raw;
      if (value === null || value === undefined) return null;
      return (typeof value === 'string' ? JSON.parse(value) : value) as IdempotencyRecord;
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof SynapseOneError && (error.status === 401 || error.status === 403)) {
        throw apiError(503, 'idempotency_unavailable', 'the idempotency store rejected the service credential');
      }
      throw apiError(503, 'idempotency_unavailable', 'the idempotency store is unavailable');
    }
  };
  const existing = await read();
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw apiError(409, 'idempotency_key_reuse', 'this Idempotency-Key was used with a different request body');
    }
    if (existing.state === 'completed') {
      return {
        key: storeKey,
        replay: { status: Number(existing.status || 200), body: existing.body },
        complete: async () => undefined,
        release: async () => undefined,
      };
    }
    throw apiError(409, 'idempotency_in_progress', 'a request with this Idempotency-Key is still in progress');
  }
  try {
    await client.faststore.set(storeKey, { state: 'in_progress', fingerprint, at: new Date().toISOString() }, { ifNotExists: true, ttlSeconds: ttl });
  } catch (error) {
    if (error instanceof SynapseOneError && (error.status === 409 || error.status === 400)) {
      throw apiError(409, 'idempotency_in_progress', 'a request with this Idempotency-Key is still in progress');
    }
    throw apiError(503, 'idempotency_unavailable', 'the idempotency store is unavailable');
  }
  return {
    key: storeKey,
    complete: async (status, body) => {
      try {
        await client.faststore.set(storeKey, {
          state: 'completed', fingerprint, status, body, at: new Date().toISOString(),
        }, { ttlSeconds: ttl });
      } catch (error) {
        console.warn(`[synapsedx] failed to complete idempotency record: ${(error as Error).message}`);
      }
    },
    release: async () => {
      try {
        await client.faststore.delete(storeKey);
      } catch {
        /* lease expires on its own */
      }
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Audit projection (Tier-1 Base collection, best-effort)
 * ------------------------------------------------------------------------- */

export async function recordAudit(
  client: SynapseOneClient,
  config: ServiceConfig,
  entry: Omit<AuditRecord, 'id' | 'at'> & { at?: string },
): Promise<void> {
  if (!config.auditEnabled) return;
  const record: AuditRecord = {
    id: randomUUID(),
    at: entry.at || new Date().toISOString(),
    ...entry,
  };
  try {
    await client.base.createDocument(COLLECTIONS.audit, { id: record.id, data: record as unknown as Record<string, unknown> });
  } catch (error) {
    if (isNotFound(error)) {
      try {
        await ensureCollections(client);
        await client.base.createDocument(COLLECTIONS.audit, { id: record.id, data: record as unknown as Record<string, unknown> });
        return;
      } catch (retryError) {
        console.warn(`[synapsedx] audit write failed: ${(retryError as Error).message}`);
        return;
      }
    }
    console.warn(`[synapsedx] audit write failed: ${(error as Error).message}`);
  }
}

export function correlationIdOf(req: { synapseDxRequestId?: string; header(name: string): string | undefined }): string {
  return req.synapseDxRequestId || req.header('x-correlation-id') || randomUUID();
}

export function idempotencyKeyOf(req: { header(name: string): string | undefined }): string | undefined {
  const value = req.header('idempotency-key') || req.header('x-idempotency-key');
  return value?.trim() || undefined;
}
