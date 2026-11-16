// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowArtifactsClient, WorkflowArtifactsError } from './workflow-artifacts';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (request: Captured) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
  const requests: Captured[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key.toLowerCase()] = value; });
    const captured: Captured = {
      url: String(input),
      method: String(init.method || 'GET').toUpperCase(),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    requests.push(captured);
    const result = await handler(captured);
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const bundle = {
  format: 'synapsedx-workflow-artifact' as const,
  formatVersion: 1 as const,
  artifact: { name: 'City dispatch' },
  workflow: {
    nodes: [{ name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} }],
    connections: {},
    settings: {},
  },
  source: { kind: 'bundle' as const, repository: 'https://github.com/vku-open-source-2026/SynapseCity' },
};

test('defaults to the public SynapseDX domain and rejects local dependencies', () => {
  const client = new WorkflowArtifactsClient({ fetch: mockFetch(() => ({ body: {} })).impl });
  assert.equal((client as any).baseUrl, 'https://synapsedx.sbs');
  const previous = process.env.ALLOW_LOCAL_DEPENDENCIES;
  delete process.env.ALLOW_LOCAL_DEPENDENCIES;
  assert.throws(() => new WorkflowArtifactsClient({ baseUrl: 'http://127.0.0.1:8082' }), /local dependency/);
  process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
  assert.doesNotThrow(() => new WorkflowArtifactsClient({ baseUrl: 'http://127.0.0.1:8082' }));
  if (previous === undefined) delete process.env.ALLOW_LOCAL_DEPENDENCIES;
  else process.env.ALLOW_LOCAL_DEPENDENCIES = previous;
});

test('sends credentials and maps workflow artifact endpoints', async () => {
  const { impl, requests } = mockFetch((request) => {
    if (request.url.endsWith('/import')) return { status: 201, body: { id: 'art-1', version: 1 } };
    if (request.url.includes('/export')) return { body: { ...bundle, checksum: 'abc' } };
    if (request.url.endsWith('/execute')) return { body: { artifactId: 'art-1', workflowId: 'wf-1', execution: { id: 'exec-1' } } };
    if (request.url.endsWith('/versions')) return { body: { items: [], total: 0 } };
    if (request.url.endsWith('/versions/2')) return { body: { revision: 2 } };
    if (request.method === 'PUT') return { body: { id: 'art-1', revision: 2, version: 2 } };
    if (request.method === 'GET' && request.url.includes('/art-1')) return { body: { id: 'art-1', version: 1 } };
    if (request.method === 'GET') return { body: { items: [], total: 0, limit: 100, offset: 0, nextCursor: null } };
    return { body: {} };
  });
  const client = new WorkflowArtifactsClient({
    baseUrl: 'https://dx.example',
    token: 'tok',
    tenant: 'acct-a',
    fetch: impl,
  });

  await client.importArtifact(bundle);
  await client.importFromWorkflow('wf-existing', { name: 'Snapshot' });
  await client.get('art-1');
  await client.export('art-1');
  await client.update('art-1', { version: 1, name: 'Renamed' });
  await client.execute('art-1', { incidentId: 'INC-1' });
  await client.versions('art-1');
  await client.version('art-1', 2);

  const importRequest = requests[0];
  assert.equal(importRequest.method, 'POST');
  assert.match(importRequest.url, /\/v1\/capabilities\/workflow-artifacts\/import$/);
  assert.equal(importRequest.headers.authorization, 'Bearer tok');
  assert.equal(importRequest.headers['x-synapseone-tenant'], 'acct-a');
  assert.equal((importRequest.body as any).format, 'synapsedx-workflow-artifact');

  const snapshotRequest = requests[1];
  assert.equal((snapshotRequest.body as any).workflowId, 'wf-existing');

  assert.match(requests[2].url, /\/workflow-artifacts\/art-1$/);
  assert.match(requests[3].url, /\/workflow-artifacts\/art-1\/export$/);

  const updateRequest = requests[4];
  assert.equal(updateRequest.method, 'PUT');
  assert.equal(updateRequest.headers['if-match'], '"1"');
  assert.equal((updateRequest.body as any).version, 1);

  const executeRequest = requests[5];
  assert.equal(executeRequest.method, 'POST');
  assert.deepEqual((executeRequest.body as any).payload, { incidentId: 'INC-1' });

  assert.match(requests[6].url, /\/versions$/);
  assert.match(requests[7].url, /\/versions\/2$/);
});

test('rejects malformed bundles and maps API errors', async () => {
  const client = new WorkflowArtifactsClient({
    baseUrl: 'https://dx.example',
    token: 'tok',
    fetch: mockFetch(() => ({ status: 404, body: { error: { code: 'not_found', message: 'workflow artifact not found', requestId: 'req-1' } } })).impl,
  });
  assert.throws(
    () => client.importArtifact({ format: 'wrong' } as any),
    /formatVersion 1/,
  );
  await assert.rejects(
    () => client.get('art-1'),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowArtifactsError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'not_found');
      assert.equal(error.requestId, 'req-1');
      return true;
    },
  );
  assert.throws(
    () => client.update('art-1', { version: 0 }),
    /version must be/,
  );
});
