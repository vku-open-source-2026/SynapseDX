// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

const RECORDS = 'synapsedx_capability_records';

test('caller-supplied record ids are preserved exactly', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'ids', name: 'Ids' });
    const created = await api(harness, '/v1/capabilities/datasets/ids/records', {
      method: 'POST', token: 'user-token', body: { id: 'AST_001', data: { x: 1 } },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'AST_001');

    const fetched = await api(harness, '/v1/capabilities/datasets/ids/records/AST_001', { token: 'user-token' });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, 'AST_001');

    const updated = await api(harness, '/v1/capabilities/datasets/ids/records/AST_001', {
      method: 'PATCH', token: 'user-token', body: { data: { x: 2 } },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.id, 'AST_001');
    assert.equal(updated.body.version, 2);

    const dotted = await api(harness, '/v1/capabilities/datasets/ids/records', {
      method: 'POST', token: 'user-token', body: { id: 'asset.01@zone+1', data: { x: 1 } },
    });
    assert.equal(dotted.status, 201);
    assert.equal(dotted.body.id, 'asset.01@zone+1');

    const invalid = await api(harness, '/v1/capabilities/datasets/ids/records', {
      method: 'POST', token: 'user-token', body: { id: 'has space', data: { x: 1 } },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_record_id');

    const slash = await api(harness, '/v1/capabilities/datasets/ids/records', {
      method: 'POST', token: 'user-token', body: { id: 'a/b', data: { x: 1 } },
    });
    assert.equal(slash.status, 400);
  } finally {
    await harness.close();
  }
});

test('publish:false withholds a record from the public projection on create and update', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'mixed', name: 'Mixed' });
    await api(harness, '/v1/capabilities/datasets/mixed/publish', { method: 'POST', token: 'user-token' });

    const withheld = await api(harness, '/v1/capabilities/datasets/mixed/records', {
      method: 'POST', token: 'user-token',
      body: { id: 'r-withheld', data: { title: 'pothole', contact_info: { phone: '09' } }, publish: false },
    });
    assert.equal(withheld.status, 201);
    assert.equal(withheld.body.published, false);

    const open = await api(harness, '/v1/capabilities/datasets/mixed/records', {
      method: 'POST', token: 'user-token', body: { id: 'r-open', data: { title: 'lamp' } },
    });
    assert.equal(open.status, 201);

    let entities = await api(harness, '/v1/capabilities/datasets/mixed/entities');
    assert.deepEqual(entities.body.map((entity: any) => entity.recordId), ['r-open']);

    // Editing a withheld record must not publish it.
    const edited = await api(harness, '/v1/capabilities/datasets/mixed/records/r-withheld', {
      method: 'PATCH', token: 'user-token', body: { data: { title: 'pothole', contact_info: { phone: '09' }, comment: 'updated' } },
    });
    assert.equal(edited.status, 200);
    entities = await api(harness, '/v1/capabilities/datasets/mixed/entities');
    assert.deepEqual(entities.body.map((entity: any) => entity.recordId), ['r-open']);

    // Explicit promotion publishes only that record.
    const promoted = await api(harness, '/v1/capabilities/datasets/mixed/records/r-withheld', {
      method: 'PATCH', token: 'user-token', body: { data: { title: 'pothole' }, publish: true },
    });
    assert.equal(promoted.status, 200);
    entities = await api(harness, '/v1/capabilities/datasets/mixed/entities');
    assert.deepEqual(entities.body.map((entity: any) => entity.recordId).sort(), ['r-open', 'r-withheld']);

    // Withdrawing removes the previously projected entity.
    const withdrawn = await api(harness, '/v1/capabilities/datasets/mixed/records/r-withheld', {
      method: 'PATCH', token: 'user-token', body: { data: { title: 'pothole' }, publish: false },
    });
    assert.equal(withdrawn.status, 200);
    entities = await api(harness, '/v1/capabilities/datasets/mixed/entities');
    assert.deepEqual(entities.body.map((entity: any) => entity.recordId), ['r-open']);

    // A withheld record stays withheld after a dataset republish.
    await api(harness, '/v1/capabilities/datasets/mixed/records/r-withheld', {
      method: 'PATCH', token: 'user-token', body: { data: { title: 'still private' } },
    });
    await api(harness, '/v1/capabilities/datasets/mixed/revoke', { method: 'POST', token: 'user-token' });
    await api(harness, '/v1/capabilities/datasets/mixed/publish', { method: 'POST', token: 'user-token' });
    entities = await api(harness, '/v1/capabilities/datasets/mixed/entities');
    assert.deepEqual(entities.body.map((entity: any) => entity.recordId), ['r-open']);
  } finally {
    await harness.close();
  }
});

test('record pagination reports the true total beyond 500 documents', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'big', name: 'Big' });
    const collection = harness.fake.collections.get(RECORDS)!;
    const now = new Date().toISOString();
    for (let index = 0; index < 620; index += 1) {
      const id = `rec-${String(index).padStart(4, '0')}`;
      const data = { id, datasetId: 'big', data: { index }, createdAt: now, updatedAt: now };
      collection.set(id, { id, data, version: 1, createdAt: now, updatedAt: now });
    }
    const page = await api(harness, '/v1/capabilities/datasets/big/records?limit=100&offset=600', { token: 'user-token' });
    assert.equal(page.status, 200);
    assert.equal(page.body.total, 620);
    assert.equal(page.body.items.length, 20);
    assert.equal(page.body.items[0].id, 'rec-0600');

    const first = await api(harness, '/v1/capabilities/datasets/big/records?limit=50', { token: 'user-token' });
    assert.equal(first.body.total, 620);
    assert.ok(first.body.nextCursor);

    const bad = await api(harness, '/v1/capabilities/datasets/big/records?limit=0', { token: 'user-token' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_limit');

    const invalidOffset = await api(harness, '/v1/capabilities/datasets/big/records?offset=-1', { token: 'user-token' });
    assert.equal(invalidOffset.status, 400);
  } finally {
    await harness.close();
  }
});

test('Idempotency-Key deduplicates writes and rejects reuse with a different body', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'idem', name: 'Idem' });
    const first = await api(harness, '/v1/capabilities/datasets/idem/records', {
      method: 'POST', token: 'user-token', headers: { 'idempotency-key': 'create-record-0001' },
      body: { id: 'r1', data: { x: 1 } },
    });
    assert.equal(first.status, 201);
    const replay = await api(harness, '/v1/capabilities/datasets/idem/records', {
      method: 'POST', token: 'user-token', headers: { 'idempotency-key': 'create-record-0001' },
      body: { id: 'r1', data: { x: 1 } },
    });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body);
    const list = await api(harness, '/v1/capabilities/datasets/idem/records', { token: 'user-token' });
    assert.equal(list.body.total, 1);

    const reuse = await api(harness, '/v1/capabilities/datasets/idem/records', {
      method: 'POST', token: 'user-token', headers: { 'idempotency-key': 'create-record-0001' },
      body: { id: 'r2', data: { x: 2 } },
    });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.error.code, 'idempotency_key_reuse');

    const events = harness.fake.queues.get('synapsedx-capability-events') || [];
    assert.equal(events.filter((event: any) => event.type === 'record.created').length, 1);
  } finally {
    await harness.close();
  }
});

test('a queue outage does not fail the write; the event is recovered from the outbox', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'outbox', name: 'Outbox' });
    harness.fake.failQueue = true;
    const created = await api(harness, '/v1/capabilities/datasets/outbox/records', {
      method: 'POST', token: 'user-token', body: { id: 'r1', data: { x: 1 } },
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x-event-status'), 'pending');

    const stored = harness.fake.collections.get('synapsedx_capability_records')?.get('r1');
    assert.ok(stored, 'record must exist despite the event failure');
    const dataset = harness.fake.collections.get('synapsedx_capability_datasets')?.get('outbox');
    assert.equal((dataset?.data.pendingEvents as any[]).length, 1);

    harness.fake.failQueue = false;
    const flushed = await api(harness, '/v1/capabilities/events/outbox/flush?datasetId=outbox', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(flushed.status, 200);
    assert.equal(flushed.body.pending, 0);
  } finally {
    await harness.close();
  }
});

test('bulk create and server-side query keep per-record publication and filters', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'bulk', name: 'Bulk' });
    await api(harness, '/v1/capabilities/datasets/bulk/publish', { method: 'POST', token: 'user-token' });
    const bulk = await api(harness, '/v1/capabilities/datasets/bulk/records/bulk', {
      method: 'POST', token: 'user-token',
      body: {
        records: [
          { id: 'a', data: { status: 'open', priority: 1 } },
          { id: 'b', data: { status: 'closed', priority: 2 }, publish: false },
          { id: 'c', data: { status: 'open', priority: 3 } },
        ],
      },
    });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.created.length, 3);
    assert.equal(bulk.body.errors.length, 0);

    const open = await api(harness, '/v1/capabilities/datasets/bulk/records/query', {
      method: 'POST', token: 'user-token',
      body: { where: { status: 'open' }, orderBy: 'priority:desc', limit: 10 },
    });
    assert.equal(open.status, 200);
    assert.equal(open.body.total, 2);
    assert.deepEqual(open.body.items.map((item: any) => item.id), ['c', 'a']);

    const published = await api(harness, '/v1/capabilities/datasets/bulk/records?publishedOnly=true', { token: 'user-token' });
    assert.deepEqual(published.body.items.map((item: any) => item.id).sort(), ['a', 'c']);

    const entities = await api(harness, '/v1/capabilities/datasets/bulk/entities');
    assert.deepEqual(entities.body.map((entity: any) => entity.recordId).sort(), ['a', 'c']);
  } finally {
    await harness.close();
  }
});

test('records support delete, version preconditions and retention purge', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'life', name: 'Life', retentionDays: 1 });
    await api(harness, '/v1/capabilities/datasets/life/publish', { method: 'POST', token: 'user-token' });

    const created = await api(harness, '/v1/capabilities/datasets/life/records', {
      method: 'POST', token: 'user-token', body: { id: 'keep', data: { x: 1 } },
    });
    assert.equal(created.status, 201);
    const version = created.body.version;

    const stale = await api(harness, '/v1/capabilities/datasets/life/records/keep', {
      method: 'PATCH', token: 'user-token', headers: { 'if-match': '"99"' }, body: { data: { x: 2 } },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');

    const ok = await api(harness, '/v1/capabilities/datasets/life/records/keep', {
      method: 'PATCH', token: 'user-token', headers: { 'if-match': `"${version}"` }, body: { data: { x: 2 } },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version, version + 1);

    const removed = await api(harness, '/v1/capabilities/datasets/life/records/keep', {
      method: 'DELETE', token: 'user-token',
    });
    assert.equal(removed.status, 204);
    assert.equal((await api(harness, '/v1/capabilities/datasets/life/records/keep', { token: 'user-token' })).status, 404);
    assert.equal((await api(harness, '/v1/capabilities/datasets/life/records/keep', { method: 'DELETE', token: 'user-token' })).status, 404);
    const entities = await api(harness, '/v1/capabilities/datasets/life/entities');
    assert.deepEqual(entities.body, []);

    // Deleting a projected record must not break a later publish.
    const republished = await api(harness, '/v1/capabilities/datasets/life/publish', { method: 'POST', token: 'user-token' });
    assert.equal(republished.status, 200);
    assert.deepEqual((await api(harness, '/v1/capabilities/datasets/life/entities')).body, []);

    // Retention: an old record is purged.
    await api(harness, '/v1/capabilities/datasets/life/records', {
      method: 'POST', token: 'user-token', body: { id: 'old', data: { x: 3 } },
    });
    const old = harness.fake.collections.get(RECORDS)!.get('old')!;
    old.data.createdAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    const purged = await api(harness, '/v1/capabilities/datasets/life/records/purge-expired', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(purged.status, 200);
    assert.equal(purged.body.purged, 1);
    assert.equal((await api(harness, '/v1/capabilities/datasets/life/records/old', { token: 'user-token' })).status, 404);
  } finally {
    await harness.close();
  }
});
