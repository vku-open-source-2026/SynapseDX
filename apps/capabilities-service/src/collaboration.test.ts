// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Collaboration inbox/preferences (#32) and workspace/wiki (#35). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';
import { COLLECTIONS } from './platform';

test('mentions create one inbox item and respect muted preferences (#32)', async () => {
  const harness = await startHarness();
  try {
    const comment = await api(harness, '/v1/capabilities/comments', {
      method: 'POST', token: 'user-token', body: {
        module: 'workspace', entityType: 'page', entityId: 'page-1', body: 'Please review @moderator',
        mentions: ['moderator-1'], idempotencyKey: 'comment-once',
      },
    });
    assert.equal(comment.status, 201, JSON.stringify(comment.body));
    const retry = await api(harness, '/v1/capabilities/comments', {
      method: 'POST', token: 'user-token', body: {
        module: 'workspace', entityType: 'page', entityId: 'page-1', body: 'Please review @moderator',
        mentions: ['moderator-1'], idempotencyKey: 'comment-once',
      },
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);

    let inbox = await api(harness, '/v1/capabilities/inbox', { token: 'moderator-token' });
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.items.length, 1);
    assert.equal(inbox.body.unread, 1);
    assert.equal(inbox.body.items[0].delivered, true);
    const itemId = inbox.body.items[0].id;

    const other = await api(harness, '/v1/capabilities/inbox', { token: 'viewer-token' });
    assert.equal(other.body.items.length, 0);

    const read = await api(harness, `/v1/capabilities/inbox/${itemId}/read`, { method: 'POST', token: 'moderator-token' });
    assert.equal(read.status, 200);
    assert.equal(read.body.item.status, 'read');
    inbox = await api(harness, '/v1/capabilities/inbox?status=read', { token: 'moderator-token' });
    assert.equal(inbox.body.items.length, 1);

    const prefs = await api(harness, '/v1/capabilities/notification-preferences', {
      method: 'PUT', token: 'moderator-token',
      body: { muted: true, channels: ['inbox'], digest: 'daily' },
    });
    assert.equal(prefs.status, 200);
    assert.equal(prefs.body.preferences.muted, true);
    const comment2 = await api(harness, '/v1/capabilities/comments', {
      method: 'POST', token: 'user-token',
      body: { module: 'approvals', entityType: 'approval', entityId: 'a-1', body: 'FYI', mentions: ['moderator-1'] },
    });
    assert.equal(comment2.status, 201);
    assert.equal(comment2.body.inbox[0].delivered, false, 'muted users keep the item but skip delivery');
  } finally {
    await harness.close();
  }
});

test('workspace pages version, permissions, backlinks and missing attachments (#35)', async () => {
  const harness = await startHarness();
  try {
    const workspace = await api(harness, '/v1/capabilities/workspaces', {
      method: 'POST', token: 'user-token',
      body: { name: 'City Ops Wiki', para: 'areas', members: [{ subject: 'viewer-1', role: 'viewer' }] },
    });
    assert.equal(workspace.status, 201, JSON.stringify(workspace.body));
    const wsId = workspace.body.workspace.id;

    const page = await api(harness, `/v1/capabilities/workspaces/${wsId}/pages`, {
      method: 'POST', token: 'user-token',
      body: { title: 'Flood plan', markdown: 'See [[Flood plan]] and [[Bridge checklist]].', folder: 'areas', tags: ['flood'] },
    });
    assert.equal(page.status, 201, JSON.stringify(page.body));
    const pageId = page.body.page.id;

    const second = await api(harness, `/v1/capabilities/workspaces/${wsId}/pages`, {
      method: 'POST', token: 'user-token', body: { title: 'Bridge checklist', markdown: 'Inspect [[Flood plan]] every week.' },
    });
    assert.equal(second.status, 201);

    const read = await api(harness, `/v1/capabilities/pages/${pageId}`, { token: 'viewer-token' });
    assert.equal(read.status, 200);
    assert.ok(read.body.page.markdown.includes('Flood plan'));

    const denied = await api(harness, `/v1/capabilities/pages/${pageId}`, {
      method: 'PUT', token: 'viewer-token', body: { markdown: 'nope' },
    });
    assert.equal(denied.status, 403);

    const updated = await api(harness, `/v1/capabilities/pages/${pageId}`, {
      method: 'PUT', token: 'user-token', body: { markdown: 'See [[Flood plan]] and [[Bridge checklist]]. Updated.', ifVersion: 1 },
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.page.versions.length, 1);
    assert.equal(updated.body.page.versions[0].markdown.includes('Updated'), false);

    const conflict = await api(harness, `/v1/capabilities/pages/${pageId}`, {
      method: 'PUT', token: 'user-token', body: { markdown: 'stale', ifVersion: 1 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'version_conflict');

    const withBacklinks = await api(harness, `/v1/capabilities/pages/${pageId}`, { token: 'user-token' });
    assert.deepEqual(withBacklinks.body.backlinks.map((item: any) => item.title), ['Bridge checklist']);

    const search = await api(harness, '/v1/capabilities/page-search?q=bridge', { token: 'viewer-token' });
    assert.equal(search.status, 200);
    assert.ok(search.body.items.some((item: any) => item.title === 'Bridge checklist'));

    const missing = await api(harness, `/v1/capabilities/pages/${pageId}/attachments`, {
      method: 'POST', token: 'user-token', body: { fileId: 'missing-file' },
    });
    assert.equal(missing.status, 404);

    const other = await api(harness, `/v1/capabilities/pages/${pageId}`, { token: 'other-token' });
    assert.equal(other.status, 404);

    const listed = await api(harness, `/v1/capabilities/workspaces/${wsId}/pages`, { token: 'viewer-token' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 2);
    assert.ok(harness.fake.collections.get(COLLECTIONS.pages)?.size === 2);
  } finally {
    await harness.close();
  }
});
