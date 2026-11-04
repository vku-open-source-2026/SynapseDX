// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

test('anonymous callers see only published public datasets', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'public-dataset', name: 'Public', public: true });
    await createDataset(harness, { slug: 'private-dataset', name: 'Private', public: false, license: 'LicenseRef-Proprietary' });
    const publish = await api(harness, '/v1/capabilities/datasets/public-dataset/publish', { method: 'POST', token: 'user-token' });
    assert.equal(publish.status, 200);

    const list = await api(harness, '/v1/capabilities/datasets');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((item: any) => item.id), ['public-dataset']);
    assert.equal(list.headers.get('x-total-count'), '1');

    const privateRead = await api(harness, '/v1/capabilities/datasets/private-dataset');
    assert.equal(privateRead.status, 404);
    assert.equal(privateRead.body.error.code, 'dataset_not_found');

    const privateCreate = await api(harness, '/v1/capabilities/datasets/private-dataset/records', {
      method: 'POST', body: { data: { secret: true } },
    });
    assert.equal(privateCreate.status, 401);
    assert.equal(privateCreate.body.error.code, 'unauthorized');
  } finally {
    await harness.close();
  }
});

test('writes require a write-capable credential and never fall back to the service key', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness);
    const noCredential = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(noCredential.status, 401);

    const readOnly = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', apiKey: 'read-key',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(readOnly.status, 403);
    assert.equal(readOnly.body.error.code, 'insufficient_scope');

    const invalid = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', token: 'not-a-token',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.error.code, 'invalid_credential');
  } finally {
    await harness.close();
  }
});

test('tenants cannot read or write each other private datasets', async () => {
  const harness = await startHarness();
  try {
    const created = await createDataset(harness, { slug: 'tenant-a', name: 'Tenant A', public: false, license: 'LicenseRef-Proprietary' });
    assert.equal(created.status, 201);
    assert.equal(created.body.tenant, 'acct-a');

    const ownerRead = await api(harness, '/v1/capabilities/datasets/tenant-a', { token: 'user-token' });
    assert.equal(ownerRead.status, 200);

    const otherRead = await api(harness, '/v1/capabilities/datasets/tenant-a', { token: 'other-token' });
    assert.equal(otherRead.status, 404);

    const otherWrite = await api(harness, '/v1/capabilities/datasets/tenant-a/records', {
      method: 'POST', token: 'other-token', body: { data: { x: 1 } },
    });
    assert.equal(otherWrite.status, 404);

    const ownList = await api(harness, '/v1/capabilities/datasets', { token: 'user-token' });
    assert.equal(ownList.body.length, 1);
    const otherList = await api(harness, '/v1/capabilities/datasets', { token: 'other-token' });
    assert.equal(otherList.body.length, 0);
  } finally {
    await harness.close();
  }
});

test('CORS echoes both Tier-3 origins and rejects unknown origins', async () => {
  const harness = await startHarness();
  try {
    for (const origin of ['https://synapsecity.sbs', 'https://sos.synapsecity.sbs']) {
      const response = await api(harness, '/v1/capabilities/datasets', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(String(response.headers.get('access-control-allow-methods')), /DELETE/);
      assert.match(String(response.headers.get('access-control-allow-headers')), /idempotency-key/);
      assert.match(String(response.headers.get('access-control-allow-headers')), /if-match/);
      assert.match(String(response.headers.get('vary') || ''), /Origin/i);
    }
    const unknown = await api(harness, '/v1/capabilities/datasets', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(unknown.headers.get('access-control-allow-origin'), null);
  } finally {
    await harness.close();
  }
});
