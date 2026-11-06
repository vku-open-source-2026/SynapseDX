// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseDX Tier-2 capabilities client.
 *
 * This client is deliberately independent of SynapseOne. SynapseDX owns this
 * API boundary, while its server uses @synapseone/sdk below the boundary.
 *
 * Authentication: pass a Tier-1-verifiable credential (`token` for
 * `Authorization: Bearer`, or `apiKey` for `X-API-Key`). Tier-2 verifies it and
 * scopes private dataset access to the principal's tenant.
 */

export interface CapabilitiesClientOptions {
  baseUrl?: string;
  token?: string;
  apiKey?: string;
  /** Forwarded as `x-synapseone-tenant` (Tier-1 tenant narrowing). */
  tenant?: string;
  /** Product identifier forwarded as `x-synapsedx-product`. */
  product?: string;
  /** Default correlation id; generated per request when omitted. */
  correlationId?: string;
  timeoutMs?: number;
  /** Retries for idempotent requests (GET) and network/5xx failures. */
  retries?: number;
  /** Extra headers applied to every request. */
  headers?: Record<string, string>;
  /** Injectable fetch implementation (tests). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  token?: string;
  apiKey?: string;
  tenant?: string;
  correlationId?: string;
  idempotencyKey?: string;
  ifVersion?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

export interface DatasetInput {
  slug: string;
  name: string;
  entityType: string;
  license: string;
  licenseUrl?: string;
  description?: string;
  public?: boolean;
  owner?: string;
  schemaVersion?: string;
  retentionDays?: number;
}

export interface Dataset extends DatasetInput {
  id: string;
  slug: string;
  status: 'draft' | 'published' | 'revoked';
  ldsDatasourceId?: string;
  tenant?: string;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export type DatasetUpdateInput = Partial<Pick<DatasetInput,
  'name' | 'entityType' | 'license' | 'licenseUrl' | 'description' | 'public' | 'owner' | 'schemaVersion' | 'retentionDays'
>>;

export interface DatasetListQuery {
  publicOnly?: boolean;
  status?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface DatasetPage {
  items: Dataset[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface RecordItem<T = Record<string, unknown>> {
  id: string;
  data: T;
  version: number;
  published?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecordPage<T = Record<string, unknown>> {
  items: Array<RecordItem<T>>;
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface RecordQuery {
  where?: Record<string, unknown>;
  orderBy?: string | { field: string; direction?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface RecordWriteOptions extends RequestOptions {
  id?: string;
  /** Per-record publication tri-state; undefined inherits the dataset default. */
  publish?: boolean;
}

export interface EntityPage<T = Record<string, unknown>> {
  items: T[];
  total: number;
  license?: string;
  licenseUrl?: string;
  datasourceId?: string;
  contexts: string[];
  cacheControl?: string;
}

export interface HealthDependency {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  latency_ms: number;
  critical: boolean;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  tier: number;
  version: string;
  dependencies: HealthDependency[];
  credentials?: { serviceCredential: boolean; callerVerification: string };
  time: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  user?: Record<string, unknown>;
  emailVerificationToken?: string;
}

export interface AuthLoginInput {
  email: string;
  /** Omit only when the deployment explicitly enables passwordless dev login. */
  password?: string;
  orgSlug?: string;
}

export interface AuthRegistrationInput {
  email: string;
  password: string;
  displayName?: string;
  orgSlug?: string;
}

export interface AuthExchangeInput {
  userId: string;
  accountId?: string;
  orgId?: string;
  scopes?: string[];
  audience?: string;
  ttlSeconds?: number;
}

export interface DelegatedToken {
  accessToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  delegated: true;
  userId: string;
  orgId: string;
  accountId: string;
  scopes: string[];
  audience?: string;
}

export interface AuthSessionInfo {
  id: string;
  created_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface PasswordChangeResult {
  ok: boolean;
  revokedSessions: number;
}

export interface PasswordResetRequest {
  ok: boolean;
  resetToken?: string;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JobSchedule {
  cron?: string;
  everySeconds?: number;
}

export interface Job {
  id: string;
  name: string;
  kind: string;
  executor: 'workflow' | 'runner';
  schedule: JobSchedule;
  payload?: Record<string, unknown>;
  datasetId?: string;
  enabled: boolean;
  workflowId: string;
  timeoutSeconds?: number;
  maxAttempts?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobKind {
  kind: string;
  description: string;
  fields: Record<string, string>;
}

export interface JobKindCatalog {
  items: JobKind[];
  runnerContract: { lease: string; heartbeat: string; complete: string };
}

export interface JobLease {
  jobId: string;
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  timeoutSeconds: number;
}

export interface JobLeaseInput {
  runnerId: string;
  limit?: number;
  leaseSeconds?: number;
  kinds?: string[];
}

export interface JobLeaseResult {
  leases: JobLease[];
  runnerId: string;
  count: number;
}

export interface JobRunStart {
  runId: string;
  status: string;
  jobId: string;
  deduplicated?: boolean;
  leaseEndpoint: string;
}

export interface JobRun {
  id: string;
  jobId?: string;
  kind?: string;
  status: string;
  triggeredBy?: string;
  scheduledFor?: string;
  startedAt?: string;
  finishedAt?: string;
  attempt: number;
  lastError?: string | null;
  error?: string;
  summary?: unknown;
}

export interface JobRunCompletion {
  run: JobRun;
  retry: boolean;
  retryAt?: string;
}

export interface AuditEntry {
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

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface EventFeedItem {
  id: string;
  event: {
    eventId: string;
    type: string;
    schemaVersion: 1;
    datasetId: string;
    recordId?: string;
    version?: string;
    at: string;
    correlationId: string;
    idempotencyKey?: string;
    payload?: Record<string, unknown>;
  };
}

export interface FileUploadInput {
  id?: string;
  filename: string;
  contentType?: string;
  size?: number;
  checksumSha256?: string;
  recordId?: string;
  datasetId?: string;
}

export interface FileObject {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256?: string;
  owner?: string;
  datasetId?: string;
  recordId?: string;
  downloadUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileUploadTicket extends FileObject {
  upload: {
    method: 'PUT';
    url: string;
    contentType: string;
    maxBytes: number;
    checksumSha256?: string;
  };
}

export interface FilePage {
  items: FileObject[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface FileQuota {
  tenant: string;
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  files: number;
  maxFileBytes: number;
  allowedTypes: string[];
}

export interface PresignResult {
  fileId: string;
  method: string;
  url: string;
  expiresIn: number;
  completeUrl?: string;
}

export type NotificationChannel = 'email' | 'sms' | 'push' | 'webhook' | 'log';

export interface NotificationRecipient {
  email?: string;
  phone?: string;
  pushToken?: string;
  url?: string;
  webhookUrl?: string;
  userId?: string;
}

export interface NotificationInput {
  channel?: NotificationChannel;
  channels?: NotificationChannel[];
  /** Convenience address; mapped to the recipient field for the channel. */
  to?: string;
  recipient?: NotificationRecipient;
  template?: string;
  variables?: Record<string, unknown>;
  subject?: string;
  body?: string;
  locale?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface NotificationRecord {
  id: string;
  channel: NotificationChannel;
  status: 'queued' | 'sending' | 'delivered' | 'failed' | 'dead' | 'cancelled';
  recipient?: NotificationRecipient;
  subject?: string;
  attempts?: number;
  error?: string;
  deadReason?: string;
  createdAt?: string;
  updatedAt?: string;
  nextAttemptAt?: string;
}

export type NotificationStatus = NotificationRecord;

export interface NotificationSendResult {
  notifications: NotificationRecord[];
  requested: number;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
  locale?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotificationTemplateInput {
  id?: string;
  name: string;
  channel: NotificationChannel;
  subject?: string;
  body: string;
  locale?: string;
}

export interface NotificationPreference {
  id?: string;
  tenant?: string;
  recipient: string;
  channels: NotificationChannel[];
  unsubscribed: boolean;
  updatedAt?: string;
}

export interface GeoResult {
  id?: string;
  label?: string;
  address?: string;
  lat?: number;
  lon?: number;
  raw?: unknown;
  [key: string]: unknown;
}

export class CapabilitiesError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  details?: unknown;
  body?: unknown;
  cause?: unknown;

  constructor(message: string, opts: {
    status?: number;
    code?: string;
    requestId?: string;
    details?: unknown;
    body?: unknown;
    cause?: unknown;
  } = {}) {
    super(message);
    this.name = 'CapabilitiesError';
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.details = opts.details;
    this.body = opts.body;
    this.cause = opts.cause;
  }
}

function dependencyUrl(raw: string): string {
  const value = raw.replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`SynapseDX baseUrl must be an absolute URL: ${raw}`); }
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname);
  if (local && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true') {
    throw new Error('SynapseDX refuses a local dependency URL outside an explicit test override');
  }
  if (parsed.protocol !== 'https:' && !local) throw new Error('SynapseDX dependency URLs must use HTTPS');
  return value;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value) !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function uuid(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

interface RawResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

class Http {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly apiKey?: string;
  private readonly tenant?: string;
  private readonly product?: string;
  private readonly correlationId?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;


  constructor(opts: CapabilitiesClientOptions = {}) {
    const raw = opts.baseUrl ?? process.env.SYNAPSEDX_BASE_URL ?? 'https://synapsedx.sbs';
    this.baseUrl = dependencyUrl(raw);
    this.token = opts.token;
    this.apiKey = opts.apiKey;
    this.tenant = opts.tenant;
    this.product = opts.product;
    this.correlationId = opts.correlationId;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.retries = opts.retries ?? 1;
    this.extraHeaders = opts.headers ?? {};
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async request<T>(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw<T>(path, init, opts)).data;
  }

  /** Binary download (no JSON decoding); same auth/retry semantics. */
  async requestBytes(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<{ data: Uint8Array; headers: Headers; status: number }> {
    const method = String(init.method || 'GET').toUpperCase();
    const maxAttempts = Math.max(0, opts.retries ?? this.retries) + 1;
    const idempotent = method === 'GET' || method === 'HEAD' || Boolean(opts.idempotencyKey);
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.onceBytes(path, init, opts);
      } catch (error) {
        lastError = error;
        const retriable = error instanceof CapabilitiesError
          ? (!error.status || error.status >= 500) && idempotent
          : false;
        if (!retriable || attempt === maxAttempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async onceBytes(path: string, init: RequestInit, opts: RequestOptions): Promise<{ data: Uint8Array; headers: Headers; status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/octet-stream');
    const token = opts.token ?? this.token;
    const apiKey = opts.apiKey ?? this.apiKey;
    const tenant = opts.tenant ?? this.tenant;
    const correlationId = opts.correlationId ?? this.correlationId ?? uuid();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (apiKey) headers.set('x-api-key', apiKey);
    if (tenant) headers.set('x-synapseone-tenant', tenant);
    if (this.product) headers.set('x-synapsedx-product', this.product);
    headers.set('x-correlation-id', correlationId);
    if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey);
    if (opts.ifVersion !== undefined) headers.set('if-match', `"${opts.ifVersion}"`);
    for (const [key, value] of Object.entries(this.extraHeaders)) headers.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init, headers, signal: opts.signal ?? controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new CapabilitiesError(`synapsedx network ${path}`, { cause: error, requestId: correlationId });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      const envelope = (body && typeof body === 'object' ? (body as any).error : undefined) || {};
      throw new CapabilitiesError(envelope.message || `synapsedx ${response.status} ${path}`, {
        status: response.status,
        code: envelope.code,
        requestId: envelope.requestId || response.headers.get('x-correlation-id') || correlationId,
        details: envelope.details,
        body,
      });
    }
    return { data: new Uint8Array(await response.arrayBuffer()), headers: response.headers, status: response.status };
  }

  async requestRaw<T>(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<RawResponse<T>> {
    const method = String(init.method || 'GET').toUpperCase();
    const maxAttempts = Math.max(0, opts.retries ?? this.retries) + 1;
    const idempotent = method === 'GET' || method === 'HEAD' || Boolean(opts.idempotencyKey);
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.once<T>(path, init, opts);
      } catch (error) {
        lastError = error;
        const retriable = error instanceof CapabilitiesError
          ? (!error.status || error.status >= 500) && idempotent
          : false;
        if (!retriable || attempt === maxAttempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async once<T>(path: string, init: RequestInit, opts: RequestOptions): Promise<RawResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    const token = opts.token ?? this.token;
    const apiKey = opts.apiKey ?? this.apiKey;
    const tenant = opts.tenant ?? this.tenant;
    const correlationId = opts.correlationId ?? this.correlationId ?? uuid();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (apiKey) headers.set('x-api-key', apiKey);
    if (tenant) headers.set('x-synapseone-tenant', tenant);
    if (this.product) headers.set('x-synapsedx-product', this.product);
    headers.set('x-correlation-id', correlationId);
    if (opts.idempotencyKey) headers.set('idempotency-key', opts.idempotencyKey);
    if (opts.ifVersion !== undefined) headers.set('if-match', `"${opts.ifVersion}"`);
    for (const [key, value] of Object.entries(this.extraHeaders)) headers.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: opts.signal ?? controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new CapabilitiesError(`synapsedx network ${path}`, { cause: error, requestId: correlationId });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const envelope = (body && typeof body === 'object' ? (body as any).error : undefined) || {};
      throw new CapabilitiesError(envelope.message || `synapsedx ${response.status} ${path}`, {
        status: response.status,
        code: envelope.code,
        requestId: envelope.requestId || response.headers.get('x-correlation-id') || correlationId,
        details: envelope.details,
        body,
      });
    }
    return { data: body as T, headers: response.headers, status: response.status };
  }
}


export interface KnowledgeDocumentInput {
  id?: string;
  title: string;
  body: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  kind?: 'text' | 'pdf' | 'html';
  tags?: string[];
}

export interface KnowledgeIndexResult {
  document: {
    id: string;
    title: string;
    body: string;
    source: string;
    url: string;
    publishedAt: string;
    kind: string;
    tags: string[];
    hash: string;
  };
  chunks: number;
  graph: { nodes: number; edges: number };
}

export interface KnowledgeCitation {
  index: number;
  title: string;
  documentId: string;
  url?: string;
  publishedAt?: string;
}

export interface KnowledgeAnswer {
  answer: string;
  citations: KnowledgeCitation[];
  entities: string[];
  noAnswer: boolean;
  model?: string;
}

export interface KnowledgeStatus {
  documents: number;
  chunks: number;
  graphNodes: number;
  graphEdges: number;
  backend: string;
  admin: boolean;
}

export interface HazardRecord {
  id: string;
  hazard_id: string;
  title: string;
  description: string;
  event_type: string;
  severity: string;
  source: string;
  is_active: boolean;
  geometry: { type: string; coordinates: unknown } | null;
  provinces: string[];
  url: string;
  published_at: string;
  fetched_at: string;
}

export interface HazardBrief {
  brief: string;
  hazards: Array<Pick<HazardRecord, 'id' | 'hazard_id' | 'title' | 'event_type' | 'severity' | 'provinces' | 'published_at' | 'url'>>;
  model: string | null;
  fallback: boolean;
  generated_at: string;
  hours: number;
}

export interface HazardFeed {
  hazards: HazardRecord[];
  total: number;
  hours: number;
}

export interface HazardCrawlStatus {
  status: 'ok' | 'error' | 'unconfigured' | string;
  configured: boolean;
  source: string;
  last_run_at?: string | null;
  last_success_at?: string | null;
  running?: boolean;
  hazards?: number;
  indexed?: number;
  sources?: Record<string, unknown>;
  error?: string | null;
}

export interface HazardCrawlResult {
  hazards: number;
  indexed: number;
  sources: Record<string, unknown>;
  error: string | null;
}

export class CapabilitiesClient {
  private readonly http: Http;

  readonly knowledge: {
    index: (input: KnowledgeDocumentInput, opts?: RequestOptions) => Promise<KnowledgeIndexResult>;
    ingestPdf: (input: { url: string; title?: string; publishedAt?: string; tags?: string[] }, opts?: RequestOptions) => Promise<KnowledgeIndexResult>;
    list: (query?: { limit?: number }, opts?: RequestOptions) => Promise<{ items: Array<{ id: string; title: string; source: string; url: string; kind: string; publishedAt: string }>; total: number }>;
    query: (input: { question: string; topK?: number; context?: string }, opts?: RequestOptions) => Promise<KnowledgeAnswer>;
    status: (opts?: RequestOptions) => Promise<KnowledgeStatus>;
  };

  readonly hazards: {
    today: (query?: { hours?: number; limit?: number }, opts?: RequestOptions) => Promise<HazardFeed>;
    brief: (input?: { hours?: number; limit?: number; focus?: string }, opts?: RequestOptions) => Promise<HazardBrief>;
    status: (opts?: RequestOptions) => Promise<HazardCrawlStatus>;
    runCrawler: (opts?: RequestOptions) => Promise<HazardCrawlResult>;
  };


  readonly datasets: {
    list: (query?: DatasetListQuery, opts?: RequestOptions) => Promise<Dataset[]>;
    listPage: (query?: DatasetListQuery, opts?: RequestOptions) => Promise<DatasetPage>;
    get: (id: string, opts?: RequestOptions) => Promise<Dataset>;
    create: (input: DatasetInput, opts?: RequestOptions) => Promise<Dataset>;
    update: (id: string, input: DatasetUpdateInput, opts?: RequestOptions) => Promise<Dataset>;
    delete: (id: string, opts?: RequestOptions & { purgeRecords?: boolean }) => Promise<void>;
    publish: (id: string, opts?: RequestOptions) => Promise<Dataset>;
    revoke: (id: string, opts?: RequestOptions) => Promise<Dataset>;
    entities: <T = Record<string, unknown>>(id: string, query?: { limit?: number; offset?: number }, opts?: RequestOptions) => Promise<T[]>;
    entitiesPage: <T = Record<string, unknown>>(id: string, query?: { limit?: number; offset?: number }, opts?: RequestOptions) => Promise<EntityPage<T>>;
  };

  readonly records: {
    list: <T = Record<string, unknown>>(datasetId: string, query?: { limit?: number; offset?: number; cursor?: string; publishedOnly?: boolean; orderBy?: string }, opts?: RequestOptions) => Promise<RecordPage<T>>;
    query: <T = Record<string, unknown>>(datasetId: string, query?: RecordQuery, opts?: RequestOptions) => Promise<RecordPage<T>>;
    get: <T = Record<string, unknown>>(datasetId: string, id: string, opts?: RequestOptions) => Promise<RecordItem<T>>;
    create: <T = Record<string, unknown>>(datasetId: string, data: T, opts?: RecordWriteOptions) => Promise<RecordItem<T>>;
    update: <T = Record<string, unknown>>(datasetId: string, id: string, data: T, opts?: RecordWriteOptions) => Promise<RecordItem<T>>;
    delete: (datasetId: string, id: string, opts?: RequestOptions) => Promise<void>;
    bulkCreate: <T = Record<string, unknown>>(datasetId: string, entries: Array<{ id?: string; data: T; publish?: boolean }>, opts?: RequestOptions) => Promise<{ created: Array<RecordItem<T>>; errors: Array<{ index: number; code: string; message: string }> }>;
    iterate: <T = Record<string, unknown>>(datasetId: string, query?: Omit<RecordQuery, 'offset' | 'cursor'>, opts?: RequestOptions) => AsyncGenerator<RecordItem<T>>;
  };

  readonly events: {
    list: (query?: { since?: string; type?: string; datasetId?: string; limit?: number }, opts?: RequestOptions) => Promise<{ items: EventFeedItem[]; count: number; nextCursor: string | null }>;
    flushOutbox: (datasetId: string, opts?: RequestOptions) => Promise<{ datasetId: string; pending: number; flushed: boolean }>;
  };

  readonly auth: {
    login: (input: AuthLoginInput, opts?: RequestOptions) => Promise<AuthSession>;
    register: (input: AuthRegistrationInput, opts?: RequestOptions) => Promise<AuthSession>;
    refresh: (refreshToken: string, opts?: RequestOptions) => Promise<AuthSession>;
    logout: (refreshToken: string, opts?: RequestOptions) => Promise<unknown>;
    logoutAll: (refreshToken: string, opts?: RequestOptions) => Promise<{ ok: boolean; revoked: number }>;
    changePassword: (currentPassword: string, newPassword: string, opts?: RequestOptions) => Promise<PasswordChangeResult>;
    requestPasswordReset: (email: string, orgSlug?: string, opts?: RequestOptions) => Promise<PasswordResetRequest>;
    resetPassword: (token: string, newPassword: string, opts?: RequestOptions) => Promise<PasswordChangeResult>;
    verifyEmail: (token: string, opts?: RequestOptions) => Promise<{ ok: boolean; emailVerified: boolean }>;
    requestEmailVerification: (opts?: RequestOptions) => Promise<{ ok: boolean; emailVerified?: boolean; emailVerificationToken?: string }>;
    sessions: (opts?: RequestOptions) => Promise<AuthSessionInfo[]>;
    revokeSession: (id: string, opts?: RequestOptions) => Promise<{ ok: boolean }>;
    me: (opts?: RequestOptions) => Promise<Record<string, unknown>>;
    oidcConfig: (opts?: RequestOptions) => Promise<Record<string, unknown>>;
    oidcStart: (org?: string, opts?: RequestOptions) => Promise<Record<string, unknown>>;
    oidcCallback: (code: string, state: string, opts?: RequestOptions) => Promise<AuthSession>;
    exchange: (input: AuthExchangeInput, opts?: RequestOptions) => Promise<DelegatedToken>;
  };

  readonly ai: {
    status: (opts?: RequestOptions) => Promise<Record<string, unknown>>;
    chat: (messages: AiChatMessage[], opts?: RequestOptions & { model?: string; temperature?: number; max_tokens?: number }) => Promise<unknown>;
    embeddings: (input: string | string[], opts?: RequestOptions & { model?: string }) => Promise<unknown>;
    decision: (state: string, questions: Record<string, unknown>, opts?: RequestOptions) => Promise<unknown>;
    route: (input: string, choices: Record<string, string>, instruction?: string, opts?: RequestOptions) => Promise<unknown>;
  };

  readonly jobs: {
    list: (query?: { limit?: number; offset?: number }, opts?: RequestOptions) => Promise<{ items: Job[]; total?: number; nextCursor?: string | null }>;
    get: (id: string, opts?: RequestOptions) => Promise<Job>;
    create: (input: { id?: string; name: string; kind?: string; schedule: JobSchedule; payload?: Record<string, unknown>; datasetId?: string; enabled?: boolean }, opts?: RequestOptions) => Promise<Job>;
    update: (id: string, patch: Partial<Pick<Job, 'name' | 'kind' | 'payload' | 'datasetId' | 'schedule' | 'enabled'>>, opts?: RequestOptions) => Promise<Job>;
    delete: (id: string, opts?: RequestOptions) => Promise<void>;
    runs: (id: string, query?: { limit?: number; offset?: number }, opts?: RequestOptions) => Promise<{ items: JobRun[]; limit: number; offset: number; nextCursor: string | null }>;
    run: (id: string, payload?: Record<string, unknown>, opts?: RequestOptions) => Promise<unknown>;
    kinds: (opts?: RequestOptions) => Promise<JobKindCatalog>;
    lease: (input: JobLeaseInput, opts?: RequestOptions) => Promise<JobLeaseResult>;
    heartbeat: (id: string, runId: string, leaseToken: string, opts?: RequestOptions & { leaseSeconds?: number }) => Promise<{ runId: string; leaseExpiresAt: string }>;
    complete: (id: string, runId: string, input: { leaseToken: string; status: 'succeeded' | 'failed' | 'dead'; summary?: unknown; error?: string }, opts?: RequestOptions) => Promise<JobRunCompletion>;
  };

  readonly audit: {
    list: (query?: { action?: string; datasetId?: string; recordId?: string; actor?: string; limit?: number; offset?: number }, opts?: RequestOptions) => Promise<AuditPage>;
  };

  readonly usage: {
    summary: (filter?: Record<string, string | number | undefined>, opts?: RequestOptions) => Promise<Record<string, unknown>>;
    events: (filter?: Record<string, string | number | undefined>, opts?: RequestOptions) => Promise<Record<string, unknown>>;
  };

  readonly files: {
    create: (input: FileUploadInput, opts?: RequestOptions) => Promise<FileUploadTicket>;
    /** Create metadata and immediately upload bytes when `content` is supplied. */
    upload: (input: FileUploadInput & { content?: Uint8Array | ArrayBuffer | string }, opts?: RequestOptions) => Promise<FileUploadTicket | FileObject>;
    uploadBytes: (id: string, content: Uint8Array | ArrayBuffer | string, opts?: RequestOptions & { contentType?: string; checksumSha256?: string }) => Promise<FileObject>;
    download: (id: string, opts?: RequestOptions) => Promise<{ data: Uint8Array; contentType?: string; checksumSha256?: string }>;
    get: (id: string, opts?: RequestOptions) => Promise<FileObject>;
    list: (query?: { prefix?: string; limit?: number; offset?: number }, opts?: RequestOptions) => Promise<FilePage>;
    quota: (opts?: RequestOptions) => Promise<FileQuota>;
    presign: (id: string, opts?: RequestOptions & { method?: 'GET' | 'HEAD' | 'PUT' | 'DELETE'; expiresIn?: number }) => Promise<PresignResult>;
    complete: (id: string, opts?: RequestOptions & { size?: number }) => Promise<FileObject>;
    delete: (id: string, opts?: RequestOptions) => Promise<void>;
  };

  readonly notifications: {
    send: (input: NotificationInput, opts?: RequestOptions) => Promise<NotificationSendResult>;
    get: (id: string, opts?: RequestOptions) => Promise<NotificationStatus>;
    list: (query?: { status?: NotificationStatus['status']; limit?: number }, opts?: RequestOptions) => Promise<{ items: NotificationStatus[]; count: number }>;
    cancel: (id: string, opts?: RequestOptions) => Promise<NotificationStatus>;
    createTemplate: (input: NotificationTemplateInput, opts?: RequestOptions) => Promise<NotificationTemplate>;
    listTemplates: (query?: { limit?: number; offset?: number }, opts?: RequestOptions) => Promise<{ items: NotificationTemplate[]; total: number; nextCursor: string | null }>;
    getTemplate: (id: string, opts?: RequestOptions) => Promise<NotificationTemplate>;
    updateTemplate: (id: string, patch: Partial<NotificationTemplateInput>, opts?: RequestOptions) => Promise<NotificationTemplate>;
    deleteTemplate: (id: string, opts?: RequestOptions) => Promise<void>;
    getPreference: (recipient: string, opts?: RequestOptions) => Promise<NotificationPreference>;
    setPreference: (recipient: string, input: { channels?: NotificationChannel[]; unsubscribed?: boolean }, opts?: RequestOptions) => Promise<NotificationPreference>;
    unsubscribe: (recipient: string, opts?: RequestOptions) => Promise<NotificationPreference>;
  };

  readonly geo: {
    autocomplete: (query: { q: string; limit?: number; focus?: string }, opts?: RequestOptions) => Promise<GeoResult[]>;
    geocode: (address: string, opts?: RequestOptions) => Promise<GeoResult[]>;
    reverse: (lat: number | string, lon: number | string, opts?: RequestOptions) => Promise<GeoResult[]>;
    place: (id: string, opts?: RequestOptions) => Promise<GeoResult | null>;
  };

  constructor(opts: CapabilitiesClientOptions = {}) {
    this.http = new Http(opts);
    const datasetPath = (id: string) => `/v1/capabilities/datasets/${encodeURIComponent(id)}`;

    this.datasets = {
      list: (query = {}, requestOpts) => this.http.request<Dataset[]>(
        `/v1/capabilities/datasets${queryString({ publicOnly: query.publicOnly, status: query.status, limit: query.limit, offset: query.offset, cursor: query.cursor })}`,
        {}, requestOpts,
      ),
      listPage: async (query = {}, requestOpts) => {
        const response = await this.http.requestRaw<Dataset[]>(
          `/v1/capabilities/datasets${queryString({ publicOnly: query.publicOnly, status: query.status, limit: query.limit, offset: query.offset, cursor: query.cursor })}`,
          {}, requestOpts,
        );
        return {
          items: response.data,
          total: Number(response.headers.get('x-total-count') ?? response.data.length),
          limit: Number(response.headers.get('x-limit') ?? query.limit ?? response.data.length),
          offset: Number(response.headers.get('x-offset') ?? query.offset ?? 0),
          nextCursor: response.headers.get('x-next-cursor'),
        };
      },
      get: (id, requestOpts) => this.http.request<Dataset>(datasetPath(id), {}, requestOpts),
      create: (input, requestOpts) => this.http.request<Dataset>('/v1/capabilities/datasets', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      update: (id, input, requestOpts) => this.http.request<Dataset>(datasetPath(id), {
        method: 'PATCH', body: JSON.stringify(input),
      }, requestOpts),
      delete: async (id, requestOpts = {}) => {
        await this.http.request<null>(`${datasetPath(id)}${queryString({ purgeRecords: requestOpts.purgeRecords })}`, { method: 'DELETE' }, requestOpts);
      },
      publish: (id, requestOpts) => this.http.request<Dataset>(`${datasetPath(id)}/publish`, { method: 'POST' }, requestOpts),
      revoke: (id, requestOpts) => this.http.request<Dataset>(`${datasetPath(id)}/revoke`, { method: 'POST' }, requestOpts),
      entities: <T = Record<string, unknown>>(id: string, query: { limit?: number; offset?: number } = {}, requestOpts?: RequestOptions) => this.http.request<T[]>(
        `${datasetPath(id)}/entities${queryString({ limit: query.limit, offset: query.offset })}`, {}, requestOpts,
      ),
      entitiesPage: async <T = Record<string, unknown>>(id: string, query: { limit?: number; offset?: number } = {}, requestOpts?: RequestOptions) => {
        const response = await this.http.requestRaw<T[]>(
          `${datasetPath(id)}/entities${queryString({ limit: query.limit, offset: query.offset })}`, {}, requestOpts,
        );
        const contexts = response.headers.get('x-lds-context');
        return {
          items: response.data,
          total: Number(response.headers.get('x-lds-total') ?? response.data.length),
          license: response.headers.get('x-lds-license') ?? undefined,
          licenseUrl: undefined,
          datasourceId: response.headers.get('x-lds-datasource') ?? undefined,
          contexts: contexts ? [contexts] : [],
          cacheControl: response.headers.get('cache-control') ?? undefined,
        };
      },
    };

    const recordsApi = {
      list: <T = Record<string, unknown>>(datasetId: string, query: {
        limit?: number; offset?: number; cursor?: string; publishedOnly?: boolean; orderBy?: string;
      } = {}, requestOpts?: RequestOptions) => this.http.request<RecordPage<T>>(
        `${datasetPath(datasetId)}/records${queryString({
          limit: query.limit, offset: query.offset, cursor: query.cursor,
          publishedOnly: query.publishedOnly, orderBy: query.orderBy,
        })}`, {}, requestOpts,
      ),
      query: <T = Record<string, unknown>>(datasetId: string, query: RecordQuery = {}, requestOpts?: RequestOptions) => this.http.request<RecordPage<T>>(
        `${datasetPath(datasetId)}/records/query`, {
          method: 'POST',
          body: JSON.stringify({
            ...(query.where !== undefined ? { where: query.where } : {}),
            ...(query.orderBy !== undefined ? { orderBy: query.orderBy } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            ...(query.offset !== undefined ? { offset: query.offset } : {}),
            ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
          }),
        }, requestOpts,
      ),
      get: <T = Record<string, unknown>>(datasetId: string, id: string, requestOpts?: RequestOptions) => this.http.request<RecordItem<T>>(
        `${datasetPath(datasetId)}/records/${encodeURIComponent(id)}`, {}, requestOpts,
      ),
      create: <T = Record<string, unknown>>(datasetId: string, data: T, requestOpts: RecordWriteOptions = {}) => this.http.request<RecordItem<T>>(
        `${datasetPath(datasetId)}/records`, {
          method: 'POST',
          body: JSON.stringify({
            data,
            ...(requestOpts.id !== undefined ? { id: requestOpts.id } : {}),
            ...(requestOpts.publish !== undefined ? { publish: requestOpts.publish } : {}),
          }),
        }, requestOpts,
      ),
      update: <T = Record<string, unknown>>(datasetId: string, id: string, data: T, requestOpts: RecordWriteOptions = {}) => this.http.request<RecordItem<T>>(
        `${datasetPath(datasetId)}/records/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            data,
            ...(requestOpts.publish !== undefined ? { publish: requestOpts.publish } : {}),
          }),
        }, requestOpts,
      ),
      delete: async (datasetId: string, id: string, requestOpts?: RequestOptions) => {
        await this.http.request<null>(`${datasetPath(datasetId)}/records/${encodeURIComponent(id)}`, { method: 'DELETE' }, requestOpts);
      },
      bulkCreate: <T = Record<string, unknown>>(datasetId: string, entries: Array<{ id?: string; data: T; publish?: boolean }>, requestOpts?: RequestOptions) => this.http.request<{ created: Array<RecordItem<T>>; errors: Array<{ index: number; code: string; message: string }> }>(
        `${datasetPath(datasetId)}/records/bulk`, { method: 'POST', body: JSON.stringify({ records: entries }) }, requestOpts,
      ),
      iterate: async function* iterate(): AsyncGenerator<RecordItem<unknown>> {
        // Replaced below; keeps the object shape type-safe.
        return;
      },
    } as CapabilitiesClient['records'];

    recordsApi.iterate = async function* iterate<T = Record<string, unknown>>(
      this: CapabilitiesClient,
      datasetId: string,
      query: Omit<RecordQuery, 'offset' | 'cursor'> = {},
      requestOpts?: RequestOptions,
    ): AsyncGenerator<RecordItem<T>> {
      const pageSize = query.limit ?? 100;
      let offset = 0;
      for (;;) {
        const page = await this.records.query<T>(datasetId, { ...query, limit: pageSize, offset }, requestOpts);
        for (const item of page.items) yield item;
        if (!page.items.length || offset + page.items.length >= page.total) return;
        offset += page.items.length;
      }
    }.bind(this) as typeof recordsApi.iterate;
    this.records = recordsApi;

    this.events = {
      list: (query = {}, requestOpts) => this.http.request<{ items: EventFeedItem[]; count: number; nextCursor: string | null }>(
        `/v1/capabilities/events${queryString({ since: query.since, type: query.type, datasetId: query.datasetId, limit: query.limit })}`,
        {}, requestOpts,
      ),
      flushOutbox: (datasetId, requestOpts) => this.http.request<{ datasetId: string; pending: number; flushed: boolean }>(
        `/v1/capabilities/events/outbox/flush${queryString({ datasetId })}`, { method: 'POST' }, requestOpts,
      ),
    };

    this.auth = {
      login: (input, requestOpts) => this.http.request<AuthSession>('/v1/capabilities/auth/login', { method: 'POST', body: JSON.stringify(input) }, requestOpts),
      register: (input, requestOpts) => this.http.request<AuthSession>('/v1/capabilities/auth/register', { method: 'POST', body: JSON.stringify(input) }, requestOpts),
      refresh: (refreshToken, requestOpts) => this.http.request<AuthSession>('/v1/capabilities/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }, requestOpts),
      logout: (refreshToken, requestOpts) => this.http.request<unknown>('/v1/capabilities/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }, requestOpts),
      logoutAll: (refreshToken, requestOpts) => this.http.request<{ ok: boolean; revoked: number }>('/v1/capabilities/auth/logout-all', { method: 'POST', body: JSON.stringify({ refreshToken }) }, requestOpts),
      changePassword: (currentPassword, newPassword, requestOpts) => this.http.request<PasswordChangeResult>('/v1/capabilities/auth/password/change', {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
      }, requestOpts),
      requestPasswordReset: (email, orgSlug, requestOpts) => this.http.request<PasswordResetRequest>('/v1/capabilities/auth/password/forgot', {
        method: 'POST', body: JSON.stringify({ email, ...(orgSlug ? { orgSlug } : {}) }),
      }, requestOpts),
      resetPassword: (token, newPassword, requestOpts) => this.http.request<PasswordChangeResult>('/v1/capabilities/auth/password/reset', {
        method: 'POST', body: JSON.stringify({ token, newPassword }),
      }, requestOpts),
      verifyEmail: (token, requestOpts) => this.http.request<{ ok: boolean; emailVerified: boolean }>('/v1/capabilities/auth/email/verify', {
        method: 'POST', body: JSON.stringify({ token }),
      }, requestOpts),
      requestEmailVerification: (requestOpts) => this.http.request<{ ok: boolean; emailVerified?: boolean; emailVerificationToken?: string }>('/v1/capabilities/auth/email/verify/request', {
        method: 'POST', body: '{}',
      }, requestOpts),
      sessions: (requestOpts) => this.http.request<AuthSessionInfo[]>('/v1/capabilities/auth/sessions', {}, requestOpts),
      revokeSession: (id, requestOpts) => this.http.request<{ ok: boolean }>(`/v1/capabilities/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, requestOpts),
      me: (requestOpts) => this.http.request<Record<string, unknown>>('/v1/capabilities/auth/me', {}, requestOpts),
      oidcConfig: (requestOpts) => this.http.request<Record<string, unknown>>('/v1/capabilities/auth/oidc/config', {}, requestOpts),
      oidcStart: (org, requestOpts) => this.http.request<Record<string, unknown>>(`/v1/capabilities/auth/oidc/start${queryString({ org })}`, {}, requestOpts),
      oidcCallback: (code, state, requestOpts) => this.http.request<AuthSession>('/v1/capabilities/auth/oidc/callback', { method: 'POST', body: JSON.stringify({ code, state }) }, requestOpts),
      exchange: (input, requestOpts) => this.http.request<DelegatedToken>('/v1/capabilities/auth/exchange', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
    };

    this.ai = {
      status: (requestOpts) => this.http.request<Record<string, unknown>>('/v1/capabilities/ai/status', {}, requestOpts),
      chat: (messages, requestOpts = {}) => this.http.request<unknown>('/v1/capabilities/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages,
          ...(requestOpts.model ? { model: requestOpts.model } : {}),
          ...(requestOpts.temperature !== undefined ? { temperature: requestOpts.temperature } : {}),
          ...(requestOpts.max_tokens !== undefined ? { max_tokens: requestOpts.max_tokens } : {}),
        }),
      }, requestOpts),
      embeddings: (input, requestOpts = {}) => this.http.request<unknown>('/v1/capabilities/ai/embeddings', {
        method: 'POST',
        body: JSON.stringify({ input, ...(requestOpts.model ? { model: requestOpts.model } : {}) }),
      }, requestOpts),
      decision: (state, questions, requestOpts) => this.http.request<unknown>('/v1/capabilities/ai/decision', {
        method: 'POST', body: JSON.stringify({ state, questions }),
      }, requestOpts),
      route: (input, choices, instruction, requestOpts) => this.http.request<unknown>('/v1/capabilities/ai/route', {
        method: 'POST', body: JSON.stringify({ input, choices, ...(instruction ? { instruction } : {}) }),
      }, requestOpts),
    };

    this.jobs = {
      list: (query = {}, requestOpts) => this.http.request<{ items: Job[]; total?: number; nextCursor?: string | null }>(
        `/v1/capabilities/jobs${queryString({ limit: query.limit, offset: query.offset })}`, {}, requestOpts,
      ),
      get: (id, requestOpts) => this.http.request<Job>(`/v1/capabilities/jobs/${encodeURIComponent(id)}`, {}, requestOpts),
      create: (input, requestOpts) => this.http.request<Job>('/v1/capabilities/jobs', { method: 'POST', body: JSON.stringify(input) }, requestOpts),
      update: (id, patch, requestOpts) => this.http.request<Job>(`/v1/capabilities/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, requestOpts),
      delete: async (id, requestOpts) => {
        await this.http.request<null>(`/v1/capabilities/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }, requestOpts);
      },
      runs: (id, query = {}, requestOpts) => this.http.request<{ items: JobRun[]; limit: number; offset: number; nextCursor: string | null }>(
        `/v1/capabilities/jobs/${encodeURIComponent(id)}/runs${queryString({ limit: query.limit, offset: query.offset })}`, {}, requestOpts,
      ),
      run: (id, payload, requestOpts) => this.http.request<unknown>(`/v1/capabilities/jobs/${encodeURIComponent(id)}/run`, {
        method: 'POST', ...(payload ? { body: JSON.stringify({ payload }) } : {}),
      }, requestOpts),
      kinds: (requestOpts) => this.http.request<JobKindCatalog>('/v1/capabilities/jobs/kinds', {}, requestOpts),
      lease: (input, requestOpts) => this.http.request<JobLeaseResult>('/v1/capabilities/jobs/lease', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      heartbeat: (id, runId, leaseToken, requestOpts = {}) => this.http.request<{ runId: string; leaseExpiresAt: string }>(
        `/v1/capabilities/jobs/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/heartbeat`, {
          method: 'POST',
          body: JSON.stringify({
            leaseToken,
            ...(requestOpts.leaseSeconds !== undefined ? { leaseSeconds: requestOpts.leaseSeconds } : {}),
          }),
        }, requestOpts,
      ),
      complete: (id, runId, input, requestOpts) => this.http.request<JobRunCompletion>(
        `/v1/capabilities/jobs/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/complete`, {
          method: 'POST', body: JSON.stringify(input),
        }, requestOpts,
      ),
    };

    this.audit = {
      list: (query = {}, requestOpts) => this.http.request<AuditPage>(
        `/v1/capabilities/audit${queryString({
          action: query.action, datasetId: query.datasetId, recordId: query.recordId,
          actor: query.actor, limit: query.limit, offset: query.offset,
        })}`, {}, requestOpts,
      ),
    };

    this.usage = {
      summary: (filter = {}, requestOpts) => this.http.request<Record<string, unknown>>(
        `/v1/capabilities/usage${queryString(filter)}`, {}, requestOpts,
      ),
      events: (filter = {}, requestOpts) => this.http.request<Record<string, unknown>>(
        `/v1/capabilities/usage/events${queryString(filter)}`, {}, requestOpts,
      ),
    };

    const filePath = (id: string) => `/v1/capabilities/files/${encodeURIComponent(id)}`;
    const createFile = (input: FileUploadInput, requestOpts?: RequestOptions) => this.http.request<FileUploadTicket>(
      '/v1/capabilities/files', { method: 'POST', body: JSON.stringify(input) }, requestOpts,
    );
    const uploadFileBytes = (id: string, content: Uint8Array | ArrayBuffer | string, requestOpts: RequestOptions & { contentType?: string; checksumSha256?: string } = {}) => {
      const bytes = toBytes(content);
      return this.http.request<FileObject>(`${filePath(id)}/content`, {
        method: 'PUT',
        body: bytes as unknown as BodyInit,
        headers: {
          'content-type': requestOpts.contentType || 'application/octet-stream',
          ...(requestOpts.checksumSha256 ? { 'x-checksum-sha256': requestOpts.checksumSha256 } : {}),
        },
      }, requestOpts);
    };
    this.files = {
      create: createFile,
      upload: async (input, requestOpts) => {
        const { content, ...metadata } = input;
        const ticket = await createFile(metadata, requestOpts);
        if (content === undefined) return ticket;
        return uploadFileBytes(ticket.id, content, {
          ...requestOpts,
          contentType: ticket.upload.contentType,
          ...(ticket.upload.checksumSha256 ? { checksumSha256: ticket.upload.checksumSha256 } : {}),
        });
      },
      uploadBytes: uploadFileBytes,
      download: async (id, requestOpts) => {
        const response = await this.http.requestBytes(`${filePath(id)}/content`, {}, requestOpts);
        return {
          data: response.data,
          ...(response.headers.get('content-type') ? { contentType: String(response.headers.get('content-type')) } : {}),
          ...(response.headers.get('x-checksum-sha256') ? { checksumSha256: String(response.headers.get('x-checksum-sha256')) } : {}),
        };
      },
      get: (id, requestOpts) => this.http.request<FileObject>(filePath(id), {}, requestOpts),
      list: (query = {}, requestOpts) => this.http.request<FilePage>(
        `/v1/capabilities/files${queryString({ prefix: query.prefix, limit: query.limit, offset: query.offset })}`, {}, requestOpts,
      ),
      quota: (requestOpts) => this.http.request<FileQuota>('/v1/capabilities/files/quota', {}, requestOpts),
      presign: (id, requestOpts = {}) => this.http.request<PresignResult>(`${filePath(id)}/presign`, {
        method: 'POST',
        body: JSON.stringify({
          method: requestOpts.method || 'GET',
          ...(requestOpts.expiresIn !== undefined ? { expiresIn: requestOpts.expiresIn } : {}),
        }),
      }, requestOpts),
      complete: (id, requestOpts = {}) => this.http.request<FileObject>(`${filePath(id)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          ...(requestOpts.size !== undefined ? { size: requestOpts.size } : {}),
        }),
      }, requestOpts),
      delete: async (id, requestOpts) => {
        await this.http.request<null>(filePath(id), { method: 'DELETE' }, requestOpts);
      },
    };

    const notificationPath = (id: string) => `/v1/capabilities/notifications/${encodeURIComponent(id)}`;
    this.notifications = {
      send: (input, requestOpts) => this.http.request<NotificationSendResult>('/v1/capabilities/notifications/send', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      get: (id, requestOpts) => this.http.request<NotificationStatus>(notificationPath(id), {}, requestOpts),
      list: (query = {}, requestOpts) => this.http.request<{ items: NotificationStatus[]; count: number }>(
        `/v1/capabilities/notifications${queryString({ status: query.status, limit: query.limit })}`, {}, requestOpts,
      ),
      cancel: (id, requestOpts) => this.http.request<NotificationStatus>(`${notificationPath(id)}/cancel`, { method: 'POST', body: '{}' }, requestOpts),
      createTemplate: (input, requestOpts) => this.http.request<NotificationTemplate>('/v1/capabilities/notifications/templates', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      listTemplates: (query = {}, requestOpts) => this.http.request<{ items: NotificationTemplate[]; total: number; nextCursor: string | null }>(
        `/v1/capabilities/notifications/templates${queryString({ limit: query.limit, offset: query.offset })}`, {}, requestOpts,
      ),
      getTemplate: (id, requestOpts) => this.http.request<NotificationTemplate>(`/v1/capabilities/notifications/templates/${encodeURIComponent(id)}`, {}, requestOpts),
      updateTemplate: (id, patch, requestOpts) => this.http.request<NotificationTemplate>(`/v1/capabilities/notifications/templates/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }, requestOpts),
      deleteTemplate: async (id, requestOpts) => {
        await this.http.request<null>(`/v1/capabilities/notifications/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }, requestOpts);
      },
      getPreference: (recipient, requestOpts) => this.http.request<NotificationPreference>(`/v1/capabilities/notifications/preferences/${encodeURIComponent(recipient)}`, {}, requestOpts),
      setPreference: (recipient, input, requestOpts) => this.http.request<NotificationPreference>(`/v1/capabilities/notifications/preferences/${encodeURIComponent(recipient)}`, {
        method: 'PUT', body: JSON.stringify(input),
      }, requestOpts),
      unsubscribe: (recipient, requestOpts) => this.http.request<NotificationPreference>('/v1/capabilities/notifications/unsubscribe', {
        method: 'POST', body: JSON.stringify({ recipient }),
      }, requestOpts),
    };


    this.knowledge = {
      index: (input, requestOpts) => this.http.request<KnowledgeIndexResult>('/v1/capabilities/knowledge/documents', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      ingestPdf: (input, requestOpts) => this.http.request<KnowledgeIndexResult>('/v1/capabilities/knowledge/ingest/pdf', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      list: (query = {}, requestOpts) => this.http.request<{ items: Array<{ id: string; title: string; source: string; url: string; kind: string; publishedAt: string }>; total: number }>(
        `/v1/capabilities/knowledge/documents${queryString({ limit: query.limit })}`, {}, requestOpts,
      ),
      query: (input, requestOpts) => this.http.request<KnowledgeAnswer>('/v1/capabilities/knowledge/query', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      status: (requestOpts) => this.http.request<KnowledgeStatus>('/v1/capabilities/knowledge/status', {}, requestOpts),
    };

    this.hazards = {
      today: (query = {}, requestOpts) => this.http.request<HazardFeed>(
        `/v1/capabilities/hazards/today${queryString({ hours: query.hours, limit: query.limit })}`, {}, requestOpts,
      ),
      brief: (input = {}, requestOpts) => this.http.request<HazardBrief>('/v1/capabilities/hazards/brief', {
        method: 'POST', body: JSON.stringify(input),
      }, requestOpts),
      status: (requestOpts) => this.http.request<HazardCrawlStatus>('/v1/capabilities/hazards/status', {}, requestOpts),
      runCrawler: (requestOpts) => this.http.request<HazardCrawlResult>('/v1/capabilities/crawlers/kttv/run', {
        method: 'POST', body: '{}',
      }, requestOpts),
    };

    this.geo = {
      autocomplete: async (query, requestOpts) => {
        const body = await this.http.request<{ items: GeoResult[] }>(`/v1/capabilities/geo/autocomplete${queryString({ q: query.q, limit: query.limit, focus: query.focus })}`, {}, requestOpts);
        return body.items;
      },
      geocode: async (address, requestOpts) => {
        const body = await this.http.request<{ items: GeoResult[] }>(`/v1/capabilities/geo/geocode${queryString({ address })}`, {}, requestOpts);
        return body.items;
      },
      reverse: async (lat, lon, requestOpts) => {
        const body = await this.http.request<{ items: GeoResult[] }>(`/v1/capabilities/geo/reverse${queryString({ lat, lon })}`, {}, requestOpts);
        return body.items;
      },
      place: async (id, requestOpts) => {
        const body = await this.http.request<{ result: GeoResult | null }>(`/v1/capabilities/geo/place${queryString({ id })}`, {}, requestOpts);
        return body.result;
      },
    };
  }

  health(opts?: RequestOptions): Promise<HealthReport> {
    return this.http.request<HealthReport>('/v1/capabilities/health', {}, opts);
  }

  ready(opts?: RequestOptions): Promise<HealthReport> {
    return this.http.request<HealthReport>('/v1/capabilities/ready', {}, opts);
  }

  capabilities(opts?: RequestOptions): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>('/v1/capabilities', {}, opts);
  }
}
