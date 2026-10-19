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

  it('ldsLicenses lists the license catalog', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.ldsLicenses();
    assert.equal(lastPath, '/v1/lds/licenses');
    assert.equal(lastMethod, 'GET');
  });

  it('ldsDatasources passes orgId/accountId filters', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.ldsDatasources({ orgId: 'o1', accountId: 'a1' });
    assert.equal(lastPath, '/v1/lds/datasources?orgId=o1&accountId=a1');
    await c.ldsDatasources();
    assert.equal(lastPath, '/v1/lds/datasources');
  });

  it('ldsCreateDatasource posts the contract body', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    const input = {
      name: 'Weather', slug: 'weather', entityType: 'WeatherObserved', license: 'CC-BY-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      contexts: ['https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld'],
      defaultVisibility: 'public' as const, description: 'demo datasource', orgId: 'o1', accountId: 'a1',
    };
    await c.ldsCreateDatasource(input);
    assert.equal(lastPath, '/v1/lds/datasources');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), input);
  });

  it('covers LDS datasource/attribute CRUD paths', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.ldsDatasource('ds1');
    assert.equal(lastPath, '/v1/lds/datasources/ds1');
    await c.ldsUpdateDatasource('ds1', { name: 'renamed' });
    assert.equal(lastPath, '/v1/lds/datasources/ds1');
    assert.equal(lastMethod, 'PATCH');
    assert.deepEqual(JSON.parse(lastBody), { name: 'renamed' });
    await c.ldsDeleteDatasource('ds1');
    assert.equal(lastPath, '/v1/lds/datasources/ds1');
    assert.equal(lastMethod, 'DELETE');
    await c.ldsAttributes('ds1');
    assert.equal(lastPath, '/v1/lds/datasources/ds1/attributes');
    await c.ldsSetAttributes('ds1', [{ name: 'temperature', ngsiLdType: 'Property', visibility: 'public' }]);
    assert.equal(lastPath, '/v1/lds/datasources/ds1/attributes');
    assert.equal(lastMethod, 'PUT');
    assert.deepEqual(JSON.parse(lastBody), { attributes: [{ name: 'temperature', ngsiLdType: 'Property', visibility: 'public' }] });
    await c.ldsStats('ds1');
    assert.equal(lastPath, '/v1/lds/datasources/ds1/stats');
    await c.ldsEntity('ds1', 'urn:ngsi-ld:Thing:t1');
    assert.equal(lastPath, '/v1/lds/datasources/ds1/entities/urn%3Angsi-ld%3AThing%3At1');
  });

  it('ldsIngest normalizes single/array/wrapped record bodies', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.ldsIngest('ds1', { sensor: 's1', temperature: 21 });
    assert.equal(lastPath, '/v1/lds/datasources/ds1/records');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), { record: { sensor: 's1', temperature: 21 } });
    await c.ldsIngest('ds1', [{ sensor: 's1' }, { sensor: 's2' }]);
    assert.deepEqual(JSON.parse(lastBody), { records: [{ sensor: 's1' }, { sensor: 's2' }] });
    await c.ldsIngest('ds1', { records: [{ sensor: 's3' }] });
    assert.deepEqual(JSON.parse(lastBody), { records: [{ sensor: 's3' }] });
  });

  it('ldsEntities sends limit/offset/visibility query params', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.ldsEntities('ds1', { limit: 50, offset: 10, visibility: 'public' });
    assert.equal(lastPath, '/v1/lds/datasources/ds1/entities?limit=50&offset=10&visibility=public');
    await c.ldsEntities('ds1');
    assert.equal(lastPath, '/v1/lds/datasources/ds1/entities');
  });

  it('ldsSetAttributes surfaces the 400 reserved_attribute error', async () => {
    let errMethod = '';
    let errPath = '';
    let errBody = '';
    const errSrv = http.createServer((req, res) => {
      errMethod = req.method || '';
      errPath = req.url || '';
      let body = '';
      req.on('data', (ch) => (body += ch));
      req.on('end', () => {
        errBody = body;
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'reserved_attribute', message: 'attribute name "id" is reserved' }));
      });
    });
    await new Promise<void>((resolve) => errSrv.listen(0, '127.0.0.1', resolve));
    const a = errSrv.address();
    const errBase = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    try {
      const c = new SynapseDXClient({ baseUrl: errBase });
      await assert.rejects(
        () => c.ldsSetAttributes('ds1', [{ name: 'id' }]),
        /synapsedx 400 .*reserved_attribute/,
      );
      assert.equal(errMethod, 'PUT');
      assert.equal(errPath, '/v1/lds/datasources/ds1/attributes');
      assert.deepEqual(JSON.parse(errBody), { attributes: [{ name: 'id' }] });
    } finally {
      await new Promise<void>((resolve) => errSrv.close(() => resolve()));
    }
  });
});
