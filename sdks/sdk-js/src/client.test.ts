/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Offline SDK tests — local echo server, no platform needed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SynapseDXClient, unwrapExecutions, triggerWebhook } from './index';

let base = '';
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastPath = '';
let lastMethod = '';
let lastBody = '';
let server: http.Server;

before(
  () =>
    new Promise<void>((resolve) => {
      server = http
        .createServer((req, res) => {
          lastHeaders = { ...req.headers };
          lastPath = req.url || '';
          lastMethod = req.method || '';
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            lastBody = body;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: req.url }));
          });
        })
        .listen(0, '127.0.0.1', () => {
          const a = server.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
    }),
);

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('SynapseDXClient', () => {
  it('trims trailing slash', () => {
    const c = new SynapseDXClient({ baseUrl: 'http://x:8080/' });
    assert.equal((c as any).baseUrl, 'http://x:8080');
  });

  it('sends Bearer token', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    c.setToken('tok123');
    await c.listOrgs();
    assert.equal(lastHeaders['authorization'], 'Bearer tok123');
    assert.equal(lastPath, '/v1/orgs');
  });

  it('sends X-API-Key', async () => {
    const c = new SynapseDXClient({ baseUrl: base, apiKey: 'k1' });
    await c.listTemplates();
    assert.equal(lastHeaders['x-api-key'], 'k1');
  });

  it('throws rich error on non-2xx', async () => {
    const bad = new SynapseDXClient({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(() => bad.listOrgs(), /synapsedx/);
  });

  it('encodes ids in paths', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.getWorkflow('a/b');
    assert.equal(lastPath, '/v1/workflows/a%2Fb');
  });

  it('covers new endpoints', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.userPolicies('u1');
    assert.equal(lastPath, '/v1/users/u1/policies');
    await c.getTemplate('webhook-to-log');
    assert.equal(lastPath, '/v1/templates/webhook-to-log');
    await c.listExecutions('limit=5');
    assert.equal(lastPath, '/v1/executions?limit=5');
    await c.executeWorkflow('w1', {});
    assert.equal(lastPath, '/v1/workflows/w1/execute');
    await c.updateWorkflow('w1', { name: 'renamed' });
    assert.equal(lastPath, '/v1/workflows/w1');
    await c.deleteWorkflow('w1');
    assert.equal(lastPath, '/v1/workflows/w1');
    await c.detachPolicy('r1', 'p1');
    assert.equal(lastPath, '/v1/roles/r1/policies/p1');
    await c.rolePolicies('r1');
    assert.equal(lastPath, '/v1/roles/r1/policies');
    await c.unassignRole('u1', 'r1');
    assert.equal(lastPath, '/v1/users/u1/roles/r1');
    await c.userRoles('u1');
    assert.equal(lastPath, '/v1/users/u1/roles');
    await c.listApiKeys('a1');
    assert.equal(lastPath, '/v1/accounts/a1/keys');
    await c.verifyApiKey('k');
    assert.equal(lastPath, '/v1/keys/verify');
    await c.deactivateWorkflow('w1');
    assert.equal(lastPath, '/v1/workflows/w1/deactivate');
  });

  it('testRun posts definition+input', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    const def = { nodes: [], connections: {} };
    await c.testRun(def, { value: 21 });
    assert.equal(lastPath, '/v1/workflows/test-run');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), { definition: def, input: { value: 21 } });
  });

  it('listExecutions accepts the allowlisted dict form', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.listExecutions({ workflowId: 'w1', status: 'error', limit: 20, offset: 0, includeData: true } as any);
    assert.ok(lastPath.startsWith('/v1/executions?'), lastPath);
    assert.ok(lastPath.includes('workflowId=w1'), lastPath);
    assert.ok(lastPath.includes('status=error'), lastPath);
    assert.ok(lastPath.includes('limit=20'), lastPath);
    assert.ok(lastPath.includes('includeData=true'), lastPath);
  });

  it('getExecution supports includeData', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.getExecution('e1', true);
    assert.equal(lastPath, '/v1/executions/e1?includeData=true');
  });

  it('unwrapExecutions accepts envelope and bare array', () => {
    assert.deepEqual(unwrapExecutions({ data: [{ id: 'e1' }] }), [{ id: 'e1' }]);
    assert.deepEqual(unwrapExecutions([{ id: 'e2' }]), [{ id: 'e2' }]);
    assert.deepEqual(unwrapExecutions(null), []);
  });

  it('triggerWebhook posts to /webhook/:path without auth', async () => {
    const out: any = await triggerWebhook(base, 'transform', { value: 21 });
    assert.equal(lastPath, '/webhook/transform');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), { value: 21 });
    assert.equal(out.ok, true);
  });

  it('call() passes any method/path/body through', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.call('POST', '/v1/accounts/a1/credentials', { name: 'x' });
    assert.equal(lastPath, '/v1/accounts/a1/credentials');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), { name: 'x' });
    await c.call('get', 'v1/workflows');
    assert.equal(lastPath, '/v1/workflows');
    assert.equal(lastMethod, 'GET');
  });

  it('credentials CRUD hits the proposed contract paths', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.createCredential('a1', { name: 'stripe-live', type: 'bearer', secret: 's3cr3t', expiresAt: '2027-01-01T00:00:00Z' });
    assert.equal(lastPath, '/v1/accounts/a1/credentials');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), { name: 'stripe-live', type: 'bearer', secret: 's3cr3t', expiresAt: '2027-01-01T00:00:00Z' });
    await c.listCredentials('a1');
    assert.equal(lastPath, '/v1/accounts/a1/credentials');
    assert.equal(lastMethod, 'GET');
    await c.getCredential('c1');
    assert.equal(lastPath, '/v1/credentials/c1');
    await c.rotateCredential('c1', 'n3w');
    assert.equal(lastPath, '/v1/credentials/c1/rotate');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), { secret: 'n3w' });
    await c.deleteCredential('c1');
    assert.equal(lastPath, '/v1/credentials/c1');
    assert.equal(lastMethod, 'DELETE');
  });
});
