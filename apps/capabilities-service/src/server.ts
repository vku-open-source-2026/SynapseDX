// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { SynapseOneError } from '@synapseone/sdk';
import {
  COLLECTIONS, CapabilityRecord, DatasetRecord, EVENTS_QUEUE, TIER1_URL, documentData,
  emitCapabilityEvent, ensureCollections, isNotFound, pageFromDocuments, tier1FromRequest,
} from './platform';

const app = express();
const PORT = Number(process.env.PORT || 8082);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN || 'https://synapsecity.sbs';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id,x-synapseone-tenant');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  next();
});
app.use((req, res, next) => {
  const correlationId = req.header('x-correlation-id') || randomUUID();
  res.setHeader('x-correlation-id', correlationId);
  (req as Request & { correlationId?: string }).correlationId = correlationId;
  next();
});

function numberParam(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 0), max) : fallback;
}

function slug(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function requireField(body: Record<string, unknown>, name: string): string {
  const value = String(body[name] || '').trim();
  if (!value) throw httpError(400, `field_required:${name}`);
  return value;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'data_must_be_an_object');
  return value as Record<string, unknown>;
}

async function getDataset(client: ReturnType<typeof tier1FromRequest>, id: string): Promise<{ id: string; data: DatasetRecord }> {
  try {
    const doc = await client.base.getDocument(COLLECTIONS.datasets, id, { as: 'data' });
    return { id: doc.id, data: documentData<DatasetRecord>(doc) };
  } catch (error) {
    if (isNotFound(error)) throw httpError(404, 'dataset_not_found');
    throw error;
  }
}

async function ensureLdsDatasource(client: ReturnType<typeof tier1FromRequest>, dataset: DatasetRecord): Promise<DatasetRecord> {
  if (dataset.ldsDatasourceId) return dataset;
  const created: any = await client.lds.createDatasource({
    name: dataset.name,
    slug: `synapsedx-${dataset.slug}`,
    entityType: dataset.entityType,
    license: dataset.license,
    description: dataset.description,
    // SynapseLDS datasource defaults are public|internal. Attribute-level
    // restricted visibility is used below when a dataset is not public.
    defaultVisibility: dataset.public ? 'public' : 'internal',
  });
  const datasourceId = String(created.id || created.datasourceId || '');
  if (!datasourceId) throw new Error('SynapseLDS did not return a datasource id');
  await client.lds.setAttributes(datasourceId, [
    { name: 'recordId', ngsiLdType: 'Property', visibility: dataset.public ? 'public' : 'restricted' },
    { name: 'data', ngsiLdType: 'Property', visibility: dataset.public ? 'public' : 'restricted' },
  ]);
  const updated = { ...dataset, ldsDatasourceId: datasourceId, status: 'published' as const, updatedAt: new Date().toISOString() };
  await client.base.updateDocument(COLLECTIONS.datasets, dataset.id, { data: updated });
  return updated;
}

async function publishExistingRecords(client: ReturnType<typeof tier1FromRequest>, dataset: DatasetRecord): Promise<void> {
  if (!dataset.ldsDatasourceId) return;
  const docs = await client.base.listDocuments(COLLECTIONS.records, { limit: 500 });
  const records = docs.map((doc: any) => documentData<CapabilityRecord>(doc)).filter((record) => record.datasetId === dataset.id);
  if (records.length) {
    await client.lds.ingest(dataset.ldsDatasourceId, records.map((record) => ({
      id: `urn:synapsedx:${dataset.slug}:${record.id}`,
      recordId: record.id,
      data: record.data,
    })));
  }
}

app.get('/health', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const tier1 = await client.call('GET', '/health');
    res.json({ status: 'ok', service: 'synapsedx-capabilities', tier: 2, tier1, tier1Url: TIER1_URL });
  } catch (error) { next(error); }
});

app.get('/ready', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const tier1 = await client.call('GET', '/ready');
    res.json({ status: 'ready', service: 'synapsedx-capabilities', tier: 2, tier1, queue: EVENTS_QUEUE });
  } catch (error) { next(error); }
});

app.get('/v1/capabilities', (_req, res) => res.json({
  service: 'synapsedx-capabilities', tier: 2, version: '0.1.0',
  capabilities: ['datasets', 'records', 'publication', 'events'],
  dependencies: { tier1: TIER1_URL },
}));

app.get('/v1/capabilities/datasets', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    await ensureCollections(client);
    const limit = numberParam(req.query.limit, 100, 500);
    const offset = numberParam(req.query.offset, 0, 1_000_000);
    const docs = await client.base.listDocuments(COLLECTIONS.datasets, { limit, offset });
    const publicOnly = String(req.query.publicOnly || '').toLowerCase() === 'true';
    const datasets = docs.map((doc: any) => ({ ...documentData<DatasetRecord>(doc) }))
      .filter((dataset: DatasetRecord) => !publicOnly || (dataset.public && dataset.status === 'published'));
    res.json(datasets);
  } catch (error) { next(error); }
});

app.post('/v1/capabilities/datasets', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    await ensureCollections(client);
    const body = bodyRecord(req.body);
    const id = slug(body.slug || body.name);
    const dataset: DatasetRecord = {
      id,
      slug: id,
      name: requireField(body, 'name'),
      entityType: requireField(body, 'entityType'),
      license: requireField(body, 'license'),
      ...(body.description ? { description: String(body.description) } : {}),
      ...(body.owner ? { owner: String(body.owner) } : {}),
      public: body.public === true,
      schemaVersion: String(body.schemaVersion || '1.0.0'),
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!dataset.id) throw httpError(400, 'valid_slug_required');
    try {
      await client.base.createDocument(COLLECTIONS.datasets, { id, data: dataset as unknown as Record<string, unknown> });
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 409) throw httpError(409, 'dataset_already_exists');
      throw error;
    }
    res.status(201).json(dataset);
  } catch (error) { next(error); }
});

app.get('/v1/capabilities/datasets/:id', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const dataset = await getDataset(client, req.params.id);
    res.json(dataset.data);
  } catch (error) { next(error); }
});

app.patch('/v1/capabilities/datasets/:id', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data } = await getDataset(client, req.params.id);
    const body = bodyRecord(req.body);
    const patch: Partial<DatasetRecord> = {};
    if (body.name !== undefined) patch.name = requireField(body, 'name');
    if (body.entityType !== undefined) patch.entityType = requireField(body, 'entityType');
    if (body.license !== undefined) patch.license = requireField(body, 'license');
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.owner !== undefined) patch.owner = String(body.owner);
    if (body.schemaVersion !== undefined) patch.schemaVersion = requireField(body, 'schemaVersion');
    if (body.public !== undefined) {
      if (typeof body.public !== 'boolean') throw httpError(400, 'public_must_be_boolean');
      patch.public = body.public;
    }
    if (Object.keys(patch).length === 0) throw httpError(400, 'no_updatable_fields');
    const updated: DatasetRecord = { ...data, ...patch, updatedAt: new Date().toISOString() };
    await client.base.updateDocument(COLLECTIONS.datasets, data.id, { data: updated as unknown as Record<string, unknown> });
    if (updated.ldsDatasourceId) {
      await client.lds.updateDatasource(updated.ldsDatasourceId, {
        name: updated.name,
        entityType: updated.entityType,
        license: updated.license,
        ...(updated.description ? { description: updated.description } : {}),
        defaultVisibility: updated.public ? 'public' : 'internal',
      });
    }
    await emitCapabilityEvent(client, {
      eventId: randomUUID(),
      type: 'dataset.updated',
      datasetId: updated.id,
      version: updated.schemaVersion,
      at: updated.updatedAt,
    });
    res.json(updated);
  } catch (error) { next(error); }
});

app.post('/v1/capabilities/datasets/:id/publish', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data } = await getDataset(client, req.params.id);
    if (!data.public) throw httpError(409, 'only_public_datasets_can_be_published');
    const published = await ensureLdsDatasource(client, data);
    await publishExistingRecords(client, published);
    await emitCapabilityEvent(client, { eventId: randomUUID(), type: 'dataset.published', datasetId: published.id, version: published.schemaVersion, at: new Date().toISOString() });
    res.json(published);
  } catch (error) { next(error); }
});

app.post('/v1/capabilities/datasets/:id/revoke', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data } = await getDataset(client, req.params.id);
    const revoked = { ...data, status: 'revoked' as const, updatedAt: new Date().toISOString() };
    await client.base.updateDocument(COLLECTIONS.datasets, data.id, { data: revoked });
    await emitCapabilityEvent(client, { eventId: randomUUID(), type: 'dataset.revoked', datasetId: data.id, at: revoked.updatedAt });
    res.json(revoked);
  } catch (error) { next(error); }
});

app.get('/v1/capabilities/datasets/:id/entities', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data } = await getDataset(client, req.params.id);
    if (!data.public || data.status !== 'published' || !data.ldsDatasourceId) return res.json([]);
    const entities = await client.lds.entities(data.ldsDatasourceId, {
      limit: numberParam(req.query.limit, 100, 500),
      offset: numberParam(req.query.offset, 0, 1_000_000),
      visibility: 'public',
    });
    res.json(entities);
  } catch (error) { next(error); }
});

app.get('/v1/capabilities/datasets/:id/records', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data } = await getDataset(client, req.params.id);
    const limit = numberParam(req.query.limit, 100, 500);
    const offset = numberParam(req.query.offset, 0, 1_000_000);
    const docs = await client.base.listDocuments(COLLECTIONS.records, { limit: Math.min(limit + offset, 500), offset: 0 });
    const filtered = docs.filter((doc: any) => documentData<CapabilityRecord>(doc).datasetId === data.id).slice(offset, offset + limit);
    res.json({
      items: filtered.map((doc: any) => {
        const record = documentData<CapabilityRecord>(doc);
        return { id: record.id, data: record.data, version: doc.version, createdAt: record.createdAt, updatedAt: record.updatedAt };
      }),
      total: filtered.length, limit, offset, nextCursor: null,
    });
  } catch (error) { next(error); }
});

app.post('/v1/capabilities/datasets/:id/records', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data: dataset } = await getDataset(client, req.params.id);
    await ensureCollections(client);
    const input = bodyRecord(req.body);
    const data = bodyRecord(input.data);
    const id = slug(input.id || randomUUID());
    const record: CapabilityRecord = { id, datasetId: dataset.id, data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await client.base.createDocument(COLLECTIONS.records, { id, data: record as unknown as Record<string, unknown> });
    const shouldPublish = input.publish === true || dataset.status === 'published';
    if (shouldPublish) {
      const published = dataset.status === 'published' ? dataset : await ensureLdsDatasource(client, dataset);
      await client.lds.ingest(published.ldsDatasourceId!, { id: `urn:synapsedx:${published.slug}:${record.id}`, recordId: record.id, data: record.data });
    }
    await emitCapabilityEvent(client, { eventId: randomUUID(), type: 'record.created', datasetId: dataset.id, recordId: record.id, at: record.createdAt });
    res.status(201).json({ id: record.id, data: record.data, createdAt: record.createdAt, updatedAt: record.updatedAt });
  } catch (error) { next(error); }
});

app.get('/v1/capabilities/datasets/:id/records/:recordId', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data: dataset } = await getDataset(client, req.params.id);
    const doc = await client.base.getDocument(COLLECTIONS.records, req.params.recordId, { as: 'data' });
    const record = documentData<CapabilityRecord>(doc);
    if (record.datasetId !== dataset.id) throw httpError(404, 'record_not_found');
    res.json({ id: doc.id, data: record.data, version: doc.version, createdAt: record.createdAt, updatedAt: record.updatedAt });
  } catch (error) { next(error); }
});

app.patch('/v1/capabilities/datasets/:id/records/:recordId', async (req, res, next) => {
  try {
    const client = tier1FromRequest(req);
    const { data: dataset } = await getDataset(client, req.params.id);
    const input = bodyRecord(req.body);
    const data = bodyRecord(input.data);
    const doc = await client.base.getDocument(COLLECTIONS.records, req.params.recordId, { as: 'data' });
    const old = documentData<CapabilityRecord>(doc);
    if (old.datasetId !== dataset.id) throw httpError(404, 'record_not_found');
    const record = { ...old, data, updatedAt: new Date().toISOString() };
    await client.base.updateDocument(COLLECTIONS.records, req.params.recordId, { data: record, ifVersion: doc.version });
    if (dataset.status === 'published' && dataset.ldsDatasourceId) {
      await client.lds.ingest(dataset.ldsDatasourceId, { id: `urn:synapsedx:${dataset.slug}:${record.id}`, recordId: record.id, data: record.data });
    }
    await emitCapabilityEvent(client, { eventId: randomUUID(), type: 'record.updated', datasetId: dataset.id, recordId: record.id, at: record.updatedAt });
    res.json({ id: record.id, data: record.data, updatedAt: record.updatedAt });
  } catch (error) { next(error); }
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(error?.status || (error instanceof SynapseOneError ? error.status : 500) || 500);
  const body = error instanceof SynapseOneError && error.body && typeof error.body === 'object' ? error.body : undefined;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error?.message || 'internal_error',
    ...(body ? { upstream: body } : {}),
  });
});

export function createServer() { return app; }

if (require.main === module) {
  app.listen(PORT, () => console.log(`[synapsedx] Tier-2 capabilities listening on :${PORT}; Tier-1=${TIER1_URL}`));
}

