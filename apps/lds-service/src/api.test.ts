/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * API tests: boot the real Express app on an ephemeral port (memory store)
 * and drive the full SynapseLDS flow, including leak-attempt assertions.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { createApp } from './index';
import { __clearLdsMem } from './store';

let server: Server;
let base = '';

function headers(org = 'tenant-danang', sub = 'user-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapsedx-user': sub, 'x-synapsedx-org': org, 'x-synapsedx-kind': 'user' };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = headers(), rawBody = false): Promise<{ status: number; json: any; res: Response }> {
  const payload = body === undefined ? undefined : rawBody ? String(body) : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => __clearLdsMem());

async function createDatasource(extra: any = {}): Promise<any> {
  const r = await call('POST', '/v1/lds/datasources', {
    name: 'Business Registry', entityType: 'Organization', license: 'CC-BY-4.0', ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

test('health + license catalog are served', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.equal(health.json.service, 'lds');
  const lic = await call('GET', '/v1/lds/licenses');
  assert.equal(lic.status, 200);
  assert.ok(Array.isArray(lic.json));
  const ids = lic.json.map((l: any) => l.id);
  for (const id of ['CC0-1.0', 'CC-BY-4.0', 'ODbL-1.0', 'LicenseRef-Proprietary']) assert.ok(ids.includes(id), id);
});

test('datasource CRUD with tenant binding and license surfacing', async () => {
  const ds = await createDatasource({ license: 'ODbL-1.0', contexts: ['https://data.example.vn/context/organization.jsonld'] });
  assert.equal(ds.license, 'ODbL-1.0');
  assert.equal(ds.licenseUrl, 'https://opendatacommons.org/licenses/odbl/1.0/');
  assert.equal(ds.orgId, 'tenant-danang');
  assert.equal(ds.defaultVisibility, 'internal'); // safe default

  const got = await call('GET', `/v1/lds/datasources/${ds.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.attributes, []);
  assert.equal(got.json.stats.records, 0);

  // unknown license is rejected
  const bad = await call('POST', '/v1/lds/datasources', { name: 'X', entityType: 'Thing', license: 'MIT' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_license');

  // cross-tenant create is forbidden
  const cross = await call('POST', '/v1/lds/datasources', { name: 'X', entityType: 'Thing', license: 'CC0-1.0', orgId: 'tenant-other' });
  assert.equal(cross.status, 403);

  // another org cannot see or mutate the datasource
  const foreign = await call('GET', `/v1/lds/datasources/${ds.id}`, undefined, headers('tenant-other'));
  assert.equal(foreign.status, 404);
  const foreignDelete = await call('DELETE', `/v1/lds/datasources/${ds.id}`, undefined, headers('tenant-other'));
  assert.equal(foreignDelete.status, 404);

  // patch + delete by owner
  const patch = await call('PATCH', `/v1/lds/datasources/${ds.id}`, { license: 'CC0-1.0' });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.license, 'CC0-1.0');
  const del = await call('DELETE', `/v1/lds/datasources/${ds.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  assert.equal((await call('GET', `/v1/lds/datasources/${ds.id}`)).status, 404);
});

test('reserved attribute names are rejected with the reserved list', async () => {
  const ds = await createDatasource();
  const r = await call('PUT', `/v1/lds/datasources/${ds.id}/attributes`, {
    attributes: [{ name: 'name', visibility: 'public' }, { name: 'internalId', visibility: 'public' }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'reserved_attribute');
  assert.deepEqual(r.json.reserved, ['internalId']);
  // nothing partially applied
  assert.deepEqual((await call('GET', `/v1/lds/datasources/${ds.id}/attributes`)).json, []);
});

test('ingest → NGSI-LD export: allowlist projection, default deny, quarantine', async () => {
  const ds = await createDatasource({ contexts: ['https://data.example.vn/context/organization.jsonld'] });
  const put = await call('PUT', `/v1/lds/datasources/${ds.id}/attributes`, {
    attributes: [
      { name: 'name', visibility: 'public' },
      { name: 'status', visibility: 'public' },
      { name: 'taxCode', visibility: 'restricted' },
      { name: 'internalNote', visibility: 'internal' },
      { name: 'locatedIn', ngsiLdType: 'Relationship', visibility: 'public' },
    ],
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));

  const ingest = await call('POST', `/v1/lds/datasources/${ds.id}/records`, {
    id: '55001', name: 'Công ty ABC', status: 'active', taxCode: 'TAX-1', internalNote: 'secret',
    locatedIn: 'urn:ngsi-ld:AdministrativeArea:danang', employeeCount: 120,
    internalId: 'attacker-controlled', tenantId: 'tenant-evil', _core: { pwn: true },
  });
  assert.equal(ingest.status, 201, JSON.stringify(ingest.json));
  assert.equal(ingest.json.ingested, 1);
  assert.equal(ingest.json.created, 1);
  assert.equal(ingest.json.entities[0].entityId, 'urn:ngsi-ld:Organization:55001');
  const qFields = ingest.json.quarantined.map((q: any) => q.field).sort();
  assert.deepEqual(qFields, ['_core', 'internalId', 'tenantId']);

  // public export
  const exp = await call('GET', `/v1/lds/datasources/${ds.id}/entities`);
  assert.equal(exp.status, 200);
  assert.equal(exp.res.headers.get('x-lds-license'), 'CC-BY-4.0');
  assert.equal(exp.res.headers.get('link'), '<https://creativecommons.org/licenses/by/4.0/>; rel="license"');
  assert.equal(exp.json.length, 1);
  const [entity] = exp.json;
  assert.equal(entity.id, 'urn:ngsi-ld:Organization:55001');
  assert.equal(entity.type, 'Organization');
  assert.deepEqual(entity.name, { type: 'Property', value: 'Công ty ABC' });
  assert.deepEqual(entity.locatedIn, { type: 'Relationship', object: 'urn:ngsi-ld:AdministrativeArea:danang' });
  assert.equal(entity['@context'][0], 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.9.jsonld');
  // license URL rides inside @context (3-place surfacing), then user contexts
  assert.equal(entity['@context'][1], 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(entity['@context'][2], 'https://data.example.vn/context/organization.jsonld');

  // dynamic junk is stored but default-denied from the export; restricted stays out
  const raw = JSON.stringify(exp.json);
  for (const secret of ['internalId', 'tenantId', '_core', 'attacker-controlled', 'tenant-evil', 'secret', 'TAX-1', 'employeeCount']) {
    assert.equal(raw.includes(secret), false, `export leaked '${secret}'`);
  }

  // restricted visibility requires a caller inside the datasource tenant:
  // gateway-anonymous callers (x-synapsedx-anon marker, public route) get 401,
  // authenticated outsiders can't even resolve the dataset (404, no existence
  // leak), and the platform (internal ops) superuser may read it.
  const anonLocalTenant = await call('GET', `/v1/lds/datasources/${ds.id}`, undefined, { 'content-type': 'application/json', 'x-synapsedx-anon': '1' });
  assert.equal(anonLocalTenant.status, 401);
  assert.equal(anonLocalTenant.json.error, 'auth_required');
  const outsider = await call('GET', `/v1/lds/datasources/${ds.id}`, undefined, headers('tenant-evil', 'user-9'));
  assert.equal(outsider.status, 404);
  const globalCreate = await call('POST', '/v1/lds/datasources', { name: 'Global Registry', entityType: 'Museum', license: 'CC0-1.0' }, { 'content-type': 'application/json' });
  assert.equal(globalCreate.status, 201);
  assert.equal(globalCreate.json.orgId, undefined);
  const gid = globalCreate.json.id;
  await call('PUT', `/v1/lds/datasources/${gid}/attributes`, { attributes: [{ name: 'note', visibility: 'restricted' }] }, { 'content-type': 'application/json' });
  await call('POST', `/v1/lds/datasources/${gid}/records`, { id: 'g1', note: 'restricted note' }, { 'content-type': 'application/json' });
  const anonRestricted = await call('GET', `/v1/lds/datasources/${gid}/entities?visibility=restricted`, undefined, { 'content-type': 'application/json', 'x-synapsedx-anon': '1' });
  assert.equal(anonRestricted.status, 401);
  // platform = internal ops superuser (direct internal call, no marker)
  const platformRestricted = await call('GET', `/v1/lds/datasources/${ds.id}/entities?visibility=restricted`, undefined, { 'content-type': 'application/json' });
  assert.equal(platformRestricted.status, 200);
  assert.deepEqual(platformRestricted.json[0].taxCode, { type: 'Property', value: 'TAX-1' });

  const internal = await call('GET', `/v1/lds/datasources/${ds.id}/entities?visibility=restricted`);
  assert.equal(internal.status, 200);
  assert.deepEqual(internal.json[0].taxCode, { type: 'Property', value: 'TAX-1' });
  assert.equal(JSON.stringify(internal.json).includes('secret'), false); // internal never leaves

  // single-entity fetch + 404
  const one = await call('GET', `/v1/lds/datasources/${ds.id}/entities/${encodeURIComponent(entity.id)}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, entity.id);
  assert.equal((await call('GET', `/v1/lds/datasources/${ds.id}/entities/urn%3Angsi-ld%3AOrganization%3A999`)).status, 404);

  // re-ingest bumps version, updates attribute
  const again = await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: '55001', name: 'Công ty ABC (updated)' });
  assert.equal(again.status, 201);
  assert.equal(again.json.updated, 1);
  assert.equal(again.json.entities[0].version, 2);

  const stats = await call('GET', `/v1/lds/datasources/${ds.id}/stats`);
  assert.equal(stats.json.records, 1);
  assert.deepEqual(stats.json.attributes, { public: 3, restricted: 1, internal: 1 });
});

test('anonymous public surface: export is public, management is 401, restricted is 401', async () => {
  const anonH = { 'content-type': 'application/json', 'x-synapsedx-anon': '1' };
  const anonHNoCt = { 'x-synapsedx-anon': '1' };
  const ds = await createDatasource({ defaultVisibility: 'public' });
  await call('PUT', `/v1/lds/datasources/${ds.id}/attributes`, {
    attributes: [{ name: 'name', visibility: 'public' }, { name: 'taxCode', visibility: 'restricted' }],
  });
  await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'p1', name: 'Công', taxCode: 'T-9', hidden: 'x' });

  // public projection via the public route: license surfacing + only public attrs
  const pub = await call('GET', `/v1/lds/datasources/${ds.id}/entities`, undefined, anonHNoCt);
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.equal(pub.json.length, 1);
  assert.equal(pub.json[0].name.value, 'Công');
  assert.equal('taxCode' in pub.json[0], false);
  assert.equal('hidden' in pub.json[0], false);
  assert.equal(pub.res.headers.get('x-lds-license'), 'CC-BY-4.0');
  const one = await call('GET', `/v1/lds/datasources/${ds.id}/entities/${encodeURIComponent('urn:ngsi-ld:Organization:p1')}`, undefined, anonHNoCt);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, 'urn:ngsi-ld:Organization:p1');

  // management actions are 401 for anonymous callers (never 404/403 — shape is uniform)
  for (const [m, path] of [
    ['GET', '/v1/lds/datasources'],
    ['POST', '/v1/lds/datasources'],
    ['GET', `/v1/lds/datasources/${ds.id}`],
    ['GET', `/v1/lds/datasources/${ds.id}/attributes`],
    ['GET', `/v1/lds/datasources/${ds.id}/stats`],
  ] as Array<[string, string]>) {
    const r = await call(m, path, undefined, anonHNoCt);
    assert.equal(r.status, 401, `${m} ${path}`);
    assert.equal(r.json.error, 'auth_required');
  }
  const w = await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'evil' }, anonH);
  assert.equal(w.status, 401);
  const d = await call('DELETE', `/v1/lds/datasources/${ds.id}`, undefined, anonHNoCt);
  assert.equal(d.status, 401);
  const r401 = await call('GET', `/v1/lds/datasources/${ds.id}/entities?visibility=restricted`, undefined, anonHNoCt);
  assert.equal(r401.status, 401);
  assert.equal(r401.json.error, 'auth_required');

  // anonymous existence guards: unknown dataset 404; HEAD matches GET
  assert.equal((await call('GET', '/v1/lds/datasources/does-not-exist/entities', undefined, anonHNoCt)).status, 404);
  assert.equal((await call('GET', '/v1/lds/licenses', undefined, anonHNoCt)).status, 200);
});

test('list is principal-scoped: query params narrow, never widen', async () => {
  await createDatasource({ name: 'A' });
  await createDatasource({ name: 'B', slug: 'b-registry' });
  await call('POST', '/v1/lds/datasources', { name: 'Hue DS', entityType: 'Museum', license: 'CC0-1.0' }, headers('tenant-hue', 'user-2'));
  const mine = await call('GET', '/v1/lds/datasources');
  assert.equal(mine.json.length, 2);
  // cannot widen with another org's id, nor with a foreign account filter
  const cross = await call('GET', '/v1/lds/datasources?orgId=tenant-hue');
  assert.equal(cross.json.length, 0);
  const crossAcc = await call('GET', '/v1/lds/datasources?accountId=acc-x');
  assert.equal(crossAcc.json.length, 0);
  // the owning principal sees exactly its own row
  const hue = await call('GET', '/v1/lds/datasources', undefined, headers('tenant-hue', 'user-2'));
  assert.equal(hue.json.length, 1);
  assert.equal(hue.json[0].name, 'Hue DS');
  // account-scoped principals (API keys / service accounts) are bound to
  // their own account and can never create or reach another tenant's rows
  const keyH = { 'content-type': 'application/json', 'x-synapsedx-user': 'sa-1', 'x-synapsedx-account': 'acc-9', 'x-synapsedx-kind': 'apikey' };
  const made = await call('POST', '/v1/lds/datasources', { name: 'Key DS', entityType: 'Thing', license: 'CC0-1.0' }, keyH);
  assert.equal(made.status, 201);
  assert.equal(made.json.orgId, undefined);
  assert.equal(made.json.accountId, 'acc-9');
  const intoOrg = await call('POST', '/v1/lds/datasources', { name: 'X', entityType: 'Thing', license: 'CC0-1.0', orgId: 'tenant-hue' }, keyH);
  assert.equal(intoOrg.status, 403);
  const keyList = await call('GET', '/v1/lds/datasources', undefined, keyH);
  assert.deepEqual(keyList.json.map((d: any) => d.name), ['Key DS']);
  // tenant principals never see the account-scoped row, not even by id
  assert.equal((await call('GET', `/v1/lds/datasources/${made.json.id}`)).status, 404);
  // platform (internal ops, no principal, no marker) is the superuser class:
  // it sees every row including org- and account-bound ones.
  const platform = await call('GET', '/v1/lds/datasources', undefined, { 'content-type': 'application/json' });
  assert.equal(new Set(platform.json.map((d: any) => d.name)).size, 4);
  assert.deepEqual(platform.json.map((d: any) => d.name).sort(), ['A', 'B', 'Hue DS', 'Key DS']);
});

test('entity id overrides must be IRIs; junk ids fall back to the derived urn', async () => {
  const ds = await createDatasource();
  const ingest = await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'x1', ngsiLdId: 'urn:ngsi-ld:Organization:custom-id', name: 'n' });
  assert.equal(ingest.status, 201);
  assert.equal(ingest.json.entities[0].entityId, 'urn:ngsi-ld:Organization:custom-id');
  const evil = await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'x2', ngsiLdId: 'javascript:alert(1)', name: 'n' });
  assert.equal(evil.status, 201);
  assert.equal(evil.json.entities[0].entityId, 'urn:ngsi-ld:Organization:x2');
});

test('input validation: strict pagination, malformed JSON, unknown patch fields', async () => {
  const ds = await createDatasource();
  await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'v1', name: 'x' });
  // strict limit/offset — invalid values are a 400, never a silent clamp
  for (const q of ['limit=0', 'limit=501', 'limit=abc', 'limit=1.5']) {
    const r = await call('GET', `/v1/lds/datasources/${ds.id}/entities?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error, 'invalid_limit', q);
  }
  for (const q of ['offset=-1', 'offset=1.5', 'offset=1e3']) {
    const r = await call('GET', `/v1/lds/datasources/${ds.id}/entities?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.error, 'invalid_offset', q);
  }
  // boundary values still fine
  assert.equal((await call('GET', `/v1/lds/datasources/${ds.id}/entities?limit=1&offset=0`)).status, 200);
  assert.equal((await call('GET', `/v1/lds/datasources/${ds.id}/entities?limit=500`)).status, 200);

  // malformed JSON → 400 invalid_json (not a 500)
  const bad = await call('POST', `/v1/lds/datasources/${ds.id}/records`, '{nope', headers(), true);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_json');

  // unknown-only patch rejected; privileged fields cannot ride along a mixed patch
  const only = await call('PATCH', `/v1/lds/datasources/${ds.id}`, { orgId: 'tenant-evil' });
  assert.equal(only.status, 400);
  assert.equal(only.json.error, 'invalid_body');
  const mixed = await call('PATCH', `/v1/lds/datasources/${ds.id}`, { name: 'Renamed', orgId: 'tenant-evil', org_id: 'tenant-evil' });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.json.name, 'Renamed');
  assert.equal(mixed.json.orgId, 'tenant-danang');
});

test('ingest summary reports public identity only — no _core fields', async () => {
  const ds = await createDatasource();
  const r = await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'shape-1', name: 'x' });
  assert.equal(r.status, 201);
  const e = r.json.entities[0];
  assert.deepEqual(Object.keys(e).sort(), ['entityId', 'sourceRecordId', 'version']);
  assert.equal('id' in e, false);
  assert.equal(JSON.stringify(r.json).includes('internalId'), false);
  assert.equal(e.entityId, 'urn:ngsi-ld:Organization:shape-1');
});

test('escaped entity ids resolve correctly; malformed escapes are a 400', async () => {
  const ds = await createDatasource();
  const ing = await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'x y/z', name: 'spaced' });
  assert.equal(ing.status, 201);
  const list = await call('GET', `/v1/lds/datasources/${ds.id}/entities`);
  assert.equal(list.status, 200);
  const id = list.json[0].id;
  assert.equal(id, 'urn:ngsi-ld:Organization:x%20y%2Fz');
  // single-entity fetch decodes exactly once (Express already decoded the param)
  const one = await call('GET', `/v1/lds/datasources/${ds.id}/entities/${encodeURIComponent(id)}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, id);
  // malformed percent-escape → 400, not a 500
  const bad = await fetch(`${base}/v1/lds/datasources/${ds.id}/entities/%E0`, { headers: headers() });
  assert.equal(bad.status, 400);
});

test('defaultVisibility applies to registry entries that omit visibility; restricted exports are no-store', async () => {
  const ds = await createDatasource({ defaultVisibility: 'public' });
  const r = await call('PUT', `/v1/lds/datasources/${ds.id}/attributes`, { attributes: [{ name: 'a' }, { name: 'b', visibility: 'internal' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.find((x: any) => x.name === 'a').visibility, 'public');
  assert.equal(r.json.find((x: any) => x.name === 'b').visibility, 'internal');
  await call('POST', `/v1/lds/datasources/${ds.id}/records`, { id: 'd1', a: 'v' });
  const restricted = await call('GET', `/v1/lds/datasources/${ds.id}/entities?visibility=restricted`);
  assert.equal(restricted.status, 200);
  assert.equal(restricted.res.headers.get('cache-control'), 'private, no-store');
  const publicExp = await call('GET', `/v1/lds/datasources/${ds.id}/entities`);
  assert.equal(publicExp.res.headers.get('cache-control'), 'public, max-age=60');
});
