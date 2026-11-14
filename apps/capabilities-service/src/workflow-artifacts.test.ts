// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Contract + security tests for the Tier-2 workflow artifact capability.
 *
 * The DX backend worker owns server.ts registration, so this suite mounts the
 * new router on a minimal Express app with the same middleware chain as
 * createServer(). That keeps the test independent of server.ts while exercising
 * the real routes, auth, Base persistence and Tier-1 SDK calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Server } from 'node:http';
import { FakeTier1 } from './testing/fake-tier1';
import { loadConfig, ServiceConfig } from './config';
import {
  correlationMiddleware, corsMiddleware, errorMiddleware, notFoundMiddleware, securityMiddleware,
} from './http';
import {
  __setWorkflowSdkVersionForTests,
  executeWorkflowArtifactForPlugin,
  getWorkflowArtifactExecutionReadiness,
  getWorkflowArtifactOrgReadiness,
  isWorkflowRevisionPinVersionSupported,
  registerWorkflowArtifactRoutes,
} from './routes/workflow-artifacts';
import { Caller } from './auth';
import { resetLicenseCache } from './licenses';
import { resetEmbeddingProviderCache } from './rag';

const SECRET = 'super-secret-value-123456';
const ARTIFACT_COLLECTION = 'synapsedx_capability_workflow_artifacts';
const VERSION_COLLECTION = 'synapsedx_capability_workflow_artifact_versions';

interface WorkflowHarness {
  fake: FakeTier1;
  config: ServiceConfig;
  base: string;
  tier1Base: string;
  close(): Promise<void>;
}

interface CallOptions {
  method?: string;
  token?: string;
  apiKey?: string;
  body?: unknown;
  raw?: string;
}

async function startWorkflowHarness(): Promise<WorkflowHarness> {
  // Test-only shim for the published SDK method that is present in the next
  // SDK release; production code feature-detects and fails closed when absent.
  const sdkWorkflow = require('@synapseone/sdk/workflow');
  const WorkflowService = sdkWorkflow?.WorkflowService;
  if (WorkflowService && typeof WorkflowService.prototype.getWorkflowRunnerOptions !== 'function') {
    WorkflowService.prototype.getWorkflowRunnerOptions = function getWorkflowRunnerOptions() {
      return this.http.req('/v1/workflow-runners/options');
    };
  }
  const fake = new FakeTier1({
    tokens: {
      'user-token': { sub: 'user-1', account: 'acct-a', org: 'org-a', scopes: ['write'] },
      'peer-token': { sub: 'peer-1', account: 'acct-a', org: 'org-a', scopes: ['write'] },
      'read-token': { sub: 'reader', account: 'acct-a', scopes: ['read'] },
      'admin-token': { sub: 'admin-1', account: 'acct-a', org: 'org-a', scopes: ['*'] },
      'other-token': { sub: 'user-b', account: 'acct-b', org: 'org-b', scopes: ['write'] },
    },
    apiKeys: {
      'service-key': { account_id: 'service-account', scopes: ['*'] },
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
    SYNAPSEDX_GEOCODER_BASE_URL: undefined,
    SYNAPSEDX_TURNSTILE_SECRET_KEY: undefined,
    SYNAPSEDX_WORKFLOW_API_KEYS: JSON.stringify({
      'org-a': 'workflow-org-key',
      'org-b': 'workflow-org-key-b',
      'org-wrong': 'workflow-wrong-org-key',
      'org-user': 'workflow-user-key',
    }),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLicenseCache();
  resetEmbeddingProviderCache();
  const config = loadConfig();
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware(config));
  app.use(securityMiddleware());
  app.use(correlationMiddleware());
  app.use(express.json({ limit: '2mb' }));
  registerWorkflowArtifactRoutes(app, config);
  app.use(notFoundMiddleware());
  app.use(errorMiddleware());

  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    fake,
    config,
    base: `http://127.0.0.1:${port}`,
    tier1Base: baseUrl,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.stop();
    },
  };
}

async function call(
  harness: WorkflowHarness,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: any; headers: Headers; text: string }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(options.body === undefined && options.raw === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
  };
  const response = await fetch(`${harness.base}${path}`, {
    method: options.method || 'GET',
    headers,
    ...(options.raw !== undefined
      ? { body: options.raw }
      : options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: response.status, body, headers: response.headers, text };
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    nodes: [
      {
        id: 'n1',
        name: 'Manual trigger',
        type: 'n8n-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'n2',
        name: 'Notify city API',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 1,
        position: [240, 0],
        parameters: {
          method: 'POST',
          url: 'https://api.example.com/hook',
          apiKey: SECRET,
          headerParameters: {
            parameters: [
              { name: 'Authorization', value: `Bearer ${SECRET}` },
              { name: 'X-Trace', value: 'trace-1' },
            ],
          },
          nested: { clientSecret: SECRET, password: SECRET },
          note: `token = "${SECRET}"`,
          credentials: { httpHeaderAuth: { id: 'cred-1', name: 'prod-http' } },
        },
      },
    ],
    connections: {
      'Manual trigger': { main: [[{ node: 'Notify city API', type: 'main', index: 0 }]] },
    },
    settings: { timezone: 'Asia/Ho_Chi_Minh', executionOrder: 'v1' },
    ...overrides,
  };
}

function storedArtifact(harness: WorkflowHarness, id: string): any {
  return harness.fake.collections.get(ARTIFACT_COLLECTION)?.get(id)?.data;
}

async function importArtifact(
  harness: WorkflowHarness,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: any; text: string }> {
  return call(harness, '/v1/capabilities/workflow-artifacts/import', {
    method: 'POST',
    token: 'user-token',
    body: {
      name: 'City dispatch workflow',
      description: 'Imported from the City repository bundle',
      definition: definition(),
      source: {
        repository: 'https://github.com/vku-open-source-2026/SynapseCity',
        path: 'plugins/city-dispatch.workflow.json',
        revision: 'abc1234',
      },
      ...overrides,
    },
  });
}

test('revision-pin SDK gate is strict about published versions', () => {
  assert.equal(isWorkflowRevisionPinVersionSupported('0.9.0'), false);
  assert.equal(isWorkflowRevisionPinVersionSupported('0.9.1'), true);
  assert.equal(isWorkflowRevisionPinVersionSupported('0.10.0'), true);
  assert.equal(isWorkflowRevisionPinVersionSupported('1.0.0'), true);
  assert.equal(isWorkflowRevisionPinVersionSupported('0.9.1-beta.1'), false);
  assert.equal(isWorkflowRevisionPinVersionSupported('0.9.0+local'), false);
  assert.equal(isWorkflowRevisionPinVersionSupported('0.8.99'), false);
  assert.equal(isWorkflowRevisionPinVersionSupported('unknown'), false);
  assert.equal(isWorkflowRevisionPinVersionSupported(null), false);
  const readiness = getWorkflowArtifactExecutionReadiness();
  assert.equal(readiness.ready, isWorkflowRevisionPinVersionSupported(readiness.installedVersion));
  assert.equal(readiness.canSubmit, readiness.ready);
});

test('workflow artifact import is authenticated, tenant scoped and scrubs credentials', async () => {
  const harness = await startWorkflowHarness();
  try {
    const anonymous = await call(harness, '/v1/capabilities/workflow-artifacts');
    assert.equal(anonymous.status, 401);
    const anonymousImport = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      body: { name: 'x', definition: definition() },
    });
    assert.equal(anonymousImport.status, 401);

    const readOnly = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'read-token',
      body: { name: 'x', definition: definition() },
    });
    assert.equal(readOnly.status, 403);
    assert.equal(readOnly.body.error.code, 'insufficient_scope');

    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const artifact = created.body;
    assert.equal(artifact.tenant, 'org-a');
    assert.equal(artifact.createdBy, 'user-1');
    assert.equal(artifact.revision, 1);
    assert.ok(artifact.version >= 1);
    assert.equal(artifact.format, 'synapsedx-workflow-artifact');
    assert.equal(artifact.formatVersion, 1);
    assert.ok(artifact.workflowId);
    assert.equal(artifact.managedBy, 'technical');
    assert.equal(artifact.protected, true);
    assert.equal(artifact.accessMode, 'owner-only');
    assert.equal(artifact.source.kind, 'definition');
    assert.equal(artifact.source.repository, 'https://github.com/vku-open-source-2026/SynapseCity');
    assert.equal(artifact.source.path, 'plugins/city-dispatch.workflow.json');
    assert.ok(Array.isArray(artifact.credentialRedactions));
    assert.ok(artifact.credentialRedactions.length >= 4);
    assert.ok(artifact.credentialRedactions.some((path: string) => path.includes('apiKey')));
    assert.ok(artifact.credentialRedactions.some((path: string) => path.includes('clientSecret')));
    assert.ok(artifact.credentialRedactions.some((path: string) => path.includes('password')));
    assert.ok(artifact.credentialRedactions.some((path: string) => path.includes('headerParameters')));

    // Tier-1 received a scrubbed definition, not the plaintext credential.
    const createRequest = harness.fake.requests.find((request) => (
      request.method === 'POST' && request.path === '/v1/workflows'
    ));
    assert.ok(createRequest, 'Tier-1 createWorkflow was called');
    assert.equal(createRequest!.headers['x-api-key'], 'workflow-org-key');
    assert.equal(createRequest!.headers.authorization, undefined);
    assert.equal((createRequest!.body as any).settings.access.mode, 'owner-only');
    assert.equal(JSON.stringify(createRequest!.body).includes(SECRET), false);
    assert.equal(JSON.stringify(createRequest!.body).includes('[REDACTED]'), true);
    // Credential references stay references (id/name) and are not values.
    assert.deepEqual(createRequest!.body.definition.nodes[1].parameters.credentials, {
      httpHeaderAuth: { id: 'cred-1', name: 'prod-http' },
    });

    // Base persistence is scrubbed too.
    const stored = storedArtifact(harness, artifact.id);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes(SECRET), false);
    const persistedDefinition = harness.fake.workflows.get(artifact.workflowId)!.definition;
    assert.equal(JSON.stringify(persistedDefinition).includes(SECRET), false);

    // List returns a summary without the graph.
    const list = await call(harness, '/v1/capabilities/workflow-artifacts', { token: 'user-token' });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].id, artifact.id);
    assert.equal(list.body.items[0].nodeCount, 2);
    assert.equal(list.body.items[0].nodes, undefined);
    assert.equal(list.body.items[0].tenant, 'org-a');

    const fetched = await call(harness, `/v1/capabilities/workflow-artifacts/${artifact.id}`, { token: 'user-token' });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.version, artifact.version);
    assert.equal(fetched.body.nodes.length, 2);

    const versions = await call(harness, `/v1/capabilities/workflow-artifacts/${artifact.id}/versions`, { token: 'user-token' });
    assert.equal(versions.status, 200);
    assert.equal(versions.body.total, 1);
    assert.equal(versions.body.items[0].revision, 1);

    const version = await call(harness, `/v1/capabilities/workflow-artifacts/${artifact.id}/versions/1`, { token: 'user-token' });
    assert.equal(version.status, 200);
    assert.equal(version.body.revision, 1);
    assert.equal(JSON.stringify(version.body).includes(SECRET), false);
  } finally {
    await harness.close();
  }
});

test('workflow export is faithful, scrubbed and free of tenant/server metadata', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const artifact = created.body;

    const exported = await call(
      harness,
      `/v1/capabilities/workflow-artifacts/${artifact.id}/export?download=1`,
      { token: 'user-token' },
    );
    assert.equal(exported.status, 200, exported.text);
    assert.equal(exported.body.format, 'synapsedx-workflow-artifact');
    assert.equal(exported.body.formatVersion, 1);
    assert.equal(exported.body.workflow.nodes.length, 2);
    assert.equal(exported.body.workflow.nodes[0].type, 'n8n-nodes-base.manualTrigger');
    assert.equal(exported.body.workflow.nodes[1].type, 'n8n-nodes-base.httpRequest');
    assert.deepEqual(exported.body.workflow.connections, definition().connections);
    assert.deepEqual(exported.body.workflow.settings, {
      ...definition().settings,
      access: { mode: 'owner-only' },
    });
    assert.equal(exported.body.synchronised, true);
    assert.equal(exported.body.checksum, artifact.checksum);
    assert.equal(exported.body.credentialRedactions.length >= 4, true);

    const serialized = JSON.stringify(exported.body);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes('org-a'), false);
    assert.equal(serialized.includes('user-1'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(exported.body, 'tenant'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(exported.body, 'createdBy'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(exported.body, 'workflowId'), false);
    assert.match(String(exported.headers.get('content-disposition')), /attachment/);

    // The export reflects the live Tier-1 graph, even when the saved snapshot
    // is stale; the checksum makes the drift visible.
    const live = harness.fake.workflows.get(artifact.workflowId)!;
    live.definition = {
      nodes: [
        ...(live.definition.nodes as any[]),
        {
          id: 'n3',
          name: 'Rotate report',
          type: 'n8n-nodes-base.code',
          typeVersion: 1,
          position: [480, 0],
          parameters: { code: 'return { ok: true, secret: "live-secret-value-987654" };' },
        },
      ],
      connections: live.definition.connections,
    };
    const changed = await call(
      harness,
      `/v1/capabilities/workflow-artifacts/${artifact.id}/export`,
      { token: 'user-token' },
    );
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.workflow.nodes.length, 3);
    assert.equal(changed.body.synchronised, false);
    assert.notEqual(changed.body.checksum, artifact.checksum);
    assert.equal(JSON.stringify(changed.body).includes('live-secret-value-987654'), false);
    assert.ok(changed.body.credentialRedactions.some((path: string) => path.includes('Rotate report')));
  } finally {
    await harness.close();
  }
});

test('workflow artifacts enforce tenant isolation and owner-only mutation', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;

    // Same-tenant peer can read, but not update/execute another owner's artifact.
    const peerList = await call(harness, '/v1/capabilities/workflow-artifacts', { token: 'peer-token' });
    assert.equal(peerList.status, 200);
    assert.equal(peerList.body.total, 1);
    const peerGet = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, { token: 'peer-token' });
    assert.equal(peerGet.status, 200);
    const peerPut = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      token: 'peer-token',
      body: { version: 1, name: 'Peer edit' },
    });
    assert.equal(peerPut.status, 403);
    const peerRun = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/execute`, {
      method: 'POST',
      token: 'peer-token',
      body: {},
    });
    assert.equal(peerRun.status, 403);

    // Cross-tenant callers see nothing and get 404 on direct access.
    const otherList = await call(harness, '/v1/capabilities/workflow-artifacts', { token: 'other-token' });
    assert.equal(otherList.status, 200);
    assert.equal(otherList.body.total, 0);
    for (const [path, options] of [
      [`/v1/capabilities/workflow-artifacts/${id}`, { token: 'other-token' }],
      [`/v1/capabilities/workflow-artifacts/${id}/export`, { token: 'other-token' }],
      [`/v1/capabilities/workflow-artifacts/${id}/versions`, { token: 'other-token' }],
      [`/v1/capabilities/workflow-artifacts/${id}`, { method: 'PUT', token: 'other-token', body: { version: 1, name: 'nope' } }],
      [`/v1/capabilities/workflow-artifacts/${id}/execute`, { method: 'POST', token: 'other-token', body: {} }],
    ] as Array<[string, CallOptions]>) {
      const response = await call(harness, path, options);
      assert.equal(response.status, 404, `${path} must hide cross-tenant artifacts`);
    }

    // A DX admin may manage any tenant's artifact.
    const adminList = await call(harness, '/v1/capabilities/workflow-artifacts', { apiKey: 'service-key' });
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.total, 1);
    const adminPut = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      apiKey: 'service-key',
      body: { version: created.body.version, name: 'Admin rename' },
    });
    assert.equal(adminPut.status, 200, adminPut.text);
    assert.equal(adminPut.body.name, 'Admin rename');
  } finally {
    await harness.close();
  }
});

test('owner-only Tier-1 policy denies a same-org volunteer outside the DX helper', async () => {
  const harness = await startWorkflowHarness();
  try {
    // Mirror Tier-1 owner-only enforcement on protected workflows.
    harness.fake.enforceWorkflowOwnerOnly = true;
    harness.fake.enforceWorkflowTenant = true;
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;
    const workflowId = created.body.workflowId;
    assert.equal(harness.fake.workflows.get(workflowId)!.ownerSub, 'apikey:dx-workflow-acct-a');

    // DX owner guard and Tier-1 owner-only both deny the same-org volunteer.
    const dxExecute = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/execute`, {
      method: 'POST',
      token: 'peer-token',
      body: {},
    });
    assert.equal(dxExecute.status, 403);
    const direct = await fetch(`${harness.tier1Base}/v1/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: { authorization: 'Bearer peer-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(direct.status, 404, 'volunteer JWT must not run the technical-owned workflow directly');

    // The technical organization key is the only direct owner.
    const technical = await fetch(`${harness.tier1Base}/v1/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: { 'x-api-key': 'workflow-org-key', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(technical.status, 200);
    assert.ok((await technical.json() as any).executionId);

    // A different organization is hidden as well.
    const foreign = await fetch(`${harness.tier1Base}/v1/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: { authorization: 'Bearer other-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(foreign.status, 404);
  } finally {
    await harness.close();
  }
});

test('organization technical identity fail-closed checks reject mismatch and user-bound keys', async () => {
  const harness = await startWorkflowHarness();
  try {
    const good = await getWorkflowArtifactOrgReadiness(harness.config, 'org-a');
    assert.equal(good.ready, true);
    assert.equal(good.accountId, 'dx-workflow-acct-a');

    const mismatch = await getWorkflowArtifactOrgReadiness(harness.config, 'org-wrong');
    assert.equal(mismatch.ready, false);
    assert.equal(mismatch.reason, 'workflow_technical_identity_org_mismatch');

    const userBound = await getWorkflowArtifactOrgReadiness(harness.config, 'org-user');
    assert.equal(userBound.ready, false);
    assert.equal(userBound.reason, 'workflow_technical_identity_user_bound');

    const missing = await getWorkflowArtifactOrgReadiness(harness.config, 'org-missing');
    assert.equal(missing.ready, false);
    assert.equal(missing.reason, 'workflow_technical_identity_missing');
  } finally {
    await harness.close();
  }
});

test('workflow update is versioned and each revision is stored', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;
    const liveBefore = JSON.stringify(harness.fake.workflows.get(created.body.workflowId)!.definition);

    const conflict = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      token: 'user-token',
      body: { version: 99, name: 'Stale edit' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'version_conflict');
    // The stale update never reached Tier-1.
    assert.equal(JSON.stringify(harness.fake.workflows.get(created.body.workflowId)!.definition), liveBefore);
    assert.equal(harness.fake.workflows.get(created.body.workflowId)!.name, 'City dispatch workflow');

    const nextDefinition = definition({
      nodes: [
        ...(definition().nodes as any[]),
        {
          id: 'n3',
          name: 'Review',
          type: 'n8n-nodes-base.set',
          typeVersion: 1,
          position: [480, 0],
          parameters: { assignments: { assignments: [{ name: 'status', value: 'ok' }] }, apiToken: SECRET },
        },
      ],
    });
    const updated = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      token: 'user-token',
      body: { version: created.body.version, definition: nextDefinition, description: 'Second revision' },
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.revision, 2);
    assert.ok(updated.body.version > created.body.version);
    assert.equal(updated.body.versionHistoryStatus, 'complete');
    assert.equal(updated.body.versionCount, 2);
    assert.equal(updated.body.nodes.length, 3);
    assert.equal(updated.body.description, 'Second revision');
    assert.equal(JSON.stringify(updated.body).includes(SECRET), false);

    const tier1 = harness.fake.workflows.get(created.body.workflowId)!;
    assert.equal((tier1.definition.nodes as any[]).length, 3);
    assert.equal(JSON.stringify(tier1.definition).includes(SECRET), false);

    const versions = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/versions`, { token: 'user-token' });
    assert.equal(versions.status, 200);
    assert.equal(versions.body.total, 2);
    assert.deepEqual(versions.body.items.map((item: any) => item.revision), [2, 1]);
    const first = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/versions/1`, { token: 'user-token' });
    assert.equal(first.status, 200);
    assert.equal(first.body.nodes.length, 2);
    assert.equal(JSON.stringify(first.body).includes(SECRET), false);

    const settingsOnly = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      token: 'user-token',
      body: { version: updated.body.version, settings: { timezone: 'UTC' } },
    });
    assert.equal(settingsOnly.status, 200, settingsOnly.text);
    assert.equal(settingsOnly.body.revision, 3);
    assert.equal(settingsOnly.body.settings.timezone, 'UTC');

    // External drift blocks a normal update before any Tier-1 write and is
    // recoverable through the explicit reconcile endpoint.
    const live = harness.fake.workflows.get(created.body.workflowId)!;
    live.definition = {
      nodes: [
        ...(live.definition.nodes as any[]),
        { name: 'Outside DX', type: 'n8n-nodes-base.set', typeVersion: 1, parameters: {} },
      ],
      connections: live.definition.connections,
      settings: live.definition.settings,
    };
    const drifted = JSON.stringify(live.definition);
    const driftRejected = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      token: 'user-token',
      body: { version: settingsOnly.body.version, name: 'Should not apply' },
    });
    assert.equal(driftRejected.status, 409);
    assert.equal(driftRejected.body.error.code, 'artifact_out_of_sync');
    assert.equal(JSON.stringify(harness.fake.workflows.get(created.body.workflowId)!.definition), drifted);

    const reconciled = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/reconcile`, {
      method: 'POST',
      token: 'user-token',
      body: { version: settingsOnly.body.version },
    });
    assert.equal(reconciled.status, 200, reconciled.text);
    assert.equal(reconciled.body.revision, 4);
    assert.equal(reconciled.body.nodes.length, 4);
    assert.equal(reconciled.body.syncState, 'ready');
  } finally {
    await harness.close();
  }
});

test('workflow execution delegates exclusively to the Tier-1 SDK', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;
    const workflowId = created.body.workflowId;

    const run = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/execute`, {
      method: 'POST',
      token: 'user-token',
      body: { payload: { incidentId: 'INC-42', dryRun: true } },
    });
    assert.equal(run.status, 200, run.text);
    assert.equal(run.body.artifactId, id);
    assert.equal(run.body.workflowId, workflowId);
    assert.ok(run.body.execution.executionId);
    assert.equal(harness.fake.executions.length, 1);
    assert.equal(harness.fake.executions[0].workflowId, workflowId);

    const executeRequests = harness.fake.requests.filter((request) => (
      request.method === 'POST' && request.path === `/v1/workflows/${workflowId}/execute`
    ));
    assert.equal(executeRequests.length, 1);
    assert.deepEqual(executeRequests[0].body, { incidentId: 'INC-42', dryRun: true });

    const fetched = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, { token: 'user-token' });
    assert.equal(fetched.status, 200);
    assert.ok(fetched.body.lastExecutedAt);
    assert.equal(fetched.body.lastExecutionId, run.body.execution.executionId);
  } finally {
    await harness.close();
  }
});

test('workflow import rejects malformed, unsafe and oversized definitions', async () => {
  const harness = await startWorkflowHarness();
  try {
    const missingNodes = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Bad', definition: { connections: {} } },
    });
    assert.equal(missingNodes.status, 400);
    assert.equal(missingNodes.body.error.code, 'invalid_document');

    const duplicateNames = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Bad',
        definition: {
          nodes: [
            { name: 'Same', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
            { name: 'Same', type: 'n8n-nodes-base.set', parameters: {} },
          ],
          connections: {},
        },
      },
    });
    assert.equal(duplicateNames.status, 400);
    assert.match(duplicateNames.body.error.message, /duplicate node name/);

    const blocked = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Internal probe',
        definition: {
          nodes: [{
            name: 'Fetch internal', type: 'n8n-nodes-base.httpRequest',
            parameters: { url: 'http://127.0.0.1:4002/v1/workflows' }, credentials: {},
          }],
          connections: {},
        },
      },
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, 'blocked_url');

    const commandNode = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Shell',
        definition: {
          nodes: [{ name: 'Shell', type: 'n8n-nodes-base.executeCommand', parameters: {} }],
          connections: {},
        },
      },
    });
    assert.equal(commandNode.status, 400);
    assert.match(commandNode.body.error.message, /local-execution/);

    const tooMany = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Too many',
        definition: {
          nodes: Array.from({ length: 51 }, (_, index) => ({
            name: `Node ${index}`, type: 'n8n-nodes-base.set', parameters: {},
          })),
          connections: {},
        },
      },
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error.message, /1\.\.50/);

    const polluted = JSON.parse('{"__proto__":{"polluted":true},"value":1}');
    const prototype = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Prototype',
        definition: {
          nodes: [{ name: 'Polluted', type: 'n8n-nodes-base.set', parameters: polluted }],
          connections: {},
        },
      },
    });
    assert.equal(prototype.status, 400);
    assert.match(prototype.body.error.message, /reserved key/);

    const unsupportedAccess = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Shared access',
        definition: {
          nodes: [{ name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
          connections: {},
          settings: { access: { mode: 'shared' } },
        },
      },
    });
    assert.equal(unsupportedAccess.status, 409);
    assert.equal(unsupportedAccess.body.error.code, 'unsupported_access_mode');
    assert.equal(harness.fake.workflows.size, 0);

    const wrongFormat = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: { format: 'other-format', formatVersion: 1, workflow: definition() },
    });
    assert.equal(wrongFormat.status, 400);
    assert.match(wrongFormat.body.error.message, /formatVersion/);

    // Invalid imports never create a Tier-1 workflow.
    assert.equal(harness.fake.workflows.size, 0);
  } finally {
    await harness.close();
  }
});

test('imported code is stored as data and never executed by Tier 2', async () => {
  const harness = await startWorkflowHarness();
  try {
    const marker = '__synapsedxWorkflowCodeExecuted';
    delete (globalThis as any)[marker];
    const created = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Code node artifact',
        definition: {
          nodes: [
            {
              name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {},
            },
            {
              name: 'Code',
              type: 'n8n-nodes-base.code',
              typeVersion: 1,
              parameters: { code: `globalThis.${marker} = true; return { ok: true };` },
            },
          ],
          connections: { Manual: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
        },
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal((globalThis as any)[marker], undefined);
    assert.equal(harness.fake.executions.length, 0);

    const stored = harness.fake.workflows.get(created.body.workflowId)!;
    const code = (stored.definition.nodes as any[])[1].parameters.code;
    assert.match(String(code), /globalThis\.__synapsedxWorkflowCodeExecuted/);
  } finally {
    delete (globalThis as any).__synapsedxWorkflowCodeExecuted;
    await harness.close();
  }
});

test('plugin delegation lets a same-tenant member execute without granting artifact ownership', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;

    const peer: Caller = {
      authenticated: true,
      credential: { kind: 'bearer', value: 'peer-token' },
      principal: { type: 'jwt', subject: 'peer-1', tenantKey: 'org-a', scopes: ['write'] },
    };
    // The installed published SDK is still 0.9.0: plugin execution must fail
    // closed with a clear release requirement, never use the third argument
    // silently as an advisory flag.
    const readinessResponse = await call(harness, '/v1/capabilities/workflow-artifacts/readiness', { token: 'user-token' });
    assert.equal(readinessResponse.status, 200);
    assert.equal(readinessResponse.body.pluginFormsCanSubmit, false);
    assert.equal(readinessResponse.body.workflowExecution.ready, false);
    assert.equal(readinessResponse.body.workflowExecution.minimumVersion, '0.9.1');

    const readiness = getWorkflowArtifactExecutionReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.canSubmit, false);
    assert.equal(readiness.installedVersion, '0.9.0');
    assert.equal(readiness.minimumVersion, '0.9.1');
    await assert.rejects(
      () => executeWorkflowArtifactForPlugin(
        harness.config,
        peer,
        id,
        { incidentId: 'INC-7' },
        {
          pluginId: 'city-volunteer-console',
          widgetId: 'dispatch-form',
          tenant: 'org-a',
          roles: ['volunteer'],
          expectedChecksum: created.body.checksum,
          expectedRevision: 1,
          correlationId: 'corr-plugin-1',
        },
      ),
      (error: any) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'dependency_unavailable');
        assert.equal(error.details.sdkReleaseRequired, true);
        assert.equal(error.details.canSubmit, false);
        assert.match(error.message, /@synapseone\/sdk >=0\.9\.1/);
        return true;
      },
    );
    assert.equal(harness.fake.executions.length, 0);
    const executedAudits = [...(harness.fake.collections.get('synapsedx_capability_audit')?.values() || [])]
      .map((doc) => doc.data)
      .filter((entry: any) => entry.action === 'workflow_artifact.execute');
    assert.equal(executedAudits.length, 0);

    // No roles / wrong tenant / cross-tenant caller are all refused.
    await assert.rejects(
      () => executeWorkflowArtifactForPlugin(
        harness.config, peer, id, {},
        { pluginId: 'city-volunteer-console', tenant: 'org-a', roles: [], expectedChecksum: created.body.checksum },
      ),
      /plugin delegation requires/,
    );
    await assert.rejects(
      () => executeWorkflowArtifactForPlugin(
        harness.config, peer, id, {},
        { pluginId: 'city-volunteer-console', tenant: 'org-b', roles: ['volunteer'], expectedChecksum: created.body.checksum },
      ),
      /workflow artifact not found/,
    );
    const other: Caller = {
      authenticated: true,
      credential: { kind: 'bearer', value: 'other-token' },
      principal: { type: 'jwt', subject: 'user-b', tenantKey: 'org-b', scopes: ['write'] },
    };
    await assert.rejects(
      () => executeWorkflowArtifactForPlugin(
        harness.config, other, id, {},
        { pluginId: 'city-volunteer-console', tenant: 'org-a', roles: ['volunteer'], expectedChecksum: created.body.checksum },
      ),
      /workflow artifact not found/,
    );

    // A stale published binding checksum is rejected even if the artifact is
    // otherwise healthy.
    await assert.rejects(
      () => executeWorkflowArtifactForPlugin(
        harness.config, peer, id, {},
        {
          pluginId: 'city-volunteer-console', tenant: 'org-a', roles: ['volunteer'],
          expectedChecksum: '0'.repeat(64), expectedRevision: 1,
        },
      ),
      (error: any) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'artifact_out_of_sync');
        return true;
      },
    );

    // External Tier-1 drift (edited outside DX) is rejected even when the
    // published checksum matches the saved artifact.
    const live = harness.fake.workflows.get(created.body.workflowId)!;
    live.definition = {
      nodes: [
        ...(live.definition.nodes as any[]),
        {
          name: 'Unreviewed drift',
          type: 'n8n-nodes-base.code',
          typeVersion: 1,
          parameters: { code: 'return { unreviewed: true };' },
        },
      ],
      connections: live.definition.connections,
      settings: live.definition.settings,
    };
    await assert.rejects(
      () => executeWorkflowArtifactForPlugin(
        harness.config, peer, id, {},
        {
          pluginId: 'city-volunteer-console', tenant: 'org-a', roles: ['volunteer'],
          expectedChecksum: created.body.checksum, expectedRevision: 1,
        },
      ),
      (error: any) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'artifact_out_of_sync');
        assert.ok(error.details.liveChecksum);
        return true;
      },
    );

    // A member still cannot use the direct management execute endpoint.
    const direct = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/execute`, {
      method: 'POST',
      token: 'peer-token',
      body: {},
    });
    assert.equal(direct.status, 403);
  } finally {
    await harness.close();
  }
});

test('volunteer execution delegates through the organization technical owner only', async () => {
  const harness = await startWorkflowHarness();
  try {
    harness.fake.enforceWorkflowOwnerOnly = true;
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;

    // Simulate the published SDK release only for this test; the installed
    // 0.9.0 still ignores expectedRevision, so this asserts delegation/auth,
    // not the wire-level revision precondition.
    __setWorkflowSdkVersionForTests('0.9.1');
    const peer: Caller = {
      authenticated: true,
      credential: { kind: 'bearer', value: 'peer-token' },
      principal: { type: 'jwt', subject: 'peer-1', tenantKey: 'org-a', scopes: ['write'] },
    };
    const result = await executeWorkflowArtifactForPlugin(
      harness.config,
      peer,
      id,
      { incidentId: 'INC-9' },
      {
        pluginId: 'city-volunteer-console',
        widgetId: 'dispatch-form',
        tenant: 'org-a',
        roles: ['volunteer'],
        expectedChecksum: created.body.checksum,
        expectedRevision: 1,
      },
    );
    assert.equal(result.revisionPinned, true);
    assert.ok((result.execution as any).executionId);

    const executeRequest = harness.fake.requests.filter((request) => (
      request.method === 'POST' && request.path === `/v1/workflows/${created.body.workflowId}/execute`
    )).pop();
    assert.ok(executeRequest);
    assert.equal(executeRequest!.headers['x-api-key'], 'workflow-org-key');
    assert.equal(executeRequest!.headers.authorization, undefined);

    // Direct Tier-1 access as the volunteer is still denied by owner-only.
    const direct = await fetch(`${harness.tier1Base}/v1/workflows/${created.body.workflowId}/execute`, {
      method: 'POST',
      headers: { authorization: 'Bearer peer-token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(direct.status, 404);
  } finally {
    __setWorkflowSdkVersionForTests('0.9.0');
    await harness.close();
  }
});

test('failed Tier-1 rollback keeps the artifact blocked instead of clearing to ready', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await importArtifact(harness);
    assert.equal(created.status, 201, created.text);
    const id = created.body.id;
    const liveBefore = JSON.stringify(harness.fake.workflows.get(created.body.workflowId)!.definition);

    harness.fake.failWorkflowUpdate = true;
    const failed = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, {
      method: 'PUT',
      token: 'user-token',
      body: {
        version: created.body.version,
        definition: {
          nodes: [{ name: 'Broken change', type: 'n8n-nodes-base.set', parameters: {} }],
          connections: {},
        },
      },
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'artifact_compensation_failed');
    assert.equal(failed.body.error.details.tier1Rollback, false);

    // Tier-1 did not change and the artifact stays failed, never "ready".
    assert.equal(JSON.stringify(harness.fake.workflows.get(created.body.workflowId)!.definition), liveBefore);
    const blocked = await call(harness, `/v1/capabilities/workflow-artifacts/${id}`, { token: 'user-token' });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.syncState, 'failed');
    assert.match(blocked.body.syncError, /rollback failed/);
    assert.equal(blocked.body.nodes[1].parameters.apiKey, '[REDACTED]');

    const executeBlocked = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/execute`, {
      method: 'POST',
      token: 'user-token',
      body: {},
    });
    assert.equal(executeBlocked.status, 409);
    assert.equal(executeBlocked.body.error.code, 'illegal_transition');

    // Explicit reconciliation is the only way out.
    harness.fake.failWorkflowUpdate = false;
    const reconciled = await call(harness, `/v1/capabilities/workflow-artifacts/${id}/reconcile`, {
      method: 'POST',
      token: 'user-token',
      body: { version: blocked.body.version },
    });
    assert.equal(reconciled.status, 200, reconciled.text);
    assert.equal(reconciled.body.syncState, 'ready');
  } finally {
    await harness.close();
  }
});

function credentialDefinition(ref = 'synapsedx-organization', header = 'X-API-Key') {
  return {
    nodes: [
      { name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
      {
        name: 'Persist incident',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 1,
        parameters: {
          method: 'POST',
          url: 'https://synapsedx.sbs/v1/capabilities/datasets/city-incidents/records',
          auth: { credentialRef: ref, header },
        },
      },
    ],
    connections: { Manual: { main: [[{ node: 'Persist incident', type: 'main', index: 0 }]] } },
    settings: {},
  };
}

test('credentialRef binds the org technical key without leaking secrets or local ids', async () => {
  const harness = await startWorkflowHarness();
  try {
    const created = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Ref workflow', definition: credentialDefinition() },
    });
    assert.equal(created.status, 201, created.text);
    const artifact = created.body;
    const credential = [...harness.fake.credentials.values()][0];
    assert.ok(credential);
    assert.equal(credential.name, 'synapsedx-organization');
    assert.equal(credential.account_id, 'dx-workflow-acct-a');
    assert.equal(credential.kind, 'api-key');
    assert.equal(credential.secret, 'workflow-org-key');
    assert.equal(credential.owner_sub, 'apikey:dx-workflow-acct-a');

    const deployedAuth = (artifact.nodes[1].parameters as any).auth;
    assert.equal(deployedAuth.credentialId, credential.id);
    assert.equal(deployedAuth.credentialRef, undefined);
    assert.deepEqual(deployedAuth.allowedOrigins, ['https://synapsedx.sbs']);
    assert.equal(artifact.credentialBindingCount, 1);
    assert.equal(artifact.credentialBindings, undefined);
    assert.notEqual(artifact.checksum, artifact.portableChecksum);

    const stored = JSON.stringify(storedArtifact(harness, artifact.id));
    assert.equal(stored.includes('workflow-org-key'), false);
    assert.equal(stored.includes('credentialRef'), false);
    assert.equal(stored.includes(credential.id), true, 'deployed id is stored internally');

    const exported = await call(
      harness,
      `/v1/capabilities/workflow-artifacts/${artifact.id}/export`,
      { token: 'user-token' },
    );
    assert.equal(exported.status, 200, exported.text);
    const exportedAuth = (exported.body.workflow.nodes[1].parameters as any).auth;
    assert.deepEqual(exportedAuth, { credentialRef: 'synapsedx-organization', header: 'X-API-Key' });
    assert.equal((exportedAuth as any).allowedOrigins, undefined);
    assert.equal(exported.body.checksum, artifact.portableChecksum);
    assert.equal(exported.body.deployedChecksum, artifact.checksum);
    assert.equal(exported.body.credentialBindingCount, 1);
    const serialized = JSON.stringify(exported.body);
    assert.equal(serialized.includes(credential.id), false);
    assert.equal(serialized.includes('workflow-org-key'), false);

    // Reimporting the portable bundle reuses/rotates the same stable credential.
    const reimported = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: exported.body,
    });
    assert.equal(reimported.status, 201, reimported.text);
    assert.equal(harness.fake.credentials.size, 1);
    assert.equal((reimported.body.nodes[1].parameters as any).auth.credentialId, credential.id);
    assert.equal(reimported.body.checksum, artifact.checksum);
    assert.equal(reimported.body.portableChecksum, artifact.portableChecksum);

    // Caller-supplied origins cannot widen the server binding.
    const widened = credentialDefinition();
    (widened.nodes[1].parameters as any).auth.allowedOrigins = ['https://evil.example', '*'];
    const widenedImport = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Widened', definition: widened },
    });
    assert.equal(widenedImport.status, 201, widenedImport.text);
    assert.deepEqual(
      (widenedImport.body.nodes[1].parameters as any).auth.allowedOrigins,
      ['https://synapsedx.sbs'],
    );
  } finally {
    await harness.close();
  }
});

test('old Tier-1 engine without the capability advertises no protection and never binds keys', async () => {
  const harness = await startWorkflowHarness();
  try {
    harness.fake.workflowEngineCapabilities = null;
    const readiness = await call(harness, '/v1/capabilities/workflow-artifacts/readiness', { token: 'user-token' });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.workflowCredentialDestinationProtection.ready, false);
    assert.equal(readiness.body.pluginFormsCanSubmit, false);

    const blocked = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Old engine', definition: credentialDefinition() },
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.code, 'dependency_unavailable');
    assert.equal(blocked.body.error.details.credentialDestinationProtection, false);
    assert.equal(harness.fake.credentials.size, 0);
    assert.equal(harness.fake.workflows.size, 0);
  } finally {
    await harness.close();
  }
});

test('credentialRef rejects unknown refs, id+ref, bad headers and wrong owners', async () => {
  const harness = await startWorkflowHarness();
  try {
    const both = credentialDefinition();
    (both.nodes[1].parameters as any).auth.credentialId = 'cred-foreign';
    const bothResponse = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Both', definition: both },
    });
    assert.equal(bothResponse.status, 400);
    assert.equal(bothResponse.body.error.code, 'invalid_credential_reference');

    const unknown = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Unknown', definition: credentialDefinition('synapseone-other') },
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'invalid_credential_reference');

    const badHeader = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Bad header', definition: credentialDefinition('synapsedx-organization', 'Authorization') },
    });
    assert.equal(badHeader.status, 400);
    assert.equal(badHeader.body.error.code, 'invalid_credential_reference');

    const rawId = credentialDefinition();
    delete (rawId.nodes[1].parameters as any).auth;
    (rawId.nodes[1].parameters as any).auth = { credentialId: 'cred-legacy', header: 'X-API-Key' };
    const rawResponse = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Raw id', definition: rawId },
    });
    assert.equal(rawResponse.status, 400);
    assert.equal(rawResponse.body.error.code, 'invalid_credential_reference');

    const topLevel = credentialDefinition();
    delete (topLevel.nodes[1].parameters as any).auth;
    (topLevel.nodes[1].parameters as any).credentialId = 'cred-legacy';
    const topLevelResponse = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Top level id', definition: topLevel },
    });
    assert.equal(topLevelResponse.status, 400);
    assert.equal(topLevelResponse.body.error.code, 'invalid_credential_reference');

    const hidden = credentialDefinition();
    (hidden.nodes[1].parameters as any).auth.alternateRef = 'synapsedx-organization';
    const hiddenResponse = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Hidden ref', definition: hidden },
    });
    assert.equal(hiddenResponse.status, 400);
    assert.equal(hiddenResponse.body.error.code, 'invalid_credential_reference');

    // An existing stable-name credential owned by another principal must never
    // be reused, even if the account id matches.
    harness.fake.credentials.set('cred-wrong-owner', {
      id: 'cred-wrong-owner',
      account_id: 'dx-workflow-acct-a',
      name: 'synapsedx-organization',
      kind: 'api-key',
      secret: 'stale',
      owner_sub: 'apikey:someone-else',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const wrongOwner = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST', token: 'user-token',
      body: { name: 'Wrong owner', definition: credentialDefinition() },
    });
    assert.equal(wrongOwner.status, 409);
    assert.equal(wrongOwner.body.error.code, 'credential_owner_mismatch');
    assert.equal(harness.fake.workflows.size, 0);
  } finally {
    await harness.close();
  }
});

test('existing Tier-1 workflows can be snapshotted into an artifact', async () => {
  const harness = await startWorkflowHarness();
  try {
    harness.fake.workflows.set('wf-existing', {
      id: 'wf-existing',
      name: 'Existing engine workflow',
      active: true,
      definition: definition(),
    });

    const needsClone = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Snapshot', workflowId: 'wf-existing' },
    });
    assert.equal(needsClone.status, 409);
    assert.equal(needsClone.body.error.code, 'clone_required');

    const created = await call(harness, '/v1/capabilities/workflow-artifacts/import', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Snapshot', workflowId: 'wf-existing', clone: true },
    });
    assert.equal(created.status, 201, created.text);
    assert.notEqual(created.body.workflowId, 'wf-existing');
    assert.equal(created.body.active, true);
    assert.equal(created.body.managedBy, 'technical');
    assert.equal(created.body.protected, true);
    assert.equal(created.body.source.kind, 'tier1-workflow');
    assert.equal(harness.fake.workflows.size, 2, 'legacy workflow is cloned, never re-stamped');
    const legacy = harness.fake.workflows.get('wf-existing')!;
    assert.equal(((legacy.definition.settings || {}) as any).access, undefined);
    assert.equal(JSON.stringify(created.body).includes(SECRET), false);

    harness.fake.workflows.delete(created.body.workflowId);
    const missing = await call(
      harness,
      `/v1/capabilities/workflow-artifacts/${created.body.id}/export`,
      { token: 'user-token' },
    );
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});
