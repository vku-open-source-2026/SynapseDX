// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseDX Tier-2 capabilities client.
 *
 * This client is deliberately independent of SynapseOne. SynapseDX owns this
 * API boundary, while its server uses @synapseone/sdk below the boundary.
 */

export interface CapabilitiesClientOptions {
  baseUrl?: string;
  token?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface DatasetInput {
  slug: string;
  name: string;
  entityType: string;
  license: string;
  description?: string;
  public?: boolean;
  owner?: string;
  schemaVersion?: string;
}

export interface Dataset extends DatasetInput {
  id: string;
  status: 'draft' | 'published' | 'revoked';
  ldsDatasourceId?: string;
  createdAt: string;
  updatedAt: string;
}

export type DatasetUpdateInput = Partial<Pick<DatasetInput,
  'name' | 'entityType' | 'license' | 'description' | 'public' | 'owner' | 'schemaVersion'
>>;

export interface RecordPage<T = Record<string, unknown>> {
  items: Array<{ id: string; data: T; version?: number; createdAt?: string; updatedAt?: string }>;
  total: number;
  limit: number;
  offset: number;
  nextCursor?: string | null;
}

export class CapabilitiesError extends Error {
  status?: number;
  body?: unknown;

  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'CapabilitiesError';
    this.status = opts.status;
    this.body = opts.body;
  }
}

function dependencyUrl(raw: string): string {
  const value = raw.replace(/\/$/, '');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`SynapseDX baseUrl must be an absolute URL: ${raw}`); }
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname);
  if (local && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true') {
    throw new Error('SynapseDX refuses a local dependency URL outside an explicit test override');
  }
  if (parsed.protocol !== 'https:' && !local) throw new Error('SynapseDX dependency URLs must use HTTPS');
  return value;
}

class Http {
  readonly baseUrl: string;
  private token?: string;
  private apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: CapabilitiesClientOptions = {}) {
    const raw = opts.baseUrl ?? process.env.SYNAPSEDX_BASE_URL ?? 'https://synapsedx.sbs';
    this.baseUrl = dependencyUrl(raw);
    this.token = opts.token;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    if (this.apiKey) headers.set('x-api-key', this.apiKey);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: init.signal ?? controller.signal });
    } catch (error) {
      throw new CapabilitiesError(`synapsedx network ${path}: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new CapabilitiesError(`synapsedx ${response.status} ${path}`, { status: response.status, body });
    return body as T;
  }
}

export class CapabilitiesClient {
  private readonly http: Http;
  readonly datasets: {
    list: (query?: { publicOnly?: boolean; limit?: number; offset?: number }) => Promise<Dataset[]>;
    get: (id: string) => Promise<Dataset>;
    create: (input: DatasetInput) => Promise<Dataset>;
    update: (id: string, input: DatasetUpdateInput) => Promise<Dataset>;
    publish: (id: string) => Promise<Dataset>;
    revoke: (id: string) => Promise<Dataset>;
    entities: (id: string, query?: { limit?: number; offset?: number }) => Promise<unknown[]>;
  };
  readonly records: {
    list: <T = Record<string, unknown>>(datasetId: string, query?: { limit?: number; offset?: number }) => Promise<RecordPage<T>>;
    get: <T = Record<string, unknown>>(datasetId: string, id: string) => Promise<{ id: string; data: T }>;
    create: <T = Record<string, unknown>>(datasetId: string, data: T, opts?: { id?: string; publish?: boolean }) => Promise<{ id: string; data: T }>;
    update: <T = Record<string, unknown>>(datasetId: string, id: string, data: T) => Promise<{ id: string; data: T }>;
  };

  constructor(opts: CapabilitiesClientOptions = {}) {
    this.http = new Http(opts);
    this.datasets = {
      list: (query = {}) => this.http.request<Dataset[]>(`/v1/capabilities/datasets?${new URLSearchParams({
        ...(query.publicOnly === undefined ? {} : { publicOnly: String(query.publicOnly) }),
        ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
        ...(query.offset === undefined ? {} : { offset: String(query.offset) }),
      })}`),
      get: (id) => this.http.request<Dataset>(`/v1/capabilities/datasets/${encodeURIComponent(id)}`),
      create: (input) => this.http.request<Dataset>('/v1/capabilities/datasets', { method: 'POST', body: JSON.stringify(input) }),
      update: (id, input) => this.http.request<Dataset>(`/v1/capabilities/datasets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
      publish: (id) => this.http.request<Dataset>(`/v1/capabilities/datasets/${encodeURIComponent(id)}/publish`, { method: 'POST' }),
      revoke: (id) => this.http.request<Dataset>(`/v1/capabilities/datasets/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
      entities: (id, query = {}) => this.http.request<unknown[]>(`/v1/capabilities/datasets/${encodeURIComponent(id)}/entities?${new URLSearchParams({
        ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
        ...(query.offset === undefined ? {} : { offset: String(query.offset) }),
      })}`),
    };
    this.records = {
      list: <T = Record<string, unknown>>(id: string, query: { limit?: number; offset?: number } = {}) => this.http.request<RecordPage<T>>(`/v1/capabilities/datasets/${encodeURIComponent(id)}/records?${new URLSearchParams({
        ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
        ...(query.offset === undefined ? {} : { offset: String(query.offset) }),
      })}`),
      get: (datasetId, id) => this.http.request(`/v1/capabilities/datasets/${encodeURIComponent(datasetId)}/records/${encodeURIComponent(id)}`),
      create: (datasetId, data, opts = {}) => this.http.request(`/v1/capabilities/datasets/${encodeURIComponent(datasetId)}/records`, {
        method: 'POST', body: JSON.stringify({ data, ...(opts.id ? { id: opts.id } : {}), ...(opts.publish === undefined ? {} : { publish: opts.publish }) }),
      }),
      update: (datasetId, id, data) => this.http.request(`/v1/capabilities/datasets/${encodeURIComponent(datasetId)}/records/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ data }),
      }),
    };
  }

  health(): Promise<{ status: string; service: string; dependencies?: unknown[] }> {
    return this.http.request('/health');
  }
}

