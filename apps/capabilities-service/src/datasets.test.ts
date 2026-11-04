// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

test('dataset metadata is validated against the LDS catalog and semver', async () => {
  const harness = await startHarness();
  try {
    const proprietaryPublic = await createDataset(harness, {
      slug: 'bad-license', public: true, license: 'LicenseRef-Proprietary',
    });
    assert.equal(proprietaryPublic.status, 400);
    assert.equal(proprietaryPublic.body.error.code, 'invalid_license');

    const unknownLicense = await createDataset(harness, { slug: 'unknown', license: 'NOT-A-LICENSE' });
    assert.equal(unknownLicense.status, 400);
    assert.equal(unknownLicense.body.error.code, 'invalid_license');

    const badVersion = await createDataset(harness, { slug: 'bad-version', schemaVersion: 'v1' });
    assert.equal(badVersion.status, 400);
    assert.equal(badVersion.body.error.code, 'invalid_schema_version');

    const badEntity = await createDataset(harness, { slug: 'bad-entity', entityType: '1 bad type!' });
    assert.equal(badEntity.status, 400);

    const ok = await createDataset(harness, { slug: 'good', license: 'CC0-1.0' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.status, 'draft');

    const duplicate = await createDataset(harness, { slug: 'good', license: 'CC0-1.0' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'dataset_already_exists');
  } finally {
    await harness.close();
  }
});

test('publish -> revoke deletes the public projection; publish from revoked restores it', async () => {
  const harness = await startHarness();
  try {
    const created = await createDataset(harness, { slug: 'pub', name: 'Pub' });
    assert.equal(created.status, 201);

    const record = await api(harness, '/v1/capabilities/datasets/pub/records', {
      method: 'POST', token: 'user-token', body: { id: 'r1', data: { value: 1 } },
    });
    assert.equal(record.status, 201);

    const published = await api(harness, '/v1/capabilities/datasets/pub/publish', { method: 'POST', token: 'user-token' });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'published');
    assert.ok(published.body.ldsDatasourceId);
    const datasourceId = published.body.ldsDatasourceId;

    const entities = await api(harness, '/v1/capabilities/datasets/pub/entities');
    assert.equal(entities.status, 200);
    assert.equal(entities.body.length, 1);
    assert.equal(entities.headers.get('x-lds-license'), 'CC-BY-4.0');
    assert.match(String(entities.headers.get('link')), /rel="license"/);
    assert.equal(entities.headers.get('x-lds-total'), '1');
    assert.ok(entities.headers.get('x-lds-datasource'));
    assert.match(String(entities.headers.get('cache-control')), /max-age=60/);

    const revoke = await api(harness, '/v1/capabilities/datasets/pub/revoke', { method: 'POST', token: 'user-token' });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.status, 'revoked');
    assert.equal(revoke.body.ldsDatasourceId, undefined);

    // Direct Tier-1 LDS read must be gone (datasource deleted).
    const direct = await api(harness, `/v1/lds/datasources/${datasourceId}/entities`);
    assert.equal(direct.status, 404);

    const hidden = await api(harness, '/v1/capabilities/datasets/pub/entities');
    assert.deepEqual(hidden.body, []);

    const republished = await api(harness, '/v1/capabilities/datasets/pub/publish', { method: 'POST', token: 'user-token' });
    assert.equal(republished.status, 200);
    assert.equal(republished.body.status, 'published');
    const restored = await api(harness, '/v1/capabilities/datasets/pub/entities');
    assert.equal(restored.body.length, 1);
  } finally {
    await harness.close();
  }
});

test('PATCH public:false unpublishes and PATCH public:true republishes', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'toggle', name: 'Toggle' });
    await api(harness, '/v1/capabilities/datasets/toggle/records', {
      method: 'POST', token: 'user-token', body: { id: 'r1', data: { x: 1 } },
    });
    const published = await api(harness, '/v1/capabilities/datasets/toggle/publish', { method: 'POST', token: 'user-token' });
    const firstDatasource = published.body.ldsDatasourceId;
    assert.ok(firstDatasource);

    const hidden = await api(harness, '/v1/capabilities/datasets/toggle', {
      method: 'PATCH', token: 'user-token', body: { public: false },
    });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.public, false);
    assert.equal(hidden.body.status, 'revoked');
    assert.equal(hidden.body.ldsDatasourceId, undefined);
    assert.equal((await api(harness, `/v1/lds/datasources/${firstDatasource}/entities`)).status, 404);

    const shown = await api(harness, '/v1/capabilities/datasets/toggle', {
      method: 'PATCH', token: 'user-token', body: { public: true },
    });
    assert.equal(shown.status, 200);
    assert.equal(shown.body.public, true);
    assert.equal(shown.body.status, 'published');
    const entities = await api(harness, '/v1/capabilities/datasets/toggle/entities');
    assert.equal(entities.body.length, 1);
  } finally {
    await harness.close();
  }
});

test('publish rejects private datasets and records.create(publish:true) cannot publish a draft', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'private', name: 'Private', public: false, license: 'LicenseRef-Proprietary' });
    const publish = await api(harness, '/v1/capabilities/datasets/private/publish', { method: 'POST', token: 'user-token' });
    assert.equal(publish.status, 409);
    assert.equal(publish.body.error.code, 'dataset_not_public');

    const record = await api(harness, '/v1/capabilities/datasets/private/records', {
      method: 'POST', token: 'user-token', body: { data: { x: 1 }, publish: true },
    });
    assert.equal(record.status, 409);
    assert.equal(record.body.error.code, 'dataset_not_published');

    const draft = await createDataset(harness, { slug: 'draft-public', name: 'Draft', public: true });
    const draftRecord = await api(harness, '/v1/capabilities/datasets/draft-public/records', {
      method: 'POST', token: 'user-token', body: { data: { x: 1 }, publish: true },
    });
    assert.equal(draftRecord.status, 409);

    const dataset = await api(harness, '/v1/capabilities/datasets/draft-public', { token: 'user-token' });
    assert.equal(dataset.body.status, 'draft');
  } finally {
    await harness.close();
  }
});

test('publicOnly filtering happens in the Tier-1 query, not after pagination', async () => {
  const harness = await startHarness();
  try {
    const created = await createDataset(harness, { slug: 'private-first', name: 'Private', public: false, license: 'LicenseRef-Proprietary' });
    assert.equal(created.status, 201);
    await createDataset(harness, { slug: 'public-later', name: 'Public', public: true });
    await api(harness, '/v1/capabilities/datasets/public-later/publish', { method: 'POST', token: 'user-token' });

    const page = await api(harness, '/v1/capabilities/datasets?publicOnly=true&limit=1&offset=0');
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.map((item: any) => item.id), ['public-later']);
    assert.equal(page.headers.get('x-total-count'), '1');
  } finally {
    await harness.close();
  }
});

test('dataset delete refuses a non-empty dataset unless records are purged', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'to-delete', name: 'Delete' });
    await api(harness, '/v1/capabilities/datasets/to-delete/records', {
      method: 'POST', token: 'user-token', body: { id: 'r1', data: { x: 1 } },
    });
    const refused = await api(harness, '/v1/capabilities/datasets/to-delete', { method: 'DELETE', token: 'user-token' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'dataset_not_empty');

    const removed = await api(harness, '/v1/capabilities/datasets/to-delete?purgeRecords=true', {
      method: 'DELETE', token: 'user-token',
    });
    assert.equal(removed.status, 204);
    assert.equal((await api(harness, '/v1/capabilities/datasets/to-delete', { token: 'user-token' })).status, 404);
    assert.equal((await api(harness, '/v1/capabilities/datasets/to-delete/records/r1', { token: 'user-token' })).status, 404);
  } finally {
    await harness.close();
  }
});

test('publish projects every record beyond the old 500-document cap', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'many', name: 'Many' });
    const collection = harness.fake.collections.get('synapsedx_capability_records')!;
    const now = new Date().toISOString();
    for (let index = 0; index < 620; index += 1) {
      const id = `m-${String(index).padStart(4, '0')}`;
      const data = { id, datasetId: 'many', data: { index }, createdAt: now, updatedAt: now };
      collection.set(id, { id, data, version: 1, createdAt: now, updatedAt: now });
    }
    const published = await api(harness, '/v1/capabilities/datasets/many/publish', { method: 'POST', token: 'user-token' });
    assert.equal(published.status, 200);
    const datasourceId = published.body.ldsDatasourceId;
    assert.equal(harness.fake.entities.get(datasourceId)!.size, 620);

    const page = await api(harness, '/v1/capabilities/datasets/many/entities?limit=500&offset=500');
    assert.equal(page.status, 200);
    assert.equal(page.body.length, 120);
    assert.equal(page.headers.get('x-lds-total'), '620');
  } finally {
    await harness.close();
  }
});

test('publish and revoke replay the same response and emit one event per transition', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'replay', name: 'Replay' });
    const headers = { 'idempotency-key': 'publish-transition-0001' };
    const first = await api(harness, '/v1/capabilities/datasets/replay/publish', { method: 'POST', token: 'user-token', headers });
    assert.equal(first.status, 200);
    const second = await api(harness, '/v1/capabilities/datasets/replay/publish', { method: 'POST', token: 'user-token', headers });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    const events = harness.fake.queues.get('synapsedx-capability-events') || [];
    assert.equal(events.filter((event: any) => event.type === 'dataset.published').length, 1);

    const revokeHeaders = { 'idempotency-key': 'revoke-transition-0001' };
    const revoked = await api(harness, '/v1/capabilities/datasets/replay/revoke', { method: 'POST', token: 'user-token', headers: revokeHeaders });
    assert.equal(revoked.status, 200);
    const revokedAgain = await api(harness, '/v1/capabilities/datasets/replay/revoke', { method: 'POST', token: 'user-token', headers: revokeHeaders });
    assert.equal(revokedAgain.status, 200);
    assert.equal(harness.fake.queues.get('synapsedx-capability-events')!.filter((event: any) => event.type === 'dataset.revoked').length, 1);
  } finally {
    await harness.close();
  }
});

test('dataset metadata is tenant-scoped and version-preconditioned', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'versioned', name: 'Versioned' });
    const first = await api(harness, '/v1/capabilities/datasets/versioned', { token: 'user-token' });
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const stale = await api(harness, '/v1/capabilities/datasets/versioned', {
      method: 'PATCH', token: 'user-token', body: { name: 'Renamed' }, headers: { 'if-match': '"99"' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.equal(stale.body.error.details.currentVersion, 1);

    const ok = await api(harness, '/v1/capabilities/datasets/versioned', {
      method: 'PATCH', token: 'user-token', body: { name: 'Renamed' }, headers: { 'if-match': etag! },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.name, 'Renamed');
  } finally {
    await harness.close();
  }
});
