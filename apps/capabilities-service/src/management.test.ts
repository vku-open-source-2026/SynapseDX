// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

test('management context derives additive roles from verified scopes', async () => {
  const harness = await startHarness();
  try {
    const operator = await api(harness, '/v1/capabilities/management/context', { token: 'user-token' });
    assert.equal(operator.status, 200);
    assert.deepEqual(operator.body.roles.sort(), ['manager', 'operator']);
    assert.ok(operator.body.permissions.includes('datasets:write'));
    assert.ok(operator.body.permissions.includes('records:write'));
    assert.equal(operator.body.permissions.includes('moderation:write'), false);

    const reader = await api(harness, '/v1/capabilities/management/context', { token: 'read-token' });
    assert.equal(reader.status, 200);
    assert.deepEqual(reader.body.roles, ['manager']);
    assert.equal(reader.body.permissions.includes('datasets:write'), false);
    assert.ok(reader.body.permissions.includes('audit:read'));

    const moderator = await api(harness, '/v1/capabilities/management/context', { token: 'moderator-token' });
    assert.equal(moderator.status, 200);
    assert.deepEqual(moderator.body.roles.sort(), ['manager', 'moderator']);
    assert.ok(moderator.body.permissions.includes('moderation:write'));

    const admin = await api(harness, '/v1/capabilities/management/context', { token: 'admin-token' });
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.roles, ['admin']);
    assert.ok(admin.body.permissions.includes('users:read'));
    assert.ok(admin.body.permissions.includes('settings:write'));

    assert.equal((await api(harness, '/v1/capabilities/management/context')).status, 401);
  } finally {
    await harness.close();
  }
});

test('operator submits a public draft for review; only a moderator can decide', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'review-me', name: 'Review me', public: true });

    const submitted = await api(harness, '/v1/capabilities/management/datasets/review-me/submit-review', {
      method: 'POST', token: 'user-token', body: { note: 'ready for peer review' },
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.reviewStatus, 'pending');
    assert.ok(submitted.body.reviewSubmittedAt);

    const queue = await api(harness, '/v1/capabilities/management/review-queue', { token: 'moderator-token' });
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.body.items.map((item: any) => item.id), ['review-me']);

    const forbidden = await api(harness, '/v1/capabilities/management/datasets/review-me/approve', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'moderation_forbidden');

    const approved = await api(harness, '/v1/capabilities/management/datasets/review-me/approve', {
      method: 'POST', token: 'moderator-token', body: { note: 'license and schema look good' },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.reviewStatus, 'approved');
    assert.equal(approved.body.reviewedBy, 'moderator-1');
    assert.ok(approved.body.reviewedAt);

    const second = await api(harness, '/v1/capabilities/management/datasets/review-me/approve', {
      method: 'POST', token: 'moderator-token',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'review_not_pending');
  } finally {
    await harness.close();
  }
});

test('reject requires a note and keeps the dataset unpublished', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'reject-me', name: 'Reject me', public: true });
    await api(harness, '/v1/capabilities/management/datasets/reject-me/submit-review', {
      method: 'POST', token: 'user-token',
    });

    const missingNote = await api(harness, '/v1/capabilities/management/datasets/reject-me/reject', {
      method: 'POST', token: 'moderator-token', body: { note: '' },
    });
    assert.equal(missingNote.status, 400);
    assert.equal(missingNote.body.error.code, 'review_note_required');

    const rejected = await api(harness, '/v1/capabilities/management/datasets/reject-me/reject', {
      method: 'POST', token: 'moderator-token', body: { note: 'personal data must be removed' },
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.reviewStatus, 'rejected');
    assert.equal(rejected.body.reviewNote, 'personal data must be removed');
    assert.equal(rejected.body.status, 'draft');
  } finally {
    await harness.close();
  }
});

test('a viewer sees summary counts but not the audit projection', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'viewer-a', name: 'Viewer A', public: true });
    const context = await api(harness, '/v1/capabilities/management/context', { token: 'viewer-token' });
    assert.equal(context.status, 200);
    assert.deepEqual(context.body.roles, ['viewer']);
    assert.equal(context.body.permissions.includes('audit:read'), false);
    const summary = await api(harness, '/v1/capabilities/management/summary', { token: 'viewer-token' });
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.recentAudit, []);
    assert.equal(summary.body.datasets.total, 1);
  } finally {
    await harness.close();
  }
});

test('review lane is tenant-scoped and refuses private or published datasets', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'tenant-a', name: 'Tenant A', public: true });
    const crossTenant = await api(harness, '/v1/capabilities/management/datasets/tenant-a/submit-review', {
      method: 'POST', token: 'other-token',
    });
    assert.equal(crossTenant.status, 404);

    await createDataset(harness, { slug: 'private-draft', name: 'Private', public: false, license: 'LicenseRef-Proprietary' });
    const privateReview = await api(harness, '/v1/capabilities/management/datasets/private-draft/submit-review', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(privateReview.status, 409);
    assert.equal(privateReview.body.error.code, 'dataset_not_public');

    await createDataset(harness, { slug: 'live', name: 'Live', public: true });
    await api(harness, '/v1/capabilities/datasets/live/publish', { method: 'POST', token: 'user-token' });
    const publishedReview = await api(harness, '/v1/capabilities/management/datasets/live/submit-review', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(publishedReview.status, 409);
    assert.equal(publishedReview.body.error.code, 'already_published');
  } finally {
    await harness.close();
  }
});

test('tenant settings enforce review before publication', async () => {
  const harness = await startHarness();
  try {
    const initial = await api(harness, '/v1/capabilities/management/settings', { token: 'admin-token' });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.requireReview, false);
    assert.equal((await api(harness, '/v1/capabilities/management/settings', { token: 'user-token' })).status, 200);

    const changed = await api(harness, '/v1/capabilities/management/settings', {
      method: 'PATCH', token: 'admin-token', body: { requireReview: true },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.settings.requireReview, true);
    assert.equal((await api(harness, '/v1/capabilities/management/settings', { token: 'read-token' })).status, 200);
    assert.equal((await api(harness, '/v1/capabilities/management/settings', {
      method: 'PATCH', token: 'user-token', body: { requireReview: false },
    })).status, 403);

    await createDataset(harness, { slug: 'gated', name: 'Gated', public: true });
    const blocked = await api(harness, '/v1/capabilities/datasets/gated/publish', { method: 'POST', token: 'user-token' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'review_required');

    await api(harness, '/v1/capabilities/management/datasets/gated/submit-review', { method: 'POST', token: 'user-token' });
    await api(harness, '/v1/capabilities/management/datasets/gated/approve', { method: 'POST', token: 'moderator-token' });
    const published = await api(harness, '/v1/capabilities/datasets/gated/publish', { method: 'POST', token: 'user-token' });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'published');
  } finally {
    await harness.close();
  }
});

test('summary reports status and review counts for the caller tenant', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'summary-a', name: 'Summary A', public: true });
    await createDataset(harness, { slug: 'summary-b', name: 'Summary B', public: true });
    await api(harness, '/v1/capabilities/management/datasets/summary-a/submit-review', {
      method: 'POST', token: 'user-token',
    });
    const summary = await api(harness, '/v1/capabilities/management/summary', { token: 'user-token' });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.datasets.total, 2);
    assert.equal(summary.body.datasets.draft, 2);
    assert.equal(summary.body.datasets.pendingReview, 1);
    assert.ok(Array.isArray(summary.body.recentAudit));
    assert.ok(summary.body.recentAudit.some((item: any) => item.action === 'dataset.review.submit'));
    assert.equal(summary.body.datasets.published, 0);
  } finally {
    await harness.close();
  }
});
