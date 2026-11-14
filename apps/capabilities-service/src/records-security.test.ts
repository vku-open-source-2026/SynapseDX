// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Cross-tenant write isolation and row-level publication.
 *
 * Regression: write authorization used to be `canWriteDataset = canReadRecords`,
 * and `canReadRecords` returns true for *any* public published dataset before
 * the tenant check. An organization-B operator could therefore mutate
 * organization-A's public data.
 *
 * Also: an explicitly unpublished row (`published: false`) used to leak to any
 * authenticated reader of a public dataset on list/query/single-GET, and the
 * caller could disable the filter with `publishedOnly=false`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

async function publicPublishedDataset(harness: Awaited<ReturnType<typeof startHarness>>, slug = 'shared-public') {
  const created = await createDataset(harness, { slug, name: 'Shared public', public: true });
  assert.equal(created.status, 201);
  const published = await api(harness, `/v1/capabilities/datasets/${slug}/publish`, { method: 'POST', token: 'user-token' });
  assert.equal(published.status, 200);
  return created.body;
}

test('a foreign organization admin cannot write another tenant public dataset', async () => {
  const harness = await startHarness();
  try {
    await publicPublishedDataset(harness);

    const foreign = [
      { method: 'POST', path: '/v1/capabilities/datasets/shared-public/records', body: { data: { injected: true } } },
      { method: 'PATCH', path: '/v1/capabilities/datasets/shared-public', body: { description: 'tampered' } },
      { method: 'POST', path: '/v1/capabilities/datasets/shared-public/revoke', body: {} },
      { method: 'DELETE', path: '/v1/capabilities/datasets/shared-public' },
    ] as const;

    for (const request of foreign) {
      const response = await api(harness, request.path, {
        method: request.method,
        token: 'other-admin-token',
        ...('body' in request ? { body: request.body } : {}),
      });
      assert.equal(response.status, 404, `${request.method} ${request.path} must be a cross-tenant 404`);
    }

    // The owning tenant keeps write access to the same public dataset.
    const ownerWrite = await api(harness, '/v1/capabilities/datasets/shared-public/records', {
      method: 'POST', token: 'user-token', body: { data: { owner: true } },
    });
    assert.equal(ownerWrite.status, 201);

    const ownerPatch = await api(harness, '/v1/capabilities/datasets/shared-public', {
      method: 'PATCH', token: 'user-token', body: { description: 'owned' },
    });
    assert.equal(ownerPatch.status, 200);
  } finally {
    await harness.close();
  }
});

test('unpublished rows never leak to projection readers or via publishedOnly=false', async () => {
  const harness = await startHarness();
  try {
    await publicPublishedDataset(harness, 'draft-rows');

    const publishedRow = await api(harness, '/v1/capabilities/datasets/draft-rows/records', {
      method: 'POST', token: 'user-token', body: { data: { label: 'published' }, publish: true },
    });
    assert.equal(publishedRow.status, 201);
    const draftRow = await api(harness, '/v1/capabilities/datasets/draft-rows/records', {
      method: 'POST', token: 'user-token', body: { data: { label: 'draft' }, publish: false },
    });
    assert.equal(draftRow.status, 201);

    // A same-tenant member without a data role is a projection reader.
    for (const query of ['', '?publishedOnly=false', '?publishedOnly=true']) {
      const list = await api(harness, `/v1/capabilities/datasets/draft-rows/records${query}`, { token: 'member-token' });
      assert.equal(list.status, 200, query);
      assert.deepEqual(list.body.items.map((item: any) => item.data.label), ['published'], `list ${query}`);
    }

    const draftById = await api(harness, `/v1/capabilities/datasets/draft-rows/records/${draftRow.body.id}`, { token: 'member-token' });
    assert.equal(draftById.status, 404);

    const queried = await api(harness, '/v1/capabilities/datasets/draft-rows/records/query', {
      method: 'POST', token: 'member-token', body: { where: {} },
    });
    assert.equal(queried.status, 200);
    assert.deepEqual(queried.body.items.map((item: any) => item.data.label), ['published']);

    // The owning tenant (operator authority) may read its own drafts.
    const ownerList = await api(harness, '/v1/capabilities/datasets/draft-rows/records', { token: 'user-token' });
    assert.deepEqual(ownerList.body.items.map((item: any) => item.data.label).sort(), ['draft', 'published']);
    const ownerDraft = await api(harness, `/v1/capabilities/datasets/draft-rows/records/${draftRow.body.id}`, { token: 'user-token' });
    assert.equal(ownerDraft.status, 200);

    // The public entity projection stays published-only as well.
    const entities = await api(harness, '/v1/capabilities/datasets/draft-rows/entities');
    assert.equal(entities.status, 200);
    assert.deepEqual(entities.body.map((item: any) => item.data.label), ['published']);
  } finally {
    await harness.close();
  }
});

test('a foreign tenant reading a public dataset only sees published rows', async () => {
  const harness = await startHarness();
  try {
    await publicPublishedDataset(harness, 'foreign-read');
    const foreign = await api(harness, '/v1/capabilities/datasets/foreign-read/records', { token: 'other-admin-token' });
    // Public+published data is readable by design, but the row filter still
    // applies: no drafts for a foreign tenant, and no rows here yet.
    assert.equal(foreign.status, 200);
    assert.deepEqual(foreign.body.items, []);
  } finally {
    await harness.close();
  }
});
