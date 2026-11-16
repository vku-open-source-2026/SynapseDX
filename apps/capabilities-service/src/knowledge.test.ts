// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Knowledge re-indexing must preserve chunk lineage and reject unsafe URLs (#83). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

const CHUNKS = 'synapsedx_knowledge_chunks';

test('re-indexing merges chunk metadata, preserves tenant/documentId and removes stale chunks', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/knowledge/documents', {
      method: 'POST', token: 'user-token',
      body: {
        id: 'k-reindex-test',
        title: 'Flood bulletin',
        body: 'A'.repeat(2000),
        source: 'nchmf',
        url: 'https://www.nchmf.gov.vn/bulletin/1',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.chunks, 2);
    const chunks = harness.fake.collections.get(CHUNKS)!;
    const first = chunks.get('k-reindex-test-c0') as any;
    assert.ok(first);
    assert.equal(first.data.tenant, 'org-a');
    assert.equal(first.data.documentId, 'k-reindex-test');

    const reindexed = await api(harness, '/v1/capabilities/knowledge/documents', {
      method: 'POST', token: 'user-token',
      body: {
        id: 'k-reindex-test',
        title: 'Flood bulletin (updated)',
        body: 'B'.repeat(120),
        source: 'nchmf',
        url: 'https://www.nchmf.gov.vn/bulletin/2',
      },
    });
    assert.equal(reindexed.status, 201, JSON.stringify(reindexed.body));
    assert.equal(reindexed.body.chunks, 1);
    const merged = chunks.get('k-reindex-test-c0') as any;
    assert.ok(merged);
    assert.equal(merged.data.tenant, 'org-a');
    assert.equal(merged.data.documentId, 'k-reindex-test');
    assert.equal(merged.data.title, 'Flood bulletin (updated)');
    assert.equal(merged.data.text, 'B'.repeat(120));
    assert.equal(chunks.has('k-reindex-test-c1'), false);
  } finally {
    await harness.close();
  }
});

test('knowledge documents reject private and credential-bearing URLs', async () => {
  const harness = await startHarness();
  try {
    for (const url of [
      'http://127.0.0.1/internal',
      'https://169.254.169.254/latest/meta-data',
      'https://user:pass@example.com/doc',
      'file:///etc/passwd',
    ]) {
      const response = await api(harness, '/v1/capabilities/knowledge/documents', {
        method: 'POST', token: 'user-token',
        body: { title: 'Unsafe', body: 'A'.repeat(40), url },
      });
      assert.equal(response.status, 400, `${url}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, 'invalid_document');
    }
  } finally {
    await harness.close();
  }
});
