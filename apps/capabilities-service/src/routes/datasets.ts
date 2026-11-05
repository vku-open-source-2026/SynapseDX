// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Dataset CRUD, lifecycle and public entity projection routes. */
import { Express, Request, Response } from 'express';
import { SynapseOneError } from '@synapseone/sdk';
import { CallerPrincipal, canAccessDataset, isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { DATASET_SLUG_RE, slugifyDataset, validateDatasetId } from '../ids';
import { validateEntityType, validateLicense, validateRetentionDays, validateSchemaVersion } from '../licenses';
import { loadManagementSettings } from '../settings';
import { booleanParam, parsePagination, setPageHeaders, stringParam } from '../pagination';
import {
  COLLECTIONS, DatasetRecord, buildEvent, claimIdempotency, correlationIdOf, emitEvent,
  ensureCollections, idempotencyKeyOf, queryDocuments, recordAudit, requestFingerprint,
} from '../platform';
import {
  listDatasetRecords, loadDataset, publishDataset, revokeDataset, revokeProjection, syncDatasourceMetadata,
} from '../publication';
import {
  accessibleDataset, expectedVersion, readContext, requireVersionMatch, setVersionHeaders, writeContext,
} from './shared';
import { assertDatasetPublishable } from './data-insights';

function idempotencyTenant(principal: CallerPrincipal): string {
  return principal.tenantKey;
}

async function assertReviewPolicy(
  client: import('@synapseone/sdk').SynapseOneClient,
  tenant: string,
  dataset: DatasetRecord,
): Promise<void> {
  const settings = await loadManagementSettings(client, tenant);
  if (settings.requireReview && dataset.reviewStatus !== 'approved') {
    throw apiError(409, 'review_required', 'this tenant requires moderator approval before publication', {
      reviewStatus: dataset.reviewStatus || 'none',
    });
  }
}

function datasetBody(body: Record<string, unknown>, existing?: DatasetRecord) {
  return {
    name: body.name !== undefined ? String(body.name).trim() : existing?.name,
    entityType: body.entityType !== undefined ? validateEntityType(body.entityType) : existing?.entityType,
    license: body.license !== undefined ? String(body.license) : existing?.license,
    licenseUrl: body.licenseUrl !== undefined ? String(body.licenseUrl) : existing?.licenseUrl,
    description: body.description !== undefined ? String(body.description) : existing?.description,
    schemaVersion: body.schemaVersion !== undefined ? validateSchemaVersion(body.schemaVersion) : existing?.schemaVersion,
    retentionDays: body.retentionDays !== undefined
      ? validateRetentionDays(body.retentionDays)
      : existing?.retentionDays,
  };
}

export function registerDatasetRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/datasets', handler(async (req, res) => {
    const { caller, principal, client } = await readContext(req, config);
    const pagination = parsePagination(req, config.maxPageSize);
    const requestedPublic = booleanParam(req.query.publicOnly) === true;
    const publicOnly = requestedPublic || !caller.authenticated;
    const status = stringParam(req.query.status, 32);
    const where = publicOnly
      ? { public: true, status: 'published' }
      : principal && !isAdmin(principal)
        ? { or: [{ tenant: principal.tenantKey }, { tenant: { exists: false } }] }
        : undefined;
    const combined = where && status && status !== 'published'
      ? { and: [where, { status }] }
      : where;
    const result = await queryDocuments<DatasetRecord>(client, COLLECTIONS.datasets, {
      ...(combined ? { where: combined } : {}),
      orderBy: { field: 'id', direction: 'asc' },
      limit: pagination.limit,
      offset: pagination.offset,
      ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
    });
    const items = result.items.map((item) => ({ ...item.data }));
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json(items);
  }));

  app.post('/v1/capabilities/datasets', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const id = slugifyDataset(body.slug ?? body.id ?? body.name);
    if (!DATASET_SLUG_RE.test(id)) throw apiError(400, 'invalid_slug', 'a valid slug or name is required');
    const publicFlag = body.public === true;
    const requested = datasetBody(body) as { name?: string; entityType?: string; license?: string; schemaVersion?: string };
    if (!requested.name) throw apiError(400, 'field_required', 'name is required', { field: 'name' });
    if (!requested.entityType) throw apiError(400, 'field_required', 'entityType is required', { field: 'entityType' });
    if (!requested.license) throw apiError(400, 'field_required', 'license is required', { field: 'license' });
    const license = await validateLicense(client, config, requested.license, {
      public: publicFlag,
      ...(body.licenseUrl !== undefined ? { licenseUrl: String(body.licenseUrl) } : {}),
    });
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, idempotencyTenant(principal), idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      await ensureCollections(client);
      const now = new Date().toISOString();
      const dataset: DatasetRecord = {
        id,
        slug: id,
        name: requested.name,
        entityType: requested.entityType,
        license: license.license,
        ...(license.licenseUrl ? { licenseUrl: license.licenseUrl } : {}),
        ...(body.description ? { description: String(body.description) } : {}),
        public: publicFlag,
        owner: principal.subject,
        tenant: principal.tenantKey,
        schemaVersion: requested.schemaVersion || '1.0.0',
        ...(body.retentionDays !== undefined ? { retentionDays: validateRetentionDays(body.retentionDays) } : {}),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      try {
        await client.base.createDocument(COLLECTIONS.datasets, { id, data: dataset as unknown as Record<string, unknown> });
      } catch (error) {
        if (error instanceof SynapseOneError && error.status === 409) throw apiError(409, 'dataset_already_exists', 'dataset already exists');
        throw error;
      }
      const event = buildEvent('dataset.created', {
        datasetId: id, version: dataset.schemaVersion, at: now,
        correlationId: correlationIdOf(req),
      }, idempotencyKey);
      const emitted = await emitEvent(client, config, dataset, event);
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'dataset.create',
        datasetId: id, correlationId: correlationIdOf(req), details: { public: publicFlag, license: dataset.license },
      });
      res.setHeader('location', `/v1/capabilities/datasets/${encodeURIComponent(id)}`);
      if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
      res.status(201).json(dataset);
      await claim?.complete(201, dataset);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.get('/v1/capabilities/datasets/:id', handler(async (req, res) => {
    const id = validateDatasetId(req.params.id);
    const { caller, client } = await readContext(req, config);
    const { document, data } = await accessibleDataset(client, id, caller, 'metadata');
    setVersionHeaders(res, document.version);
    res.json(data);
  }));

  app.patch('/v1/capabilities/datasets/:id', handler(async (req, res) => {
    const id = validateDatasetId(req.params.id);
    const { caller, principal, client } = await writeContext(req, config);
    const { document, data } = await accessibleDataset(client, id, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const requestedVersion = expectedVersion(req, body);
    requireVersionMatch(requestedVersion, document.version, 'dataset');
    const ifVersion = requestedVersion ?? document.version;

    const patch: Partial<DatasetRecord> = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw apiError(400, 'field_required', 'name is required', { field: 'name' });
      patch.name = name;
    }
    if (body.entityType !== undefined) patch.entityType = validateEntityType(body.entityType);
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.owner !== undefined) patch.owner = String(body.owner);
    if (body.licenseUrl !== undefined) patch.licenseUrl = String(body.licenseUrl);
    if (body.retentionDays !== undefined) patch.retentionDays = validateRetentionDays(body.retentionDays);
    if (body.schemaVersion !== undefined) patch.schemaVersion = validateSchemaVersion(body.schemaVersion);
    if (body.public !== undefined) {
      if (typeof body.public !== 'boolean') throw apiError(400, 'public_must_be_boolean', 'public must be a boolean');
      patch.public = body.public;
    }
    if (Object.keys(patch).length === 0) throw apiError(400, 'no_updatable_fields', 'no updatable fields were supplied');

    const working: DatasetRecord = { ...data, ...patch, updatedAt: new Date().toISOString() };
    const correlationId = correlationIdOf(req);
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, idempotencyTenant(principal), idempotencyKey,
      requestFingerprint('PATCH', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      if (body.license !== undefined) {
        const license = await validateLicense(client, config, String(body.license), {
          public: working.public,
          ...(working.licenseUrl ? { licenseUrl: working.licenseUrl } : {}),
        });
        working.license = license.license;
        if (license.licenseUrl) working.licenseUrl = license.licenseUrl;
      }
      let result = working;
      let resultVersion: number | undefined = document.version;
      let emitted = { delivered: true } as { delivered: boolean };
      if (working.public && working.status === 'draft' && working.license) {
        const catalog = await validateLicense(client, config, working.license, {
          public: true,
          ...(working.licenseUrl ? { licenseUrl: working.licenseUrl } : {}),
        });
        if (!catalog.openData) throw apiError(400, 'invalid_license', 'a public dataset requires an open-data license');
      }
      if (patch.public === false && data.status === 'published') {
        const transition = await revokeDataset(client, working, ifVersion, { correlationId, idempotencyKey, reason: 'unpublished' });
        result = transition.dataset.data;
        resultVersion = transition.dataset.document.version;
        if (transition.event) emitted = await emitEvent(client, config, result, transition.event);
      } else if (patch.public === true && data.status === 'revoked' && data.everPublished) {
        await assertReviewPolicy(client, principal.tenantKey, working);
        await assertDatasetPublishable(client, working);
        const transition = await publishDataset(client, working, ifVersion, { correlationId, idempotencyKey });
        result = transition.dataset.data;
        resultVersion = transition.dataset.document.version;
        if (transition.event) emitted = await emitEvent(client, config, result, transition.event);
      } else {
        const saved = await client.base.updateDocument(COLLECTIONS.datasets, working.id, {
          data: working as unknown as Record<string, unknown>,
          ifVersion,
        }).catch(async (error: unknown) => {
          if (error instanceof SynapseOneError && error.status === 409) {
            throw apiError(409, 'version_conflict', 'the dataset was modified by another request');
          }
          throw error;
        });
        result = saved.data as unknown as DatasetRecord;
        resultVersion = saved.version;
        if (result.ldsDatasourceId) {
          await syncDatasourceMetadata(client, result, result.ldsDatasourceId, result.public && result.status === 'published');
        }
        const event = buildEvent('dataset.updated', {
          datasetId: result.id, version: result.schemaVersion, at: result.updatedAt,
          correlationId, payload: { changes: Object.keys(patch) },
        }, idempotencyKey);
        emitted = await emitEvent(client, config, result, event);
      }
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'dataset.update',
        datasetId: result.id, correlationId, details: { changes: Object.keys(patch) },
      });
      if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
      setVersionHeaders(res, resultVersion);
      res.json(result);
      await claim?.complete(200, result);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.post('/v1/capabilities/datasets/:id/publish', handler(async (req, res) => {
    const id = validateDatasetId(req.params.id);
    const { caller, principal, client } = await writeContext(req, config);
    const { document, data } = await accessibleDataset(client, id, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const requestedVersion = expectedVersion(req, body);
    requireVersionMatch(requestedVersion, document.version, 'dataset');
    await assertReviewPolicy(client, principal.tenantKey, data);
    await assertDatasetPublishable(client, data);
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, idempotencyTenant(principal), idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      const transition = await publishDataset(client, data, requestedVersion ?? document.version, {
        correlationId: correlationIdOf(req), idempotencyKey,
      });
      const emitted = transition.event
        ? await emitEvent(client, config, transition.dataset.data, transition.event)
        : { delivered: true };
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'dataset.publish',
        datasetId: id, correlationId: correlationIdOf(req),
      });
      if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
      res.json(transition.dataset.data);
      await claim?.complete(200, transition.dataset.data);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.post('/v1/capabilities/datasets/:id/revoke', handler(async (req, res) => {
    const id = validateDatasetId(req.params.id);
    const { caller, principal, client } = await writeContext(req, config);
    const { document, data } = await accessibleDataset(client, id, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const requestedVersion = expectedVersion(req, body);
    requireVersionMatch(requestedVersion, document.version, 'dataset');
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, idempotencyTenant(principal), idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    try {
      const transition = await revokeDataset(client, data, requestedVersion ?? document.version, {
        correlationId: correlationIdOf(req), idempotencyKey,
      });
      const emitted = transition.event
        ? await emitEvent(client, config, transition.dataset.data, transition.event)
        : { delivered: true };
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'dataset.revoke',
        datasetId: id, correlationId: correlationIdOf(req),
      });
      if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
      res.json(transition.dataset.data);
      await claim?.complete(200, transition.dataset.data);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.delete('/v1/capabilities/datasets/:id', handler(async (req, res) => {
    const id = validateDatasetId(req.params.id);
    const { caller, principal, client } = await writeContext(req, config);
    const { document, data } = await accessibleDataset(client, id, caller, 'write');
    const body = (req.body || {}) as Record<string, unknown>;
    const requestedVersion = expectedVersion(req, body);
    requireVersionMatch(requestedVersion, document.version, 'dataset');
    const records = await listDatasetRecords(client, id);
    const purge = booleanParam(req.query.purgeRecords) === true;
    if (records.length && !purge) {
      throw apiError(409, 'dataset_not_empty', 'dataset still contains records; pass purgeRecords=true to cascade', { records: records.length });
    }
    if (purge) {
      for (const record of records) {
        try {
          await client.base.deleteDocument(COLLECTIONS.records, record.id);
        } catch (error) {
          if (!(error instanceof SynapseOneError && error.status === 404)) throw error;
        }
      }
    }
    await revokeProjection(client, data);
    try {
      await client.base.deleteDocument(COLLECTIONS.datasets, id);
    } catch (error) {
      if (!(error instanceof SynapseOneError && error.status === 404)) throw error;
    }
    const event = buildEvent('dataset.deleted', {
      datasetId: id, version: data.schemaVersion, correlationId: correlationIdOf(req),
      payload: { recordsPurged: purge ? records.length : 0 },
    }, idempotencyKeyOf(req));
    const emitted = await emitEvent(client, config, data, event);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'dataset.delete',
      datasetId: id, correlationId: correlationIdOf(req), details: { recordsPurged: records.length },
    });
    if (!emitted.delivered) res.setHeader('x-event-status', 'pending');
    res.status(204).end();
  }));

  app.get('/v1/capabilities/datasets/:id/entities', handler(async (req: Request, res: Response) => {
    const id = validateDatasetId(req.params.id);
    const { caller, client } = await readContext(req, config);
    const found = await loadDataset(client, id);
    if (!found) throw apiError(404, 'dataset_not_found', 'dataset not found');
    if (!caller.authenticated) {
      // Anonymous callers may only learn about datasets marked public; a
      // revoked/unpublished public dataset returns an empty projection.
      if (found.data.public !== true) throw apiError(404, 'dataset_not_found', 'dataset not found');
    } else if (!canAccessDataset(found.data, caller)) {
      throw apiError(404, 'dataset_not_found', 'dataset not found');
    }
    const { data } = found;
    const pagination = parsePagination(req, 500);
    if (!data.public || data.status !== 'published' || !data.ldsDatasourceId) {
      res.json([]);
      return;
    }
    const datasourceId = data.ldsDatasourceId;
    const [entities, datasource, stats] = await Promise.all([
      client.lds.entities(datasourceId, {
        limit: pagination.limit,
        offset: pagination.offset,
        visibility: 'public',
      }),
      client.lds.datasource(datasourceId).catch(() => null) as Promise<any>,
      client.lds.stats(datasourceId).catch(() => null) as Promise<any>,
    ]);
    const license = datasource?.license || data.license;
    const licenseUrl = datasource?.licenseUrl || data.licenseUrl;
    const contexts: string[] = Array.isArray(datasource?.contexts) && datasource.contexts.length
      ? datasource.contexts.map(String)
      : ['https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld'];
    const total = Number(stats?.records ?? entities.length);
    if (licenseUrl) res.setHeader('link', `<${licenseUrl}>; rel="license"`);
    if (license) res.setHeader('x-lds-license', String(license));
    res.setHeader('x-lds-datasource', String(datasource?.slug || data.slug));
    res.setHeader('x-lds-total', String(total));
    res.setHeader('x-lds-context', contexts[0]);
    res.setHeader('cache-control', 'public, max-age=60');
    setPageHeaders(res, { total, limit: pagination.limit, offset: pagination.offset, nextCursor: null });
    res.json(entities);
  }));
}
