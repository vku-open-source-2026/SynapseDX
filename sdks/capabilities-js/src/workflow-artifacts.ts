// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 workflow artifact client (DX-managed Tier-1 workflow exported code).
 *
 * This file is intentionally separate from `index.ts`: the workflow task owns
 * only this new module and must not edit the shared published client entrypoint.
 * Consumers may import it directly (`@synapsedx/capabilities/dist/workflow-artifacts`)
 * until the coordinator wires it into the main export.
 *
 * The client only talks to the DX capabilities API. Tier-1 Workflow execution
 * and Base persistence happen inside the DX service through the published
 * @synapseone/sdk; this SDK never calls Tier-1 directly.
 */

export interface WorkflowArtifactsClientOptions {
  /** Default: `SYNAPSEDX_BASE_URL` or `https://synapsedx.sbs`. */
  baseUrl?: string;
  /** Tier-1-verifiable bearer token forwarded as Authorization. */
  token?: string;
  /** Tier-1-verifiable API key forwarded as X-API-Key. */
  apiKey?: string;
  /** Forwarded as `x-synapseone-tenant`. */
  tenant?: string;
  correlationId?: string;
  timeoutMs?: number;
  /** Retries for idempotent requests (GET) and network/5xx failures. */
  retries?: number;
  headers?: Record<string, string>;
  /** Injectable fetch implementation (tests). */
  fetch?: typeof fetch;
}

export interface WorkflowArtifactRequestOptions {
  token?: string;
  apiKey?: string;
  tenant?: string;
  correlationId?: string;
  ifVersion?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkflowGraph {
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface WorkflowArtifactSource {
  kind: 'bundle' | 'tier1-workflow' | 'definition';
  repository?: string;
  path?: string;
  revision?: string;
}

export interface WorkflowArtifactSummary {
  id: string;
  tenant?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  slug?: string;
  format: 'synapsedx-workflow-artifact';
  formatVersion: 1;
  revision: number;
  workflowId: string;
  workflowRevision?: number;
  active: boolean;
  managedBy?: 'technical' | 'user';
  accessMode?: 'owner-only' | 'legacy' | 'unsupported';
  protected?: boolean;
  source: WorkflowArtifactSource;
  checksum: string;
  portableChecksum?: string;
  credentialBindingCount?: number;
  credentialNames?: string[];
  credentialRedactions: string[];
  versionCount: number;
  nodeCount: number;
  lastExecutedAt?: string;
  lastExecutionId?: string;
  /** Tier-1 Base document version (optimistic concurrency). */
  version: number;
}

export interface WorkflowArtifact extends Omit<WorkflowArtifactSummary, 'nodeCount'> {
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface WorkflowArtifactPage {
  items: WorkflowArtifactSummary[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface WorkflowArtifactBundle {
  format: 'synapsedx-workflow-artifact';
  formatVersion: 1;
  artifact?: { name?: string; description?: string; slug?: string; revision?: number };
  workflow: WorkflowGraph;
  source?: WorkflowArtifactSource;
  checksum?: string;
}

export interface WorkflowArtifactExport extends WorkflowArtifactBundle {
  /** Portable ref-graph checksum (import integrity). */
  checksum: string;
  /** Deployed credential-id graph checksum (plugin binding pin). */
  deployedChecksum: string;
  portableChecksum: string;
  credentialBindingCount: number;
  credentialRedactions: string[];
  redacted: boolean;
  workflowRevision: number | null;
  artifactVersion: number;
  synchronised: boolean;
  exportedAt: string;
}

export interface WorkflowArtifactVersion {
  revision: number;
  workflowRevision?: number;
  checksum: string;
  createdBy: string;
  createdAt: string;
  nodeCount: number;
  redactions: number;
}

export interface WorkflowArtifactVersionSnapshot extends Omit<WorkflowGraph, 'settings'> {
  id: string;
  artifactId: string;
  tenant?: string;
  revision: number;
  workflowRevision?: number;
  checksum: string;
  createdBy: string;
  createdAt: string;
  settings: Record<string, unknown>;
  credentialRedactions: string[];
  version: number;
}

export interface WorkflowArtifactExecution {
  artifactId: string;
  workflowId: string;
  revision: number;
  checksum: string;
  /** True only when the DX service verified the published-SDK revision gate. */
  revisionPinned: boolean;
  expectedWorkflowRevision?: number;
  execution: unknown;
}

export type WorkflowArtifactImportInput =
  | WorkflowArtifactBundle
  | { bundle: WorkflowArtifactBundle; activate?: boolean }
  | { workflowId: string; name?: string; description?: string; slug?: string; activate?: boolean }
  | {
      name: string;
      description?: string;
      slug?: string;
      definition: WorkflowGraph;
      activate?: boolean;
      source?: WorkflowArtifactSource;
    };

export interface WorkflowArtifactUpdateInput {
  /** Tier-1 Base document version from GET/list. */
  version: number;
  name?: string;
  description?: string;
  definition?: WorkflowGraph;
  settings?: Record<string, unknown>;
  activate?: boolean;
}

export interface WorkflowArtifactsPageQuery {
  limit?: number;
  offset?: number;
  cursor?: string;
}

const FORMAT = 'synapsedx-workflow-artifact';
const DEFAULT_BASE_URL = 'https://synapsedx.sbs';

export class WorkflowArtifactsError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(message: string, init: { status?: number; code?: string; requestId?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'WorkflowArtifactsError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
  }
}

function dependencyUrl(raw: string): string {
  const value = raw.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`SynapseDX baseUrl must be an absolute URL: ${raw}`);
  }
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

function uuid(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

function artifactId(value: string): string {
  const id = String(value || '').trim();
  if (!id) throw new WorkflowArtifactsError('workflow artifact id is required');
  return encodeURIComponent(id);
}

function assertBundle(bundle: unknown): WorkflowArtifactBundle {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new WorkflowArtifactsError('workflow bundle must be a JSON object');
  }
  const candidate = bundle as Record<string, unknown>;
  if (candidate.format !== FORMAT || Number(candidate.formatVersion) !== 1) {
    throw new WorkflowArtifactsError(`workflow bundle must use ${FORMAT} formatVersion 1`);
  }
  if (!candidate.workflow || typeof candidate.workflow !== 'object' || Array.isArray(candidate.workflow)) {
    throw new WorkflowArtifactsError('workflow bundle must contain a workflow object');
  }
  return bundle as WorkflowArtifactBundle;
}

export class WorkflowArtifactsClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly apiKey?: string;
  private readonly tenant?: string;
  private readonly correlationId?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WorkflowArtifactsClientOptions = {}) {
    this.baseUrl = dependencyUrl(options.baseUrl ?? process.env.SYNAPSEDX_BASE_URL ?? DEFAULT_BASE_URL);
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.tenant = options.tenant;
    this.correlationId = options.correlationId;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.retries = options.retries ?? 1;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: WorkflowArtifactRequestOptions = {},
  ): Promise<T> {
    const method = String(init.method || 'GET').toUpperCase();
    const idempotent = method === 'GET' || method === 'HEAD';
    const maxAttempts = Math.max(0, this.retries) + 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.once<T>(path, init, options);
      } catch (error) {
        lastError = error;
        const retriable = error instanceof WorkflowArtifactsError
          && idempotent
          && (!error.status || error.status >= 500);
        if (!retriable || attempt === maxAttempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async once<T>(
    path: string,
    init: RequestInit,
    options: WorkflowArtifactRequestOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    const token = options.token ?? this.token;
    const apiKey = options.apiKey ?? this.apiKey;
    const tenant = options.tenant ?? this.tenant;
    const correlationId = options.correlationId ?? this.correlationId ?? uuid();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (apiKey) headers.set('x-api-key', apiKey);
    if (tenant) headers.set('x-synapseone-tenant', tenant);
    headers.set('x-correlation-id', correlationId);
    if (options.ifVersion !== undefined) headers.set('if-match', `"${options.ifVersion}"`);
    for (const [key, value] of Object.entries(this.headers)) headers.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: options.signal ?? controller.signal,
      });
    } catch (error) {
      throw new WorkflowArtifactsError(`synapsedx network ${path}`, { requestId: correlationId, details: error });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const envelope = (body && typeof body === 'object' ? (body as any).error : undefined) || {};
      throw new WorkflowArtifactsError(envelope.message || `synapsedx ${response.status} ${path}`, {
        status: response.status,
        code: envelope.code,
        requestId: envelope.requestId || response.headers.get('x-correlation-id') || correlationId,
        details: envelope.details,
      });
    }
    return body as T;
  }

  list(query: WorkflowArtifactsPageQuery = {}, options: WorkflowArtifactRequestOptions = {}): Promise<WorkflowArtifactPage> {
    return this.request<WorkflowArtifactPage>(
      `/v1/capabilities/workflow-artifacts${queryString({ limit: query.limit, offset: query.offset, cursor: query.cursor })}`,
      {},
      options,
    );
  }

  get(id: string, options: WorkflowArtifactRequestOptions = {}): Promise<WorkflowArtifact> {
    return this.request<WorkflowArtifact>(`/v1/capabilities/workflow-artifacts/${artifactId(id)}`, {}, options);
  }

  importArtifact(input: WorkflowArtifactImportInput, options: WorkflowArtifactRequestOptions = {}): Promise<WorkflowArtifact> {
    const body = (input && typeof input === 'object' && 'bundle' in (input as Record<string, unknown>))
      ? { ...(input as Record<string, unknown>), bundle: assertBundle((input as any).bundle) }
      : (input && typeof input === 'object' && 'format' in (input as Record<string, unknown>))
        ? assertBundle(input)
        : input;
    return this.request<WorkflowArtifact>('/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }, options);
  }

  /** Snapshot an existing Tier-1 workflow into a DX-managed artifact. */
  importFromWorkflow(
    workflowId: string,
    input: { name?: string; description?: string; slug?: string } = {},
    options: WorkflowArtifactRequestOptions = {},
  ): Promise<WorkflowArtifact> {
    const id = String(workflowId || '').trim();
    if (!id) throw new WorkflowArtifactsError('workflowId is required');
    return this.request<WorkflowArtifact>('/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      body: JSON.stringify({ ...input, workflowId: id, clone: true }),
    }, options);
  }

  export(id: string, options: WorkflowArtifactRequestOptions = {}): Promise<WorkflowArtifactExport> {
    return this.request<WorkflowArtifactExport>(`/v1/capabilities/workflow-artifacts/${artifactId(id)}/export`, {}, options);
  }

  update(
    id: string,
    patch: WorkflowArtifactUpdateInput,
    options: WorkflowArtifactRequestOptions = {},
  ): Promise<WorkflowArtifact> {
    if (!Number.isInteger(patch?.version) || patch.version < 1) {
      throw new WorkflowArtifactsError('version must be the artifact document version');
    }
    return this.request<WorkflowArtifact>(`/v1/capabilities/workflow-artifacts/${artifactId(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }, { ...options, ifVersion: options.ifVersion ?? patch.version });
  }

  execute(
    id: string,
    payload: Record<string, unknown> = {},
    options: WorkflowArtifactRequestOptions = {},
  ): Promise<WorkflowArtifactExecution> {
    return this.request<WorkflowArtifactExecution>(`/v1/capabilities/workflow-artifacts/${artifactId(id)}/execute`, {
      method: 'POST',
      body: JSON.stringify({ payload }),
    }, options);
  }

  versions(
    id: string,
    options: WorkflowArtifactRequestOptions = {},
  ): Promise<{ items: WorkflowArtifactVersion[]; total: number }> {
    return this.request<{ items: WorkflowArtifactVersion[]; total: number }>(
      `/v1/capabilities/workflow-artifacts/${artifactId(id)}/versions`,
      {},
      options,
    );
  }

  version(
    id: string,
    revision: number,
    options: WorkflowArtifactRequestOptions = {},
  ): Promise<WorkflowArtifactVersionSnapshot> {
    if (!Number.isInteger(revision) || revision < 1) {
      throw new WorkflowArtifactsError('revision must be a positive integer');
    }
    return this.request<WorkflowArtifactVersionSnapshot>(
      `/v1/capabilities/workflow-artifacts/${artifactId(id)}/versions/${revision}`,
      {},
      options,
    );
  }
}

export function createWorkflowArtifactsClient(options: WorkflowArtifactsClientOptions = {}): WorkflowArtifactsClient {
  return new WorkflowArtifactsClient(options);
}
