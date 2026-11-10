// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * File/object-storage capability over Tier-1 SynapseOCS.
 *
 * Binary data lives in a Tier-1 SynapseOCS bucket; Tier-2 owns the file contract (id,
 * tenant/product ownership, dataset/record link, quotas, MIME/size limits,
 * checksums and presigned-URL policy). No file bytes or file index are stored
 * in the Tier-2 process; metadata is a Tier-1 Base document.
 *
 * Tenant isolation is enforced twice: metadata carries the caller tenant and
 * every storage key is prefixed with the same tenant, so a guessed id never
 * resolves for another tenant (404, never 403).
 */
import express, { Express } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { SynapseOneError } from '@synapseone/sdk';
import { isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { parsePagination, setPageHeaders } from '../pagination';
import {
  COLLECTIONS, StoredDocument, claimIdempotency, correlationIdOf, ensureCollections,
  getDocumentOrNull, idempotencyKeyOf, queryDocuments, recordAudit, requestFingerprint, serviceClient,
} from '../platform';
import { WriteContext, authenticatedReadContext, writeContext } from './shared';

export interface FileRecord {
  id: string;
  tenant: string;
  product?: string;
  owner: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256?: string;
  storageKey: string;
  /** Set for objects written through SynapseOCS; absent on legacy records. */
  ocsBucket?: string;
  datasetId?: string;
  recordId?: string;
  /** Explicitly public release/media objects may be read without a credential. */
  public?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256?: string;
  owner: string;
  datasetId?: string;
  recordId?: string;
  public?: boolean;
  downloadUrl: string;
  publicUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicFileView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256?: string;
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
}

const MIME_RE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;

function safeFilename(raw: unknown): string {
  const filename = String(raw || '').trim();
  if (!filename) throw apiError(400, 'field_required', 'filename is required', { field: 'filename' });
  if (filename.length > 255) throw apiError(400, 'invalid_request', 'filename must be at most 255 characters');
  if (/[/\\\0-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..') {
    throw apiError(400, 'invalid_request', 'filename must be a plain file name without path separators');
  }
  return filename;
}

function mimeType(raw: unknown, fallback = 'application/octet-stream'): string {
  const value = String(raw || fallback).trim().toLowerCase();
  if (!MIME_RE.test(value)) throw apiError(400, 'invalid_request', 'contentType must be a valid MIME type', { field: 'contentType' });
  return value;
}

function assertAllowedType(config: ServiceConfig, contentType: string): void {
  if (!config.filesAllowedTypes.length) return;
  if (!config.filesAllowedTypes.includes(contentType)) {
    throw apiError(415, 'file_type_not_allowed', 'this content type is not allowed on this deployment', {
      contentType,
      allowed: config.filesAllowedTypes,
    });
  }
}

function storageKey(config: ServiceConfig, tenant: string, id: string, filename: string): string {
  const segment = filename.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 160) || 'file';
  return `${config.filesPrefix}/${tenant}/${id}/${segment}`;
}

function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function view(record: FileRecord): FileView {
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    size: record.size,
    owner: record.owner,
    ...(record.checksumSha256 ? { checksumSha256: record.checksumSha256 } : {}),
    ...(record.datasetId ? { datasetId: record.datasetId } : {}),
    ...(record.recordId ? { recordId: record.recordId } : {}),
    ...(record.public ? { public: true, publicUrl: publicUrl(record.id) } : {}),
    downloadUrl: `/v1/capabilities/files/${encodeURIComponent(record.id)}/content`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function publicUrl(id: string): string {
  return `/v1/capabilities/public/files/${encodeURIComponent(id)}/content`;
}

function publicView(record: FileRecord): PublicFileView {
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    size: record.size,
    ...(record.checksumSha256 ? { checksumSha256: record.checksumSha256 } : {}),
    publicUrl: publicUrl(record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function canPublish(principal: { scopes: string[] }): boolean {
  return isAdmin(principal as any)
    || principal.scopes.some((scope) => scope === 'files:publish' || scope === 'storage:publish');
}

function visible(record: FileRecord, ctx: WriteContext | { principal: { tenantKey: string; scopes: string[] } }): boolean {
  return isAdmin(ctx.principal as any) || record.tenant === ctx.principal.tenantKey;
}

async function loadFile(
  client: any,
  id: string,
  ctx: { principal: { tenantKey: string; scopes: string[] } },
): Promise<StoredDocument<FileRecord>> {
  const found = await getDocumentOrNull<FileRecord>(client, COLLECTIONS.files, id);
  if (!found || !visible(found.data, ctx)) {
    throw apiError(404, 'file_not_found', 'file not found');
  }
  return found;
}

async function loadPublicFile(client: any, id: string): Promise<StoredDocument<FileRecord>> {
  const found = await getDocumentOrNull<FileRecord>(client, COLLECTIONS.files, id);
  if (!found || found.data.public !== true) {
    throw apiError(404, 'file_not_found', 'file not found');
  }
  return found;
}

async function usedBytes(client: any, tenant: string): Promise<{ usedBytes: number; count: number }> {
  let offset = 0;
  let usedBytes = 0;
  let count = 0;
  for (;;) {
    const page = await queryDocuments<FileRecord>(client, COLLECTIONS.files, {
      where: { tenant },
      orderBy: { field: 'id', direction: 'asc' },
      limit: 500,
      offset,
    });
    for (const item of page.items) {
      usedBytes += Number(item.data.size || 0);
      count += 1;
    }
    if (page.items.length < 500) break;
    offset += page.items.length;
    if (offset >= 20000) break;
  }
  return { usedBytes, count };
}

function productOf(req: { header(name: string): string | undefined }): string | undefined {
  return req.header('x-synapsedx-product')?.trim() || undefined;
}

function mapStorageError(error: unknown): never {
  if (error instanceof SynapseOneError) {
    if (error.status === 404) throw apiError(404, 'file_not_found', 'file content not found');
    if (error.status === 413) throw apiError(413, 'file_too_large', 'the file exceeds the Tier-1 object limit');
    if (error.status === 415) throw apiError(415, 'file_type_not_allowed', 'Tier-1 storage rejected this content type');
    if (error.status === 501) {
      throw apiError(501, 'presign_unsupported', 'presigned URLs are not available on this Tier-1 storage backend');
    }
  }
  throw error;
}

async function ensureOcsBucket(client: any, config: ServiceConfig): Promise<void> {
  try {
    await client.ocs.createBucket(config.filesBucket);
  } catch (error) {
    if (error instanceof SynapseOneError && (error.status === 400 || error.status === 409)) return;
    throw error;
  }
}

/** Lazily copy a legacy default-bucket object into SynapseOCS. */
async function migrateLegacyObject(client: any, config: ServiceConfig, found: StoredDocument<FileRecord>): Promise<StoredDocument<FileRecord>> {
  if (found.data.ocsBucket) return found;
  await ensureOcsBucket(client, config);
  const bytes = await client.storage.getObject(found.data.storageKey);
  await client.ocs.putObject(config.filesBucket, found.data.storageKey, bytes, {
    contentType: found.data.contentType,
    ...(found.data.checksumSha256 ? { checksumSha256: found.data.checksumSha256 } : {}),
  });
  const updated: FileRecord = { ...found.data, ocsBucket: config.filesBucket, updatedAt: new Date().toISOString() };
  try {
    await client.base.updateDocument(COLLECTIONS.files, found.data.id, {
      data: updated as unknown as Record<string, unknown>,
      ...(found.version ? { ifVersion: found.version } : {}),
    });
  } catch {
    // The bytes are already in OCS; a metadata race must not break the read.
  }
  found.data = updated;
  return found;
}

async function readFileBytes(client: any, config: ServiceConfig, found: StoredDocument<FileRecord>): Promise<Uint8Array> {
  if (found.data.ocsBucket) return client.ocs.getObject(found.data.ocsBucket, found.data.storageKey);
  const migrated = await migrateLegacyObject(client, config, found);
  return client.ocs.getObject(config.filesBucket, migrated.data.storageKey);
}

async function headFileObject(client: any, config: ServiceConfig, found: StoredDocument<FileRecord>): Promise<any> {
  if (found.data.ocsBucket) return client.ocs.headObject(found.data.ocsBucket, found.data.storageKey);
  const migrated = await migrateLegacyObject(client, config, found);
  return client.ocs.headObject(config.filesBucket, migrated.data.storageKey);
}

export function registerFileRoutes(app: Express, config: ServiceConfig): void {
  const raw = express.raw({ type: () => true, limit: config.filesMaxBytes });

  app.get('/v1/capabilities/files', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const pagination = parsePagination(req, config.maxPageSize);
    const prefix = String(req.query.prefix || '').trim().slice(0, 200);
    const where = prefix
      ? [{ field: 'tenant', op: 'eq', value: principal.tenantKey }, { field: 'filename', op: 'startsWith', value: prefix }]
      : { tenant: principal.tenantKey };
    const result = await queryDocuments<FileRecord>(client, COLLECTIONS.files, {
      where: where as any,
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: pagination.limit,
      offset: pagination.offset,
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({
      items: result.items.map((item) => view(item.data)),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  app.get('/v1/capabilities/files/quota', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const usage = await usedBytes(client, principal.tenantKey);
    res.json({
      tenant: principal.tenantKey,
      usedBytes: usage.usedBytes,
      quotaBytes: config.filesQuotaBytes,
      remainingBytes: Math.max(config.filesQuotaBytes - usage.usedBytes, 0),
      files: usage.count,
      maxFileBytes: config.filesMaxBytes,
      allowedTypes: config.filesAllowedTypes,
    });
  }));

  app.post('/v1/capabilities/files', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const filename = safeFilename(body.filename);
    const contentType = mimeType(body.contentType);
    assertAllowedType(config, contentType);
    const size = body.size === undefined ? 0 : Number(body.size);
    if (!Number.isInteger(size) || size < 0) throw apiError(400, 'invalid_request', 'size must be a non-negative integer');
    if (size > config.filesMaxBytes) {
      throw apiError(413, 'file_too_large', 'the file exceeds the Tier-2 upload limit', { maxBytes: config.filesMaxBytes });
    }
    const providedChecksum = body.checksumSha256 ? String(body.checksumSha256).toLowerCase() : undefined;
    if (providedChecksum && !/^[a-f0-9]{64}$/.test(providedChecksum)) {
      throw apiError(400, 'invalid_request', 'checksumSha256 must be 64 hex characters');
    }
    const requestedId = body.id === undefined ? undefined : String(body.id);
    if (requestedId && !/^[A-Za-z0-9._-]{1,80}$/.test(requestedId)) {
      throw apiError(400, 'invalid_request', 'id must match [A-Za-z0-9._-]{1,80}');
    }
    const isPublic = body.public === true;
    if (isPublic && !canPublish(principal)) {
      throw apiError(403, 'insufficient_scope', 'publishing a public file requires files:publish');
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
      await ensureCollections(client);
      const usage = await usedBytes(client, principal.tenantKey);
      if (usage.usedBytes + size > config.filesQuotaBytes) {
        throw apiError(413, 'quota_exceeded', 'this tenant has no remaining file quota', {
          usedBytes: usage.usedBytes,
          quotaBytes: config.filesQuotaBytes,
          requestedBytes: size,
        });
      }
      const id = requestedId || randomUUID();
      const now = new Date().toISOString();
      const record: FileRecord = {
        id,
        tenant: principal.tenantKey,
        ...(productOf(req) ? { product: productOf(req) } : {}),
        owner: principal.subject,
        filename,
        contentType,
        size,
        ...(providedChecksum ? { checksumSha256: providedChecksum } : {}),
        storageKey: storageKey(config, principal.tenantKey, id, filename),
        ocsBucket: config.filesBucket,
        ...(body.datasetId ? { datasetId: String(body.datasetId) } : {}),
        ...(body.recordId ? { recordId: String(body.recordId) } : {}),
        ...(isPublic ? { public: true } : {}),
        createdAt: now,
        updatedAt: now,
      };
      try {
        await client.base.createDocument(COLLECTIONS.files, { id, data: record as unknown as Record<string, unknown> });
      } catch (error) {
        if (error instanceof SynapseOneError && error.status === 409) {
          throw apiError(409, 'file_already_exists', 'a file with this id already exists');
        }
        throw error;
      }
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'file.create',
        datasetId: record.datasetId, correlationId: correlationIdOf(req), details: { id, filename, contentType, size },
      });
      const payload = {
        ...view(record),
        upload: {
          method: 'PUT',
          url: `/v1/capabilities/files/${encodeURIComponent(id)}/content`,
          contentType,
          maxBytes: config.filesMaxBytes,
          ...(providedChecksum ? { checksumSha256: providedChecksum } : {}),
        },
      };
      res.status(201).json(payload);
      await claim?.complete(201, payload);
    } catch (error) {
      await claim?.release();
      throw error;
    }
  }));

  app.get('/v1/capabilities/public/files/:id', handler(async (req, res) => {
    const client = serviceClient(config);
    const found = await loadPublicFile(client, String(req.params.id));
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(publicView(found.data));
  }));

  app.head('/v1/capabilities/public/files/:id/content', handler(async (req, res) => {
    const client = serviceClient(config);
    const found = await loadPublicFile(client, String(req.params.id));
    let object: any;
    try {
      object = await headFileObject(client, config, found);
    } catch (error) {
      mapStorageError(error);
    }
    res.setHeader('content-type', found.data.contentType);
    res.setHeader('content-length', String(object?.size || found.data.size));
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.data.filename)}`);
    res.setHeader('cache-control', 'public, max-age=300');
    if (found.data.checksumSha256) res.setHeader('x-checksum-sha256', found.data.checksumSha256);
    res.status(200).flushHeaders();
    res.end();
  }));

  app.get('/v1/capabilities/public/files/:id/content', handler(async (req, res) => {
    const client = serviceClient(config);
    const found = await loadPublicFile(client, String(req.params.id));
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(client, config, found);
    } catch (error) {
      mapStorageError(error);
    }
    const buffer = Buffer.from(bytes);
    res.setHeader('content-type', found.data.contentType);
    res.setHeader('content-length', String(buffer.length));
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.data.filename)}`);
    res.setHeader('cache-control', 'public, max-age=300');
    if (found.data.checksumSha256) res.setHeader('x-checksum-sha256', found.data.checksumSha256);
    res.status(200).send(buffer);
  }));

  app.get('/v1/capabilities/files/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    res.setHeader('cache-control', 'private, no-store');
    res.json(view(found.data));
  }));

  app.put('/v1/capabilities/files/:id/content', raw, handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    const record = found.data;
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw apiError(400, 'field_required', 'a non-empty binary body is required');
    }
    if (body.length > config.filesMaxBytes) {
      throw apiError(413, 'file_too_large', 'the file exceeds the Tier-2 upload limit', { maxBytes: config.filesMaxBytes });
    }
    const headerType = mimeType(String(req.header('content-type') || record.contentType).split(';')[0].trim());
    const contentType = record.contentType === 'application/octet-stream' ? headerType : record.contentType;
    if (record.contentType !== 'application/octet-stream' && headerType !== record.contentType) {
      throw apiError(415, 'file_type_not_allowed', 'the upload content type does not match the file metadata', {
        expected: record.contentType,
        received: headerType,
      });
    }
    assertAllowedType(config, contentType);
    const actualChecksum = checksumOf(body);
    const expectedChecksum = (req.header('x-checksum-sha256') || req.header('x-object-checksum-sha256') || record.checksumSha256 || '').toLowerCase();
    if (expectedChecksum && expectedChecksum !== actualChecksum) {
      throw apiError(400, 'invalid_request', 'the body checksum does not match checksumSha256', { expected: expectedChecksum, actual: actualChecksum });
    }
    const usage = await usedBytes(client, principal.tenantKey);
    if (usage.usedBytes - record.size + body.length > config.filesQuotaBytes) {
      throw apiError(413, 'quota_exceeded', 'this tenant has no remaining file quota', {
        usedBytes: usage.usedBytes,
        quotaBytes: config.filesQuotaBytes,
        requestedBytes: body.length,
      });
    }
    try {
      await ensureOcsBucket(client, config);
      await client.ocs.putObject(config.filesBucket, record.storageKey, body, { contentType, checksumSha256: actualChecksum });
    } catch (error) {
      mapStorageError(error);
    }
    const updated: FileRecord = {
      ...record,
      contentType,
      size: body.length,
      checksumSha256: actualChecksum,
      ocsBucket: config.filesBucket,
      updatedAt: new Date().toISOString(),
    };
    await client.base.updateDocument(COLLECTIONS.files, record.id, {
      data: updated as unknown as Record<string, unknown>,
      ...(found.version ? { ifVersion: found.version } : {}),
    });
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'file.upload',
      datasetId: updated.datasetId, correlationId: correlationIdOf(req), details: { id: record.id, size: updated.size },
    });
    res.json(view(updated));
  }));

  app.get('/v1/capabilities/files/:id/content', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(client, config, found);
    } catch (error) {
      mapStorageError(error);
    }
    const buffer = Buffer.from(bytes);
    res.setHeader('content-type', found.data.contentType);
    res.setHeader('content-length', String(buffer.length));
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.data.filename)}`);
    res.setHeader('cache-control', 'private, no-store');
    if (found.data.checksumSha256) res.setHeader('x-checksum-sha256', found.data.checksumSha256);
    res.status(200).send(buffer);
  }));

  app.post('/v1/capabilities/files/:id/complete', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    let object: any;
    try {
      object = await headFileObject(client, config, found);
    } catch (error) {
      mapStorageError(error);
    }
    if (!object || Number(object.size || 0) <= 0) {
      throw apiError(409, 'upload_incomplete', 'no object content has been uploaded for this file');
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.size !== undefined && Number(body.size) !== Number(object.size)) {
      throw apiError(409, 'upload_incomplete', 'the uploaded object size does not match the request', {
        expected: Number(body.size), actual: Number(object.size),
      });
    }
    const contentType = mimeType(object.contentType || found.data.contentType);
    assertAllowedType(config, contentType);
    const usage = await usedBytes(client, principal.tenantKey);
    if (usage.usedBytes - found.data.size + Number(object.size) > config.filesQuotaBytes) {
      throw apiError(413, 'quota_exceeded', 'this tenant has no remaining file quota', {
        usedBytes: usage.usedBytes,
        quotaBytes: config.filesQuotaBytes,
        requestedBytes: Number(object.size),
      });
    }
    const updated: FileRecord = {
      ...found.data,
      size: Number(object.size),
      contentType,
      ocsBucket: config.filesBucket,
      ...(object.checksumSha256 ? { checksumSha256: String(object.checksumSha256) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await client.base.updateDocument(COLLECTIONS.files, found.data.id, {
      data: updated as unknown as Record<string, unknown>,
      ...(found.version ? { ifVersion: found.version } : {}),
    });
    res.json(view(updated));
  }));

  app.post('/v1/capabilities/files/:id/presign', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    const body = (req.body || {}) as Record<string, unknown>;
    const method = String(body.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'PUT', 'DELETE'].includes(method)) {
      throw apiError(400, 'invalid_request', 'method must be GET|HEAD|PUT|DELETE');
    }
    const expiresIn = body.expiresIn === undefined ? config.filesPresignTtlSeconds : Number(body.expiresIn);
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
      throw apiError(400, 'invalid_request', 'expiresIn must be 1..604800 seconds');
    }
    let signed: any;
    try {
      if (method === 'GET' || method === 'HEAD') {
        const migrated = await migrateLegacyObject(client, config, found);
        signed = await client.ocs.presign(migrated.data.ocsBucket || config.filesBucket, migrated.data.storageKey, { method: method as any, expiresIn });
      } else {
        await ensureOcsBucket(client, config);
        signed = await client.ocs.presign(config.filesBucket, found.data.storageKey, { method: method as any, expiresIn });
      }
    } catch (error) {
      mapStorageError(error);
    }
    res.setHeader('cache-control', 'no-store');
    res.json({
      fileId: found.data.id,
      method: signed.method || method,
      url: signed.url,
      bucket: config.filesBucket,
      expiresIn: signed.expiresIn || expiresIn,
      completeUrl: method === 'PUT' ? `/v1/capabilities/files/${encodeURIComponent(found.data.id)}/complete` : undefined,
    });
  }));

  app.delete('/v1/capabilities/files/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const found = await loadFile(client, String(req.params.id), { principal });
    try {
      if (found.data.ocsBucket) {
        await client.ocs.deleteObject(found.data.ocsBucket, found.data.storageKey);
      } else {
        await client.storage.deleteObject(found.data.storageKey);
        await client.ocs.deleteObject(config.filesBucket, found.data.storageKey).catch(() => undefined);
      }
    } catch (error) {
      if (!(error instanceof SynapseOneError && error.status === 404)) mapStorageError(error);
    }
    await client.base.deleteDocument(COLLECTIONS.files, found.data.id);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'file.delete',
      datasetId: found.data.datasetId, correlationId: correlationIdOf(req), details: { id: found.data.id },
    });
    res.status(204).end();
  }));
}
