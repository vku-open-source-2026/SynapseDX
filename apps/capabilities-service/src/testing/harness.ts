// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Test harness: capabilities service against an in-memory Tier-1 fake. */
import { Server } from 'node:http';
import { createServer } from '../server';
import { ServiceConfig, loadConfig } from '../config';
import { resetLicenseCache } from '../licenses';
import { resetEmbeddingProviderCache } from '../rag';
import { FakeTier1, FakeTier1Options } from './fake-tier1';

export interface Harness {
  fake: FakeTier1;
  base: string;
  config: ServiceConfig;
  close(): Promise<void>;
}

export interface RequestOptions {
  method?: string;
  token?: string;
  apiKey?: string;
  body?: unknown;
  /** Raw request body; overrides `body` (used to test malformed JSON). */
  raw?: string;
  /** Binary request body; overrides `body` and `raw`. */
  buffer?: Uint8Array;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
}

export async function startHarness(
  overrides: Record<string, string | undefined> = {},
  fakeOptions: FakeTier1Options = {},
): Promise<Harness> {
  const fake = new FakeTier1({
    ...fakeOptions,
    tokens: {
      'user-token': { sub: 'user-1', account: 'acct-a', org: 'org-a', scopes: ['write'] },
      'read-token': { sub: 'reader', account: 'acct-a', org: 'org-a', scopes: ['read'] },
      'moderator-token': { sub: 'moderator-1', account: 'acct-a', org: 'org-a', scopes: ['synapsedx:moderator', 'read'] },
      'viewer-token': { sub: 'viewer-1', account: 'acct-a', org: 'org-a', scopes: ['datasets:list'] },
      // A plain organization member: Tier-1 user tokens carry `*` ("member
      // authority"), which must never be treated as DX administration.
      'member-token': { sub: 'member-1', email: 'member@example.com', account: 'acct-a', org: 'org-a', scopes: ['*'] },
      // A verified IAM organization administrator (GET /v1/auth/me reports it).
      'admin-token': { sub: 'admin-1', email: 'admin@example.com', account: 'acct-a', org: 'org-a', scopes: ['*'], is_org_admin: true },
      'other-token': { sub: 'user-b', account: 'acct-b', org: 'org-b', scopes: ['write'] },
      // A second organization's verified administrator (cross-tenant tests).
      'other-admin-token': { sub: 'admin-b', email: 'admin-b@example.com', org: 'org-b', scopes: ['*'], is_org_admin: true },
      // Service-to-user delegation for the same organization: it must resolve to
      // the same tenant as the user's own session (org-first, like Tier-1 Base).
      'delegated-token': { sub: 'user-1', account: 'acct-a', org: 'org-a', scopes: ['write'], kind: 'delegated' },
      // Machine delegation owned by a service account (product backend).
      'writer-delegated-token': { sub: 'user-1', account: 'acct-a', org: 'org-a', scopes: ['*'], kind: 'delegated' },
      // A narrowly-scoped machine credential with the explicit DX admin role.
      'dx-admin-token': { sub: 'dx-admin-1', org: 'org-a', scopes: ['synapsedx:admin'] },
    },
    apiKeys: {
      // Operator-minted, account-level machine credentials (user_id absent).
      'service-key': { account_id: 'service-account', scopes: ['*'] },
      'city-key': { account_id: 'acct-a', scopes: ['write'] },
      'sos-key': { account_id: 'acct-b', scopes: ['write'] },
      'read-key': { account_id: 'acct-a', scopes: ['read'] },
      'account-key': { account_id: 'acct-a', user_id: null, scopes: ['*'] },
      'exchange-key': { account_id: 'acct-a', user_id: null, scopes: ['auth:exchange'] },
      // Self-minted by an ordinary member (user_id set): member authority only,
      // even when the member asks for wildcard or an admin scope.
      'user-key': { account_id: 'acct-a', user_id: 'user-1', scopes: ['*'] },
      'user-admin-key': { account_id: 'acct-a', user_id: 'user-1', scopes: ['*', 'synapsedx:admin', 'write'] },
      // Per-organization technical workflow identities used by DX workflow
      // artifact tests. Account-level (no user_id), org-bound.
      'workflow-org-key': { account_id: 'dx-workflow-acct-a', org_id: 'org-a', scopes: ['*'] },
      'workflow-org-key-b': { account_id: 'dx-workflow-acct-b', org_id: 'org-b', scopes: ['*'] },
      'workflow-wrong-org-key': { account_id: 'dx-workflow-mismatch', org_id: 'org-b', scopes: ['*'] },
      'workflow-user-key': { account_id: 'dx-workflow-user', org_id: 'org-a', user_id: 'user-1', scopes: ['*'] },
    },
  });
  const baseUrl = await fake.start();
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    SYNAPSEONE_BASE_URL: baseUrl,
    ALLOW_LOCAL_DEPENDENCIES: 'true',
    SYNAPSEONE_API_KEY: 'service-key',
    SYNAPSEONE_TOKEN: undefined,
    SYNAPSEONE_TENANT: undefined,
    SYNAPSEDX_AUTH_MODE: 'required',
    SYNAPSEDX_AUDIT_ENABLED: 'true',
    SYNAPSEDX_IDEMPOTENCY_ENABLED: 'true',
    SYNAPSEDX_EVENTS_QUEUE: 'synapsedx-capability-events',
    SYNAPSEDX_EVENTS_STREAM: 'synapsedx-capability-events',
    SYNAPSEDX_WORKFLOW_API_KEYS: JSON.stringify({
      'org-a': 'workflow-org-key',
      'org-b': 'workflow-org-key-b',
      'org-wrong': 'workflow-wrong-org-key',
      'org-user': 'workflow-user-key',
    }),
    CORS_ORIGINS: 'https://synapsecity.sbs,https://sos.synapsecity.sbs',
    CORS_ORIGIN: undefined,
    SYNAPSEDX_GEOCODER_BASE_URL: undefined,
    SYNAPSEDX_GEOCODER_PROVIDER: undefined,
    SYNAPSEDX_GEOCODER_API_KEY: undefined,
    SYNAPSEDX_GEOCODER_AUTH_HEADER: undefined,
    SYNAPSEDX_GEOCODER_AUTH_QUERY: undefined,
    SYNAPSEDX_AUTH_ORG_SLUG: undefined,
    SYNAPSEDX_ADMIN_SUBJECTS: undefined,
    SYNAPSEDX_RESOLVE_ORG_ADMIN: undefined,
    SYNAPSEDX_TRUST_DELEGATED_TOKENS: undefined,
    SYNAPSEDX_AUTH_AUDIENCE: undefined,
    SYNAPSEDX_AUTH_ALLOWED_AUDIENCES: undefined,
    SYNAPSEDX_FILES_MAX_BYTES: undefined,
    SYNAPSEDX_FILES_QUOTA_BYTES: undefined,
    SYNAPSEDX_FILES_ALLOWED_TYPES: undefined,
    SYNAPSEDX_FILES_PRESIGN_TTL_SECONDS: undefined,
    SYNAPSEDX_FILES_PREFIX: undefined,
    SYNAPSEDX_OCR_ENGINE: undefined,
    SYNAPSEDX_OCR_LANGUAGES: undefined,
    SYNAPSEDX_TESSERACT_BIN: undefined,
    SYNAPSEDX_OCR_TIMEOUT_MS: undefined,
    SYNAPSEDX_OCR_MAX_BYTES: undefined,
    SYNAPSEDX_OCR_MAX_QUEUE: undefined,
    SYNAPSEDX_RAG_GENERATE: undefined,
    SYNAPSEDX_RAG_TIER1_EMBEDDINGS: undefined,
    SYNAPSEDX_RAG_LLM_TIMEOUT_MS: undefined,
    FAKE_TIER1_EMBEDDING_REAL: undefined,
    FAKE_TIER1_EMBEDDING_MOCK: undefined,
    FAKE_TIER1_CHAT_REPLY: undefined,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLicenseCache();
  resetEmbeddingProviderCache();
  const config = loadConfig();
  const server: Server = createServer(config).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    fake,
    config,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.stop();
    },
  };
}

export async function api(
  harness: Harness,
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(options.body === undefined && options.raw === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${harness.base}${path}`, {
    method: options.method || 'GET',
    headers,
    ...(options.redirect ? { redirect: options.redirect } : {}),
    ...(options.buffer !== undefined
      ? { body: options.buffer as unknown as BodyInit }
      : options.raw !== undefined
        ? { body: options.raw }
        : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, body, headers: response.headers };
}

/** Binary response helper for file downloads. */
export async function apiBinary(
  harness: Harness,
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const headers: Record<string, string> = {
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${harness.base}${path}`, { method: options.method || 'GET', headers });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}

export async function createDataset(
  harness: Harness,
  overrides: Record<string, unknown> = {},
  options: RequestOptions = { token: 'user-token' },
): Promise<any> {
  const response = await api(harness, '/v1/capabilities/datasets', {
    method: 'POST',
    ...options,
    body: {
      slug: 'city-incidents',
      name: 'City Incidents',
      entityType: 'Incident',
      license: 'CC-BY-4.0',
      public: true,
      ...overrides,
    },
  });
  return response;
}
