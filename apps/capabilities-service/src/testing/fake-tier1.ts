// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * In-memory Tier-1 fake used by the capabilities-service contract tests.
 *
 * It implements only the endpoints @synapseone/sdk calls for Base, LDS, Queue,
 * Stream, Faststore, IAM, Workflow, Inference, Storage and Notifications, with
 * the same response shapes. Nothing here is used in production.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const FAKE_EMBED_DIM = 64;
/** Tiny cross-language concept table so tests can check meaning-only matches. */
const FAKE_CONCEPTS: Record<string, string> = {
  flood: 'flood', floods: 'flood', 'lũ': 'flood', 'ngập': 'flood', 'lụt': 'flood',
  barrier: 'barrier', barriers: 'barrier', 'đê': 'barrier', 'chắn': 'barrier',
  river: 'river', 'sông': 'river',
};

/** Deterministic bag-of-concepts embedding (stand-in for a real sentence model). */
function fakeConceptEmbedding(text: string): number[] {
  const vector = new Array<number>(FAKE_EMBED_DIM).fill(0);
  for (const raw of String(text).normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []) {
    const concept = FAKE_CONCEPTS[raw];
    if (!concept) continue;
    vector[createHash('sha256').update(concept).digest().readUInt32BE(0) % FAKE_EMBED_DIM] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

type Json = Record<string, unknown>;

interface StoredDoc {
  id: string;
  data: Json;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface Datasource {
  id: string;
  slug: string;
  name: string;
  entityType: string;
  license: string;
  licenseUrl?: string;
  contexts: string[];
  defaultVisibility: 'public' | 'internal';
  description?: string;
}

interface Entity {
  id: string;
  recordId?: string;
  data?: Json;
}

interface Workflow {
  id: string;
  name: string;
  definition: Json;
  active: boolean;
}

export interface FakeTier1Options {
  tokens?: Record<string, Json>;
  apiKeys?: Record<string, { account_id: string; scopes: string[] }>;
  /** Enable the S3-style presign endpoint (default: 501 like the fs backend). */
  storagePresign?: boolean;
  maxObjectBytes?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getPath(source: Json | undefined, path: string): unknown {
  if (!source) return undefined;
  if (path === '$id') return undefined;
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return (value as Json)[key];
    return undefined;
  }, source);
}

function compare(a: unknown, b: unknown): number | null {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  const as = String(a);
  const bs = String(b);
  return as === bs ? 0 : as < bs ? -1 : 1;
}

function matches(where: unknown, doc: StoredDoc): boolean {
  if (where === undefined || where === null) return true;
  if (Array.isArray(where)) return where.every((entry) => matches(entry, doc));
  if (typeof where !== 'object') return true;
  const filter = where as Json;
  if (Array.isArray(filter.and)) return filter.and.every((entry) => matches(entry, doc));
  if (Array.isArray(filter.or)) return filter.or.some((entry) => matches(entry, doc));
  if (filter.not !== undefined) return !matches(filter.not, doc);
  if (typeof filter.field === 'string') {
    const value = filter.field === '$id' ? doc.id : getPath(doc.data, filter.field);
    const op = String(filter.op || 'eq');
    const expected = filter.value;
    switch (op) {
      case 'eq': return value === expected;
      case 'ne': return value !== expected;
      case 'gt': return compare(value, expected) === 1;
      case 'gte': return [0, 1].includes(compare(value, expected) ?? -1);
      case 'lt': return compare(value, expected) === -1;
      case 'lte': return [0, -1].includes(compare(value, expected) ?? 2);
      case 'in': return Array.isArray(expected) && expected.includes(value);
      case 'nin': return Array.isArray(expected) && !expected.includes(value);
      case 'contains': return typeof value === 'string' && value.includes(String(expected));
      case 'startsWith': return typeof value === 'string' && value.startsWith(String(expected));
      case 'endsWith': return typeof value === 'string' && value.endsWith(String(expected));
      case 'exists': return expected === true ? value !== undefined : value === undefined;
      default: return false;
    }
  }
  return Object.entries(filter).every(([field, condition]) => {
    const value = field === '$id' ? doc.id : getPath(doc.data, field);
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const entries = Object.entries(condition as Json);
      if (entries.length === 1) {
        return matches({ field, op: entries[0][0], value: entries[0][1] }, doc);
      }
    }
    return value === condition;
  });
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface FakeObject {
  tenant: string;
  key: string;
  body: Buffer;
  contentType: string;
  etag: string;
  checksumSha256: string;
  createdAt: string;
  updatedAt: string;
}

interface FakeNotification {
  id: string;
  tenant: string;
  channel: string;
  recipient: Record<string, string>;
  subject: string;
  body: string;
  status: string;
  attempts: Array<{ at: string; ok: boolean; error?: string }>;
  idempotencyKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  deadReason: string | null;
}

export class FakeTier1 {
  readonly collections = new Map<string, Map<string, StoredDoc>>();
  readonly datasources = new Map<string, Datasource>();
  readonly storage = new Map<string, FakeObject>();
  readonly ocsBuckets = new Set<string>(['default']);
  readonly notifications = new Map<string, FakeNotification>();
  readonly notificationPreferences = new Map<string, { tenant: string; recipient: string; channels: string[]; unsubscribed: boolean; updatedAt: string }>();
  readonly users = new Map<string, { id: string; email: string; password: string; orgSlug: string; verified: boolean; sessions: string[] }>();
  readonly issuedTokens = new Map<string, Json>();
  readonly issuedRefresh = new Map<string, string>();
  resetTokens = new Map<string, string>();
  readonly exchanges: Json[] = [];
  readonly chatRequests: Json[] = [];
  embeddingCalls = 0;
  readonly storagePresign: boolean;
  readonly maxObjectBytes: number;
  readonly attributes = new Map<string, Array<{ name: string; visibility: string }>>();
  readonly entities = new Map<string, Map<string, Entity>>();
  readonly queues = new Map<string, Json[]>();
  readonly topics = new Map<string, Array<{ id: string; payload: unknown }>>();
  readonly faststore = new Map<string, unknown>();
  readonly workflows = new Map<string, Workflow>();
  readonly executions: Json[] = [];
  readonly requests: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = [];
  readonly tokens = new Map<string, Json>();
  readonly apiKeys = new Map<string, { account_id: string; scopes: string[] }>();
  failBase = false;
  failLds = false;
  failQueue = false;
  failStream = false;
  failFaststore = false;
  private server?: Server;
  private seq = 0;

  constructor(options: FakeTier1Options = {}) {
    for (const [token, claims] of Object.entries(options.tokens || {})) this.tokens.set(token, claims);
    for (const [key, value] of Object.entries(options.apiKeys || {})) this.apiKeys.set(key, value);
    this.storagePresign = options.storagePresign === true;
    this.maxObjectBytes = options.maxObjectBytes || 25 * 1024 * 1024;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.json(res, 500, { error: 'fake_internal', message: (error as Error).message });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Simulate a queue outage without stopping the whole fake. */
  reset(): void {
    this.collections.clear();
    this.datasources.clear();
    this.attributes.clear();
    this.entities.clear();
    this.queues.clear();
    this.topics.clear();
    this.faststore.clear();
    this.workflows.clear();
    this.executions.length = 0;
    this.requests.length = 0;
    this.storage.clear();
    this.notifications.clear();
    this.notificationPreferences.clear();
    this.users.clear();
    this.issuedTokens.clear();
    this.issuedRefresh.clear();
    this.resetTokens.clear();
    this.exchanges.length = 0;
    this.failBase = false;
    this.failLds = false;
    this.failQueue = false;
    this.failStream = false;
    this.failFaststore = false;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  private collection(name: string): Map<string, StoredDoc> {
    let map = this.collections.get(name);
    if (!map) {
      map = new Map();
      this.collections.set(name, map);
    }
    return map;
  }

  private docView(doc: StoredDoc, as: string): Json {
    return as === 'object'
      ? { id: doc.id, object: doc.data, version: doc.version, createdAt: doc.createdAt, updatedAt: doc.updatedAt }
      : { id: doc.id, data: doc.data, version: doc.version, createdAt: doc.createdAt, updatedAt: doc.updatedAt };
  }

  private saveDoc(collection: string, id: string, data: Json, version: number, createdAt: string): StoredDoc {
    const doc: StoredDoc = { id, data, version, createdAt, updatedAt: nowIso() };
    this.collection(collection).set(id, doc);
    return doc;
  }

  private tenantOf(headers: Record<string, string>): string | null {
    const apiKey = headers['x-api-key'] || '';
    if (apiKey) {
      const record = this.apiKeys.get(apiKey);
      if (record) return `account:${record.account_id}`;
    }
    const authorization = headers.authorization || '';
    if (authorization.startsWith('Bearer ')) {
      const claims = this.tokens.get(authorization.slice(7)) || this.issuedTokens.get(authorization.slice(7));
      if (claims) {
        if (claims.account) return `account:${claims.account}`;
        if (claims.org) return `org:${claims.org}`;
        if (claims.sub) return `user:${claims.sub}`;
      }
    }
    const explicit = headers['x-synapseone-tenant'] || headers['x-synapsedx-tenant'];
    return explicit || null;
  }

  private claimsOf(headers: Record<string, string>): Json | undefined {
    const authorization = headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return undefined;
    return this.tokens.get(authorization.slice(7)) || this.issuedTokens.get(authorization.slice(7));
  }

  private userForClaims(claims: Json | undefined): { sub: string; email?: string } | null {
    if (!claims?.sub) return null;
    const user = [...this.users.values()].find((entry) => entry.id === claims.sub);
    return user ? { sub: user.id, email: user.email } : { sub: String(claims.sub), email: String(claims.email || '') };
  }

  private issueSession(user: { id: string; email: string; orgSlug: string }, org?: string): Json {
    const token = `access-${this.seq}-${randomUUID()}`;
    const refresh = `refresh-${this.seq}-${randomUUID()}`;
    this.issuedTokens.set(token, {
      sub: user.id, email: user.email, org: org || user.orgSlug, account: `acct-${user.orgSlug}`, scopes: ['write'],
    });
    this.issuedRefresh.set(refresh, user.id);
    return {
      accessToken: token,
      refreshToken: refresh,
      user: { id: user.id, email: user.email, email_verified: (user as any).verified === true },
    };
  }

  private handleOcs(method: string, path: string, url: URL, raw: Buffer, headers: Record<string, string>, res: ServerResponse): void {
    const tenant = this.tenantOf(headers);
    if (!tenant) return this.json(res, 401, { error: 'tenant_required' });
    if (path === '/v1/ocs/buckets' && method === 'GET') {
      const withStats = url.searchParams.get('withStats') === '1';
      const buckets = [...this.ocsBuckets].sort().map((name) => {
        const objects = [...this.storage.values()].filter((object) => object.key.startsWith(`${name}|${tenant}|`));
        return {
          name, createdAt: nowIso(),
          ...(withStats ? { objects: objects.length, bytes: objects.reduce((sum, object) => sum + object.body.length, 0) } : {}),
        };
      });
      return this.json(res, 200, { buckets, total: buckets.length });
    }
    if (path === '/v1/ocs/buckets' && method === 'POST') {
      let body: any = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return this.json(res, 400, { error: 'invalid_json' }); }
      const name = String(body.name || '');
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) return this.json(res, 400, { error: 'invalid_bucket_name' });
      if (this.ocsBuckets.has(name)) return this.json(res, 409, { error: 'bucket_exists' });
      this.ocsBuckets.add(name);
      return this.json(res, 201, { bucket: { name, createdAt: nowIso() } });
    }
    const bucketMatch = path.match(/^\/v1\/ocs\/buckets\/([^/]+)$/);
    if (bucketMatch && (method === 'GET' || method === 'HEAD')) {
      const name = decodeURIComponent(bucketMatch[1]);
      if (!this.ocsBuckets.has(name)) return this.json(res, 404, { error: 'bucket_not_found' });
      if (method === 'HEAD') { res.writeHead(200, { 'x-ocs-bucket': name }); res.end(); return; }
      return this.json(res, 200, { bucket: { name, createdAt: nowIso() } });
    }
    const presignMatch = path.match(/^\/v1\/ocs\/buckets\/([^/]+)\/presign$/);
    if (presignMatch && method === 'POST') {
      if (!this.storagePresign) return this.json(res, 501, { error: 'presign_unsupported' });
      let body: any = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return this.json(res, 400, { error: 'invalid_json' }); }
      const bucket = decodeURIComponent(presignMatch[1]);
      const key = String(body.key || '');
      const verb = String(body.method || 'GET').toUpperCase();
      return this.json(res, 200, { url: `https://s3.example/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}?sig=fake`, bucket, key, method: verb, expiresIn: Number(body.expiresIn || 900) });
    }
    const objectMatch = path.match(/^\/v1\/ocs\/buckets\/([^/]+)\/objects\/(.+)$/);
    if (objectMatch) {
      const bucket = decodeURIComponent(objectMatch[1]);
      const key = decodeURIComponent(objectMatch[2]);
      if (!this.ocsBuckets.has(bucket)) return this.json(res, 404, { error: 'bucket_not_found' });
      const id = `${bucket}|${tenant}|${key}`;
      if (method === 'PUT') {
        if (!raw.length) return this.json(res, 400, { error: 'empty_body' });
        if (raw.length > this.maxObjectBytes) return this.json(res, 413, { error: 'object_too_large' });
        const checksum = createHash('sha256').update(raw).digest('hex');
        const provided = String(headers['x-object-checksum-sha256'] || '').toLowerCase();
        if (provided && provided !== checksum) return this.json(res, 400, { error: 'checksum_mismatch', expected: checksum });
        const current = this.storage.get(id);
        const now = nowIso();
        const contentType = String(headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        const object: FakeObject = { tenant, key: id, body: raw, contentType, etag: checksum.slice(0, 32), checksumSha256: checksum, createdAt: current?.createdAt || now, updatedAt: now };
        this.storage.set(id, object);
        return this.json(res, current ? 200 : 201, { object: { bucket, key, size: raw.length, contentType, etag: object.etag, checksumSha256: checksum, createdAt: object.createdAt, updatedAt: object.updatedAt } });
      }
      const object = this.storage.get(id);
      if (!object) return this.json(res, 404, { error: 'not_found' });
      if (method === 'HEAD') {
        res.writeHead(200, {
          'content-type': object.contentType, 'content-length': String(object.body.length), etag: `"${object.etag}"`,
          'x-object-key': key, 'x-ocs-bucket': bucket, 'x-object-checksum-sha256': object.checksumSha256,
          'x-object-created-at': object.createdAt, 'x-object-updated-at': object.updatedAt,
        });
        res.end();
        return;
      }
      if (method === 'GET') {
        res.writeHead(200, { 'content-type': object.contentType, 'content-length': String(object.body.length), etag: `"${object.etag}"`, 'x-object-checksum-sha256': object.checksumSha256 });
        res.end(object.body);
        return;
      }
      if (method === 'DELETE') {
        this.storage.delete(id);
        return this.json(res, 200, { ok: true, bucket, key });
      }
    }
    return this.json(res, 404, { error: 'not_found', path });
  }

  private handleStorage(method: string, path: string, url: URL, raw: Buffer, headers: Record<string, string>, res: ServerResponse): void {
    const tenant = this.tenantOf(headers);
    if (!tenant) return this.json(res, 401, { error: 'tenant_required' });
    const objectMatch = path.match(/^\/v1\/storage\/objects\/(.+)$/);
    if (path === '/v1/storage/objects' && method === 'GET') {
      const prefix = String(url.searchParams.get('prefix') || '');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 1000);
      const items = [...this.storage.values()]
        .filter((object) => object.tenant === tenant && object.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(0, limit)
        .map((object) => ({
          key: object.key, size: object.body.length, contentType: object.contentType,
          etag: object.etag, checksumSha256: object.checksumSha256,
          createdAt: object.createdAt, updatedAt: object.updatedAt,
        }));
      return this.json(res, 200, { objects: items, nextCursor: null });
    }
    if (path === '/v1/storage/presign' && method === 'POST') {
      if (!this.storagePresign) return this.json(res, 501, { error: 'presign_unsupported' });
      let body: any = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return this.json(res, 400, { error: 'invalid_json' }); }
      const key = String(body.key || '');
      const verb = String(body.method || 'GET').toUpperCase();
      return this.json(res, 200, { url: `https://s3.example/${encodeURIComponent(tenant)}/${key}?sig=fake`, method: verb, expiresIn: Number(body.expiresIn || 900) });
    }
    if (path === '/v1/storage/uploads' && method === 'POST') {
      return this.json(res, 501, { error: 'multipart_unsupported' });
    }
    if (objectMatch) {
      const key = decodeURIComponent(objectMatch[1]);
      const id = `${tenant}|${key}`;
      if (method === 'PUT') {
        if (!raw.length) return this.json(res, 400, { error: 'empty_body' });
        if (raw.length > this.maxObjectBytes) return this.json(res, 413, { error: 'object_too_large' });
        const checksum = createHash('sha256').update(raw).digest('hex');
        const provided = String(headers['x-object-checksum-sha256'] || '').toLowerCase();
        if (provided && provided !== checksum) return this.json(res, 400, { error: 'checksum_mismatch', expected: checksum });
        const current = this.storage.get(id);
        const now = nowIso();
        const contentType = String(headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
        const object: FakeObject = {
          tenant, key, body: raw, contentType, etag: checksum.slice(0, 32), checksumSha256: checksum,
          createdAt: current?.createdAt || now, updatedAt: now,
        };
        this.storage.set(id, object);
        return this.json(res, current ? 200 : 201, {
          object: {
            key, size: raw.length, contentType, etag: object.etag, checksumSha256: checksum,
            createdAt: object.createdAt, updatedAt: object.updatedAt,
          },
        });
      }
      const object = this.storage.get(id);
      if (!object) return this.json(res, 404, { error: 'not_found' });
      if (method === 'HEAD') {
        res.writeHead(200, {
          'content-type': object.contentType,
          'content-length': String(object.body.length),
          etag: `"${object.etag}"`,
          'x-object-key': object.key,
          'x-object-checksum-sha256': object.checksumSha256,
          'x-object-created-at': object.createdAt,
          'x-object-updated-at': object.updatedAt,
        });
        res.end();
        return;
      }
      if (method === 'GET') {
        res.writeHead(200, {
          'content-type': object.contentType,
          'content-length': String(object.body.length),
          etag: `"${object.etag}"`,
          'x-object-key': object.key,
          'x-object-checksum-sha256': object.checksumSha256,
          'x-object-created-at': object.createdAt,
          'x-object-updated-at': object.updatedAt,
        });
        res.end(object.body);
        return;
      }
      if (method === 'DELETE') {
        this.storage.delete(id);
        return this.json(res, 200, { ok: true, key });
      }
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private handleNotifications(method: string, path: string, url: URL, body: any, headers: Record<string, string>, res: ServerResponse): void {
    const tenant = this.tenantOf(headers);
    if (!tenant) return this.json(res, 401, { error: 'tenant_required' });
    const preferenceMatch = path.match(/^\/v1\/notifications\/preferences\/(.+)$/);
    if (preferenceMatch) {
      const recipient = decodeURIComponent(preferenceMatch[1]);
      const key = `${tenant}|${recipient}`;
      if (method === 'GET') {
        return this.json(res, 200, this.notificationPreferences.get(key) || { tenant, recipient, channels: [], unsubscribed: false });
      }
      if (method === 'PUT') {
        const record = {
          tenant, recipient,
          channels: Array.isArray(body?.channels) ? body.channels.map(String) : [],
          unsubscribed: body?.unsubscribed === true,
          updatedAt: nowIso(),
        };
        this.notificationPreferences.set(key, record);
        return this.json(res, 200, record);
      }
    }
    if (path === '/v1/notifications/unsubscribe' && method === 'POST') {
      const recipient = String(body?.recipient || '');
      const key = `${tenant}|${recipient}`;
      const prev = this.notificationPreferences.get(key) || { tenant, recipient, channels: [], unsubscribed: false, updatedAt: nowIso() };
      const record = { ...prev, unsubscribed: true, updatedAt: nowIso() };
      this.notificationPreferences.set(key, record);
      return this.json(res, 200, record);
    }
    if (path === '/v1/notifications' && method === 'POST') {
      const channels: string[] = Array.isArray(body?.channels)
        ? body.channels.map((c: any) => String(c))
        : [String(body?.channel || 'email')];
      const out: FakeNotification[] = [];
      for (const channel of channels) {
        const idem = body?.idempotencyKey ? `${channel}:${String(body.idempotencyKey)}` : null;
        const existing = idem
          ? [...this.notifications.values()].find((n) => n.tenant === tenant && n.idempotencyKey === idem)
          : undefined;
        if (existing) { out.push(existing); continue; }
        const now = nowIso();
        const record: FakeNotification = {
          id: randomUUID(), tenant, channel,
          recipient: (body?.recipient || {}) as Record<string, string>,
          subject: String(body?.subject || ''),
          body: String(body?.body || ''),
          status: 'queued', attempts: [], idempotencyKey: idem,
          metadata: (body?.data || {}) as Record<string, unknown>,
          createdAt: now, updatedAt: now, nextAttemptAt: now, deadReason: null,
        };
        this.notifications.set(record.id, record);
        out.push(record);
      }
      return this.json(res, 202, { notifications: out });
    }
    if (path === '/v1/notifications' && method === 'GET') {
      const status = url.searchParams.get('status');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
      const items = [...this.notifications.values()]
        .filter((n) => n.tenant === tenant && (!status || n.status === status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      return this.json(res, 200, items);
    }
    const cancelMatch = path.match(/^\/v1\/notifications\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const record = this.notifications.get(cancelMatch[1]);
      if (!record || record.tenant !== tenant) return this.json(res, 409, { error: 'not_cancellable' });
      record.status = 'cancelled';
      record.updatedAt = nowIso();
      return this.json(res, 200, record);
    }
    const idMatch = path.match(/^\/v1\/notifications\/([^/]+)$/);
    if (idMatch && method === 'GET') {
      const record = this.notifications.get(idMatch[1]);
      if (!record || record.tenant !== tenant) return this.json(res, 404, { error: 'not_found' });
      return this.json(res, 200, record);
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://fake');
    const path = decodeURIComponent(url.pathname);
    const method = (req.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    this.seq += 1;

    // Storage accepts raw bytes; read the body before any JSON parsing.
    if (path.startsWith('/v1/ocs/')) {
      const raw = await readRaw(req);
      this.requests.push({ method, path, headers, body: raw.length ? `<${raw.length} bytes>` : undefined });
      return this.handleOcs(method, path, url, raw, headers, res);
    }
    if (path.startsWith('/v1/storage/')) {
      const raw = await readRaw(req);
      this.requests.push({ method, path, headers, body: raw.length ? `<${raw.length} bytes>` : undefined });
      return this.handleStorage(method, path, url, raw, headers, res);
    }
    if (path.startsWith('/v1/notifications')) {
      const parsed = await parseBody(req);
      this.requests.push({ method, path, headers, body: parsed });
      return this.handleNotifications(method, path, url, parsed, headers, res);
    }

    const body = await parseBody(req);
    this.requests.push({ method, path, headers, body });

    // ---- IAM ----
    if (path === '/v1/auth/verify' && method === 'GET') {
      const authorization = headers.authorization || '';
      const apiKey = headers['x-api-key'] || '';
      if (authorization.startsWith('Bearer ')) {
        const claims = this.tokens.get(authorization.slice(7)) || this.issuedTokens.get(authorization.slice(7));
        if (!claims) return this.json(res, 401, { valid: false });
        return this.json(res, 200, { valid: true, type: 'jwt', claims });
      }
      if (apiKey) {
        const record = this.apiKeys.get(apiKey);
        if (!record) return this.json(res, 401, { valid: false });
        return this.json(res, 200, { valid: true, type: 'apikey', ...record });
      }
      return this.json(res, 400, { error: 'credential_required' });
    }
    if (path === '/v1/auth/register' && method === 'POST') {
      const email = String(body?.email || '').toLowerCase();
      if (!email || !body?.password) return this.json(res, 400, { error: 'invalid_body' });
      if ([...this.users.values()].some((user) => user.email === email)) {
        return this.json(res, 409, { error: 'account_exists' });
      }
      const user = {
        id: `user-${this.users.size + 1}`, email, password: String(body.password),
        orgSlug: String(body.orgSlug || 'acme'), verified: false, sessions: [] as string[],
      };
      this.users.set(user.id, user);
      const session = this.issueSession(user);
      return this.json(res, 201, { ...session, emailVerificationToken: 'verify-token-1' });
    }
    if (path === '/v1/auth/login' && method === 'POST') {
      const email = String(body?.email || '').toLowerCase();
      if (body?.password !== undefined) {
        const user = [...this.users.values()].find((entry) => entry.email === email);
        if (!user || user.password !== String(body.password)) {
          return this.json(res, 401, { error: 'invalid_credentials' });
        }
        return this.json(res, 200, this.issueSession(user));
      }
      return this.json(res, 200, { accessToken: `access-${this.seq}`, refreshToken: `refresh-${this.seq}`, user: { id: 'user-1', email: body?.email } });
    }
    if (path === '/v1/auth/refresh' && method === 'POST') {
      if (!body?.refreshToken) return this.json(res, 401, { error: 'invalid_refresh' });
      return this.json(res, 200, { accessToken: `access-${this.seq}`, refreshToken: `refresh-${this.seq}` });
    }
    if (path === '/v1/auth/password/change' && method === 'POST') {
      const claims = this.claimsOf(headers);
      const user = [...this.users.values()].find((entry) => entry.id === claims?.sub);
      if (!user) return this.json(res, 401, { error: 'invalid_token' });
      if (user.password !== String(body?.currentPassword)) return this.json(res, 401, { error: 'invalid_credentials' });
      user.password = String(body?.newPassword);
      return this.json(res, 200, { ok: true, revokedSessions: 0 });
    }
    if (path === '/v1/auth/password/forgot' && method === 'POST') {
      const user = [...this.users.values()].find((entry) => entry.email === String(body?.email || '').toLowerCase());
      const token = `reset-token-${this.seq}`;
      if (user) this.resetTokens.set(token, user.id);
      return this.json(res, 202, { ok: true, resetToken: token });
    }
    if (path === '/v1/auth/password/reset' && method === 'POST') {
      const userId = this.resetTokens.get(String(body?.token || ''));
      const user = userId ? this.users.get(userId) : undefined;
      if (!user) return this.json(res, 400, { error: 'invalid_reset_token' });
      user.password = String(body?.newPassword || '');
      this.resetTokens.delete(String(body.token));
      return this.json(res, 200, { ok: true, revokedSessions: 0 });
    }
    if (path === '/v1/auth/email/verify' && method === 'POST') {
      if (String(body?.token || '') !== 'verify-token-1') return this.json(res, 400, { error: 'invalid_verify_token' });
      for (const user of this.users.values()) user.verified = true;
      return this.json(res, 200, { ok: true, emailVerified: true });
    }
    if (path === '/v1/auth/email/verify/request' && method === 'POST') {
      if (!this.claimsOf(headers)) return this.json(res, 401, { error: 'unauthorized' });
      return this.json(res, 200, { ok: true, emailVerificationToken: 'verify-token-2' });
    }
    if (path === '/v1/auth/sessions' && method === 'GET') {
      const claims = this.claimsOf(headers);
      if (!claims) return this.json(res, 401, { error: 'unauthorized' });
      return this.json(res, 200, [
        { id: 'session-1', created_at: nowIso(), expires_at: null, revoked_at: null },
        { id: 'session-2', created_at: nowIso(), expires_at: null, revoked_at: null },
      ]);
    }
    const sessionMatch = path.match(/^\/v1\/auth\/sessions\/([^/]+)$/);
    if (sessionMatch && method === 'DELETE') {
      if (!this.claimsOf(headers)) return this.json(res, 401, { error: 'unauthorized' });
      return this.json(res, 200, { ok: true, id: sessionMatch[1] });
    }
    if (path === '/v1/auth/exchange' && method === 'POST') {
      const apiKey = this.apiKeys.get(headers['x-api-key'] || '');
      if (!apiKey) return this.json(res, 401, { error: 'service_credential_required' });
      if (!body?.userId) return this.json(res, 400, { error: 'invalid_body' });
      const audience = body.audience || undefined;
      this.exchanges.push({ ...body, audience });
      return this.json(res, 200, {
        accessToken: `delegated-${this.seq}`, expiresIn: body.ttlSeconds || 900,
        tokenType: 'Bearer', delegated: true, userId: body.userId,
        orgId: body.orgId || 'org-a', accountId: body.accountId || 'acct-a',
        scopes: Array.isArray(body.scopes) ? body.scopes : apiKey.scopes,
        ...(audience ? { audience } : {}),
      });
    }
    if (path === '/v1/auth/logout' && method === 'POST') return this.json(res, 200, { ok: true });
    if (path === '/v1/auth/logout-all' && method === 'POST') return this.json(res, 200, { ok: true, revoked: 1 });
    if (path === '/v1/auth/me' && method === 'GET') return this.json(res, 200, { user: { id: 'user-1' }, kind: 'user' });
    if (path === '/v1/auth/oidc/config' && method === 'GET') return this.json(res, 200, { enabled: true, issuer: 'https://idp.example' });
    if (path === '/v1/auth/oidc/start' && method === 'GET') return this.json(res, 200, { authorizeUrl: 'https://idp.example/authorize', state: 'signed-state' });
    if (path === '/v1/auth/oidc/callback' && method === 'POST') return this.json(res, 200, { accessToken: 'oidc-access', refreshToken: 'oidc-refresh', user: { id: 'oidc-user' } });
    if (path === '/v1/audit' && method === 'GET') return this.json(res, 200, { items: [{ id: 'audit-1', action: 'login' }], total: 1 });
    if (path === '/v1/usage/summary' && method === 'GET') return this.json(res, 200, { totals: { requests: 3 }, byFeature: {} });
    if (path === '/v1/usage/events' && method === 'GET') return this.json(res, 200, { items: [{ id: 'usage-1' }], total: 1 });
    if (/^\/v1\/orgs\/[^/]+\/accounts$/.test(path) && method === 'GET') {
      return this.json(res, 200, [{ id: 'acct-a', slug: 'prod', displayName: 'Prod' }]);
    }
    if (/^\/v1\/orgs\/[^/]+\/users$/.test(path) && method === 'GET') {
      return this.json(res, 200, [
        { id: 'user-1', email: 'user@example.com', displayName: 'User One' },
        { id: 'user-2', email: 'operator@example.com', displayName: 'Operator Two' },
      ]);
    }
    if (/^\/v1\/accounts\/[^/]+\/roles$/.test(path) && method === 'POST') {
      return this.json(res, 201, { id: `role-${body?.slug || 'new'}`, slug: body?.slug || 'new', description: body?.description || '' });
    }
    if (/^\/v1\/accounts\/[^/]+\/roles$/.test(path) && method === 'GET') {
      return this.json(res, 200, [
        { id: 'role-admin', slug: 'admin', description: 'Administrator' },
        { id: 'role-operator', slug: 'operator', description: 'Operator' },
      ]);
    }
    if (/^\/v1\/accounts\/[^/]+\/policies$/.test(path) && method === 'GET') {
      return this.json(res, 200, [{ id: 'policy-1', name: 'read-only' }]);
    }
    if (/^\/v1\/users\/[^/]+\/assign$/.test(path) && method === 'POST') {
      return this.json(res, 200, { ok: true, roleId: body?.roleId });
    }
    if (/^\/v1\/users\/[^/]+\/roles\/[^/]+$/.test(path) && method === 'DELETE') {
      return this.json(res, 200, { ok: true });
    }
    if (/^\/v1\/users\/[^/]+\/roles$/.test(path) && method === 'GET') {
      return this.json(res, 200, [{ id: 'role-operator', slug: 'operator' }]);
    }

    // ---- Base ----
    if (path.startsWith('/v1/base/')) return this.handleBase(method, path, url, body, res);

    // ---- LDS ----
    if (path.startsWith('/v1/lds/')) return this.handleLds(method, path, url, body, res);

    // ---- Queue ----
    if (path.startsWith('/v1/queue/')) return this.handleQueue(method, path, body, res);

    // ---- Stream ----
    if (path.startsWith('/v1/stream/')) return this.handleStream(method, path, url, body, res);

    // ---- Faststore ----
    if (path.startsWith('/v1/faststore/')) return this.handleFaststore(method, path, body, res);

    // ---- Workflow ----
    if (path.startsWith('/v1/workflows') || path.startsWith('/v1/executions')) return this.handleWorkflow(method, path, url, body, res);

    // ---- Inference ----
    if (path === '/v1/inference/health' && method === 'GET') {
      if (process.env.FAKE_TIER1_INFERENCE_DOWN === 'true') return this.json(res, 503, { error: 'unavailable' });
      // Default mirrors production today: the embedding model is not loaded (mock).
      const real = process.env.FAKE_TIER1_EMBEDDING_REAL === 'true';
      const components = real
        ? { embedding: { model: 'fake-minilm', dimension: FAKE_EMBED_DIM, loaded: true, device: 'cpu', mock_mode: false } }
        : process.env.FAKE_TIER1_EMBEDDING_MOCK === 'true'
          ? { embedding: { model: 'fake-minilm', dimension: 384, loaded: false, device: 'cpu', mock_mode: true } }
          : {};
      return this.json(res, 200, { status: 'ok', service: 'inference', version: '1.0.0', models: {}, components, time: nowIso() });
    }
    if (path === '/v1/inference/chat/completions' && method === 'POST') {
      this.chatRequests.push(body);
      const content = process.env.FAKE_TIER1_CHAT_REPLY ?? 'ok';
      return this.json(res, 200, { id: 'chat-1', object: 'chat.completion', created: 1, model: body?.model || 'fake', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    }
    if (path === '/v1/inference/embeddings' && method === 'POST') {
      const inputs: string[] = Array.isArray(body?.input) ? body.input.map(String) : [String(body?.input ?? '')];
      this.embeddingCalls += 1;
      return this.json(res, 200, {
        object: 'list',
        data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: fakeConceptEmbedding(text) })),
        model: 'fake-minilm', usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
    }
    if (path === '/v1/inference/decision' && method === 'POST') return this.json(res, 200, { model: 'fake', results: {}, duration_ms: 1 });
    if (path === '/v1/inference/decision/route' && method === 'POST') return this.json(res, 200, { best_choice: Object.keys(body?.choices || {})[0] || 'a', confidence: 0.9, probabilities: {}, model: 'fake', duration_ms: 1 });

    if (path === '/health' && method === 'GET') return this.json(res, 200, { status: 'ok' });
    if (path === '/ready' && method === 'GET') return this.json(res, 200, { status: 'ready' });

    this.json(res, 404, { error: 'not_found', path });
  }

  private handleBase(method: string, path: string, url: URL, body: any, res: ServerResponse): void {
    if (this.failBase) return this.json(res, 503, { error: 'base_unavailable' });
    const collectionMatch = path.match(/^\/v1\/base\/collections\/([^/]+)$/);
    if (collectionMatch && method === 'GET') {
      const name = collectionMatch[1];
      if (!this.collections.has(name)) return this.json(res, 404, { error: 'not_found' });
      return this.json(res, 200, { id: name, name });
    }
    if (path === '/v1/base/collections' && method === 'POST') {
      const name = String(body?.name || '');
      if (this.collections.has(name)) return this.json(res, 409, { error: 'conflict' });
      this.collection(name);
      return this.json(res, 201, { id: name, name });
    }
    const documentsMatch = path.match(/^\/v1\/base\/collections\/([^/]+)\/documents$/);
    if (documentsMatch) {
      const name = documentsMatch[1];
      if (method === 'POST') {
        const map = this.collection(name);
        const id = String(body?.id || randomUUID());
        if (map.has(id)) return this.json(res, 409, { error: 'conflict' });
        const data = (body?.data ?? body?.object ?? {}) as Json;
        const doc = this.saveDoc(name, id, data, 1, nowIso());
        return this.json(res, 201, this.docView(doc, body?.object ? 'object' : 'data'));
      }
      if (method === 'GET') {
        const map = this.collection(name);
        const limit = Number(url.searchParams.get('limit') || 100);
        const offset = Number(url.searchParams.get('offset') || 0);
        const docs = [...map.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(offset, offset + limit);
        return this.json(res, 200, docs.map((doc) => this.docView(doc, 'data')));
      }
    }
    const queryMatch = path.match(/^\/v1\/base\/collections\/([^/]+)\/query$/);
    if (queryMatch && method === 'POST') {
      const name = queryMatch[1];
      const docs = [...this.collection(name).values()].filter((doc) => matches(body?.where, doc));
      const orderBy = body?.orderBy
        ? (Array.isArray(body.orderBy) ? body.orderBy : [body.orderBy]).map((entry: any) => (
          typeof entry === 'string' ? { field: entry, direction: 'asc' } : { field: entry.field, direction: entry.direction || 'asc' }
        ))
        : [{ field: '$id', direction: 'asc' }];
      docs.sort((a, b) => {
        for (const order of orderBy) {
          const av = order.field === '$id' ? a.id : getPath(a.data, order.field);
          const bv = order.field === '$id' ? b.id : getPath(b.data, order.field);
          const result = compare(av, bv) ?? 0;
          if (result !== 0) return order.direction === 'desc' ? -result : result;
        }
        return a.id.localeCompare(b.id);
      });
      const limit = Math.min(Math.max(Number(body?.limit ?? 100), 1), 1000);
      const offset = body?.cursor
        ? Number(Buffer.from(String(body.cursor), 'base64url').toString() || 0)
        : Math.max(Number(body?.offset ?? 0), 0);
      const page = docs.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return this.json(res, 200, {
        items: page.map((doc) => this.docView(doc, body?.as === 'object' ? 'object' : 'data')),
        total: docs.length,
        limit,
        offset,
        nextCursor: nextOffset < docs.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
      });
    }
    const documentMatch = path.match(/^\/v1\/base\/collections\/([^/]+)\/documents\/([^/]+)$/);
    if (documentMatch) {
      const [, name, id] = documentMatch;
      const map = this.collection(name);
      const current = map.get(id);
      if (method === 'GET') {
        if (!current) return this.json(res, 404, { error: 'not_found' });
        return this.json(res, 200, this.docView(current, url.searchParams.get('as') || 'data'));
      }
      if (method === 'PATCH' || method === 'PUT') {
        if (!current) return this.json(res, 404, { error: 'not_found' });
        if (body?.ifVersion !== undefined && Number(body.ifVersion) !== current.version) {
          return this.json(res, 409, { error: 'version_conflict', currentVersion: current.version });
        }
        const data = (body?.data ?? body?.object ?? (body?.merge ? { ...current.data, ...(body.merge as Json) } : current.data)) as Json;
        const doc = this.saveDoc(name, id, data, current.version + 1, current.createdAt);
        return this.json(res, 200, this.docView(doc, body?.object ? 'object' : 'data'));
      }
      if (method === 'DELETE') {
        if (!current) return this.json(res, 404, { error: 'not_found' });
        const ifVersion = url.searchParams.get('ifVersion');
        if (ifVersion !== null && Number(ifVersion) !== current.version) return this.json(res, 409, { error: 'version_conflict' });
        map.delete(id);
        return this.json(res, 200, { ok: true, id });
      }
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private handleLds(method: string, path: string, url: URL, body: any, res: ServerResponse): void {
    if (this.failLds) return this.json(res, 503, { error: 'lds_unavailable' });
    if (path === '/v1/lds/licenses' && method === 'GET') {
      return this.json(res, 200, [
        { id: 'CC0-1.0', name: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', openData: true },
        { id: 'PDDL-1.0', name: 'PDDL', url: 'https://opendatacommons.org/licenses/pddl/1.0/', openData: true },
        { id: 'CC-BY-4.0', name: 'CC-BY', url: 'https://creativecommons.org/licenses/by/4.0/', openData: true },
        { id: 'LicenseRef-Proprietary', name: 'Proprietary', url: 'https://example.test/proprietary', openData: false },
      ]);
    }
    if (path === '/v1/lds/datasources' && method === 'POST') {
      const slug = String(body?.slug || body?.name || '');
      if ([...this.datasources.values()].some((item) => item.slug === slug)) return this.json(res, 409, { error: 'slug_conflict' });
      const id = `ds-${this.datasources.size + 1}-${this.seq}`;
      const datasource: Datasource = {
        id,
        slug,
        name: String(body?.name || ''),
        entityType: String(body?.entityType || 'Thing'),
        license: String(body?.license || 'CC0-1.0'),
        ...(body?.licenseUrl ? { licenseUrl: String(body.licenseUrl) } : {}),
        contexts: Array.isArray(body?.contexts) ? body.contexts.map(String) : [],
        defaultVisibility: body?.defaultVisibility === 'public' ? 'public' : 'internal',
        ...(body?.description ? { description: String(body.description) } : {}),
      };
      this.datasources.set(id, datasource);
      this.entities.set(id, new Map());
      return this.json(res, 201, datasource);
    }
    const attributesMatch = path.match(/^\/v1\/lds\/datasources\/([^/]+)\/attributes$/);
    if (attributesMatch) {
      const id = attributesMatch[1];
      if (!this.datasources.has(id)) return this.json(res, 404, { error: 'not_found' });
      if (method === 'PUT') {
        const attributes = Array.isArray(body?.attributes) ? body.attributes : [];
        this.attributes.set(id, attributes.map((entry: any) => ({ name: String(entry.name), visibility: String(entry.visibility || 'internal') })));
        return this.json(res, 200, this.attributes.get(id));
      }
      return this.json(res, 200, this.attributes.get(id) || []);
    }
    const ingestMatch = path.match(/^\/v1\/lds\/datasources\/([^/]+)\/records$/);
    if (ingestMatch && method === 'POST') {
      const id = ingestMatch[1];
      if (!this.datasources.has(id)) return this.json(res, 404, { error: 'not_found' });
      const list = Array.isArray(body?.records) ? body.records : Array.isArray(body) ? body : body?.record ? [body.record] : [];
      const store = this.entities.get(id)!;
      for (const record of list) {
        const entityId = String(record.id || `urn:fake:${record.recordId}`);
        store.set(entityId, { id: entityId, recordId: record.recordId ? String(record.recordId) : undefined, data: record.data as Json });
      }
      return this.json(res, 200, { ingested: list.length, created: list.length, updated: 0, quarantined: [], entities: list.map((record: any) => ({ id: String(record.id), entityId: String(record.id) })) });
    }
    const entitiesMatch = path.match(/^\/v1\/lds\/datasources\/([^/]+)\/entities\/(.+)$/);
    if (entitiesMatch && method === 'GET') {
      const [, id, entityId] = entitiesMatch;
      if (!this.datasources.has(id)) return this.json(res, 404, { error: 'not_found' });
      const publicData = (this.attributes.get(id) || []).some((entry) => entry.name === 'data' && entry.visibility === 'public');
      const entity = this.entities.get(id)?.get(entityId);
      if (!entity || !publicData) return this.json(res, 404, { error: 'not_found' });
      return this.json(res, 200, { id: entity.id, recordId: entity.recordId, data: entity.data });
    }
    const entitiesListMatch = path.match(/^\/v1\/lds\/datasources\/([^/]+)\/entities$/);
    if (entitiesListMatch && method === 'GET') {
      const id = entitiesListMatch[1];
      if (!this.datasources.has(id)) return this.json(res, 404, { error: 'not_found' });
      const publicData = (this.attributes.get(id) || []).some((entry) => entry.name === 'data' && entry.visibility === 'public');
      const all = publicData ? [...(this.entities.get(id)?.values() || [])] : [];
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
      const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
      const entities = all.slice(offset, offset + limit);
      return this.json(res, 200, entities.map((entity) => ({ id: entity.id, recordId: entity.recordId, data: entity.data })));
    }
    const statsMatch = path.match(/^\/v1\/lds\/datasources\/([^/]+)\/stats$/);
    if (statsMatch && method === 'GET') {
      const id = statsMatch[1];
      if (!this.datasources.has(id)) return this.json(res, 404, { error: 'not_found' });
      return this.json(res, 200, { records: this.entities.get(id)?.size || 0, attributes: { public: 2, restricted: 0, internal: 0 }, lastIngestAt: nowIso() });
    }
    const datasourceMatch = path.match(/^\/v1\/lds\/datasources\/([^/]+)$/);
    if (datasourceMatch) {
      const id = datasourceMatch[1];
      const datasource = this.datasources.get(id);
      if (!datasource) return this.json(res, 404, { error: 'not_found' });
      if (method === 'GET') return this.json(res, 200, datasource);
      if (method === 'PATCH') {
        Object.assign(datasource, {
          ...(body?.name !== undefined ? { name: String(body.name) } : {}),
          ...(body?.entityType !== undefined ? { entityType: String(body.entityType) } : {}),
          ...(body?.license !== undefined ? { license: String(body.license) } : {}),
          ...(body?.licenseUrl !== undefined ? { licenseUrl: String(body.licenseUrl) } : {}),
          ...(body?.description !== undefined ? { description: String(body.description) } : {}),
          ...(body?.defaultVisibility !== undefined ? { defaultVisibility: body.defaultVisibility === 'public' ? 'public' : 'internal' } : {}),
        });
        return this.json(res, 200, datasource);
      }
      if (method === 'DELETE') {
        this.datasources.delete(id);
        this.entities.delete(id);
        this.attributes.delete(id);
        return this.json(res, 200, { ok: true });
      }
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private handleQueue(method: string, path: string, body: any, res: ServerResponse): void {
    if (this.failQueue) return this.json(res, 503, { error: 'queue_unavailable' });
    const openMatch = path.match(/^\/v1\/queue\/queues\/([^/]+)\/messages$/);
    if (openMatch && method === 'POST') {
      if (!this.queues.has(openMatch[1])) return this.json(res, 404, { error: 'not_found' });
      this.queues.get(openMatch[1])!.push(body?.payload as Json);
      return this.json(res, 201, { ok: true, id: body?.id || randomUUID() });
    }
    const queueMatch = path.match(/^\/v1\/queue\/queues\/([^/]+)$/);
    if (queueMatch) {
      const name = queueMatch[1];
      if (method === 'PUT') {
        if (this.queues.has(name)) return this.json(res, 409, { error: 'conflict' });
        this.queues.set(name, []);
        return this.json(res, 201, { name });
      }
      if (method === 'GET') {
        if (!this.queues.has(name)) return this.json(res, 404, { error: 'not_found' });
        return this.json(res, 200, { name, messages: this.queues.get(name)!.length });
      }
      if (method === 'DELETE') {
        this.queues.delete(name);
        return this.json(res, 200, { ok: true });
      }
    }
    if (path === '/v1/queue/queues' && method === 'GET') {
      return this.json(res, 200, [...this.queues.keys()].map((name) => ({ name })));
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private handleStream(method: string, path: string, url: URL, body: any, res: ServerResponse): void {
    if (this.failStream) return this.json(res, 503, { error: 'stream_unavailable' });
    if (path === '/v1/stream/topics' && method === 'GET') {
      return this.json(res, 200, { topics: [...this.topics.keys()].map((name) => ({ name, maxLen: 1000, createdAt: Date.now(), updatedAt: Date.now() })) });
    }
    const publishMatch = path.match(/^\/v1\/stream\/topics\/([^/]+)\/events$/);
    if (publishMatch && method === 'POST') {
      if (!this.topics.has(publishMatch[1])) return this.json(res, 404, { error: 'not_found' });
      const event = { id: body?.id || `${Date.now()}-${this.seq}`, payload: body?.payload };
      this.topics.get(publishMatch[1])!.push(event);
      return this.json(res, 201, { event });
    }
    const readMatch = path.match(/^\/v1\/stream\/topics\/([^/]+)\/read$/);
    if (readMatch && method === 'POST') {
      if (!this.topics.has(readMatch[1])) return this.json(res, 404, { error: 'not_found' });
      const all = this.topics.get(readMatch[1])!;
      const fromId = body?.fromId as string | undefined;
      const index = fromId ? all.findIndex((event) => event.id === fromId) : -1;
      const events = (index >= 0 ? all.slice(index + 1) : all).slice(0, Number(body?.count || 100));
      return this.json(res, 200, { events, count: events.length });
    }
    const rangeMatch = path.match(/^\/v1\/stream\/topics\/([^/]+)\/range$/);
    if (rangeMatch && method === 'GET') {
      if (!this.topics.has(rangeMatch[1])) return this.json(res, 404, { error: 'not_found' });
      const all = this.topics.get(rangeMatch[1])!;
      const count = Number(url.searchParams.get('count') || 100);
      return this.json(res, 200, { events: all.slice(-count), count: Math.min(count, all.length) });
    }
    const topicMatch = path.match(/^\/v1\/stream\/topics\/([^/]+)$/);
    if (topicMatch) {
      if (method === 'PUT') {
        if (this.topics.has(topicMatch[1])) return this.json(res, 409, { error: 'conflict' });
        this.topics.set(topicMatch[1], []);
        return this.json(res, 201, { topic: { name: topicMatch[1] } });
      }
      if (method === 'DELETE') {
        this.topics.delete(topicMatch[1]);
        return this.json(res, 200, { deleted: true });
      }
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private handleFaststore(method: string, path: string, body: any, res: ServerResponse): void {
    if (this.failFaststore) return this.json(res, 503, { error: 'faststore_unavailable' });
    if (path === '/v1/faststore/stats' && method === 'GET') return this.json(res, 200, { keys: this.faststore.size });
    const keyMatch = path.match(/^\/v1\/faststore\/keys\/(.+)$/);
    if (keyMatch) {
      const key = keyMatch[1];
      if (method === 'GET') {
        if (!this.faststore.has(key)) return this.json(res, 404, { error: 'not_found' });
        return this.json(res, 200, { key, type: 'string', value: this.faststore.get(key), ttlSeconds: null });
      }
      if (method === 'PUT') {
        if (body?.ifNotExists && this.faststore.has(key)) return this.json(res, 409, { error: 'already_exists' });
        this.faststore.set(key, body?.value);
        return this.json(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        this.faststore.delete(key);
        return this.json(res, 200, { ok: true });
      }
    }
    this.json(res, 404, { error: 'not_found', path });
  }

  private handleWorkflow(method: string, path: string, url: URL, body: any, res: ServerResponse): void {
    if (path === '/v1/workflows' && method === 'GET') {
      return this.json(res, 200, { data: [...this.workflows.values()] });
    }
    if (path === '/v1/workflows' && method === 'POST') {
      const id = `wf-${this.workflows.size + 1}`;
      const workflow: Workflow = { id, name: String(body?.name || id), definition: (body?.definition || {}) as Json, active: false };
      this.workflows.set(id, workflow);
      return this.json(res, 201, workflow);
    }
    const activateMatch = path.match(/^\/v1\/workflows\/([^/]+)\/(activate|deactivate)$/);
    if (activateMatch && method === 'POST') {
      const workflow = this.workflows.get(activateMatch[1]);
      if (!workflow) return this.json(res, 404, { error: 'not_found' });
      workflow.active = activateMatch[2] === 'activate';
      return this.json(res, 200, workflow);
    }
    const executeMatch = path.match(/^\/v1\/workflows\/([^/]+)\/execute$/);
    if (executeMatch && method === 'POST') {
      const workflow = this.workflows.get(executeMatch[1]);
      if (!workflow) return this.json(res, 404, { error: 'not_found' });
      const execution = {
        id: `exec-${this.executions.length + 1}`,
        workflowId: workflow.id,
        status: 'success',
        triggeredBy: 'manual',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        output: { ok: true },
      };
      this.executions.push(execution);
      return this.json(res, 200, { ok: true, executionId: execution.id, status: 'success', output: execution.output });
    }
    const workflowMatch = path.match(/^\/v1\/workflows\/([^/]+)$/);
    if (workflowMatch) {
      const workflow = this.workflows.get(workflowMatch[1]);
      if (!workflow) return this.json(res, 404, { error: 'not_found' });
      if (method === 'GET') return this.json(res, 200, workflow);
      if (method === 'PUT') {
        if (body?.definition) workflow.definition = body.definition;
        if (body?.name) workflow.name = String(body.name);
        return this.json(res, 200, workflow);
      }
      if (method === 'DELETE') {
        this.workflows.delete(workflow.id);
        return this.json(res, 200, { ok: true });
      }
    }
    if (path === '/v1/executions' && method === 'GET') {
      const workflowId = url.searchParams.get('workflowId');
      const items = this.executions.filter((execution) => !workflowId || execution.workflowId === workflowId);
      return this.json(res, 200, { data: items });
    }
    this.json(res, 404, { error: 'not_found', path });
  }
}
