// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

async function createApproval(harness: any, overrides: Record<string, unknown> = {}, token = 'user-token') {
  return api(harness, '/v1/capabilities/approvals', {
    method: 'POST',
    token,
    body: {
      title: 'Approve dispatch',
      module: 'sos.dispatch',
      action: 'dispatch.assign',
      approverRoles: ['moderator'],
      requiredApprovals: 1,
      payload: { unit: 'u1' },
      ...overrides,
    },
  });
}

test('creates, lists and reads a tenant-scoped approval', async () => {
  const harness = await startHarness();
  try {
    const created = await createApproval(harness);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.approval.status, 'pending');
    assert.equal(created.body.approval.requester, 'user-1');
    assert.deepEqual(created.body.approval.decisions, []);

    const list = await api(harness, '/v1/capabilities/approvals?status=pending&mine=requester', { token: 'user-token' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((item: any) => item.id), [created.body.approval.id]);
    const approverList = await api(harness, '/v1/capabilities/approvals?mine=approver', { token: 'moderator-token' });
    assert.equal(approverList.body.items.length, 1);
    const otherTenant = await api(harness, `/v1/capabilities/approvals/${created.body.approval.id}`, { token: 'other-token' });
    assert.equal(otherTenant.status, 404);
  } finally {
    await harness.close();
  }
});

test('separation of duties, approver roles and duplicate decisions are enforced', async () => {
  const harness = await startHarness();
  try {
    const created = await createApproval(harness);
    const id = created.body.approval.id;

    const self = await api(harness, `/v1/capabilities/approvals/${id}/decide`, {
      method: 'POST', token: 'user-token', body: { decision: 'approve' },
    });
    assert.equal(self.status, 403);
    assert.equal(self.body.error.code, 'self_approval_forbidden');

    const reader = await api(harness, `/v1/capabilities/approvals/${id}/decide`, {
      method: 'POST', token: 'read-token', body: { decision: 'approve' },
    });
    assert.equal(reader.status, 403);
    assert.equal(reader.body.error.code, 'approver_role_required');

    const approved = await api(harness, `/v1/capabilities/approvals/${id}/decide`, {
      method: 'POST', token: 'moderator-token', body: { decision: 'approve', note: 'checked' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.approval.status, 'approved');
    assert.equal(approved.body.approval.decisions[0].actor, 'moderator-1');

    const duplicate = await api(harness, `/v1/capabilities/approvals/${id}/decide`, {
      method: 'POST', token: 'moderator-token', body: { decision: 'approve' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'approval_not_pending');
  } finally {
    await harness.close();
  }
});

test('required approvals accumulate and a reject closes the request', async () => {
  const harness = await startHarness();
  try {
    const two = await createApproval(harness, { requiredApprovals: 2, approverRoles: ['moderator', 'admin'] });
    const id = two.body.approval.id;
    const first = await api(harness, `/v1/capabilities/approvals/${id}/decide`, {
      method: 'POST', token: 'moderator-token', body: { decision: 'approve' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.approval.status, 'pending');
    const second = await api(harness, `/v1/capabilities/approvals/${id}/decide`, {
      method: 'POST', token: 'admin-token', body: { decision: 'approve' },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.approval.status, 'approved');

    const rejected = await createApproval(harness, { title: 'Reject me', requiredApprovals: 1 });
    const reject = await api(harness, `/v1/capabilities/approvals/${rejected.body.approval.id}/decide`, {
      method: 'POST', token: 'moderator-token', body: { decision: 'reject', note: 'unsafe' },
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.approval.status, 'rejected');
  } finally {
    await harness.close();
  }
});

test('only the requester or an administrator can cancel a pending approval', async () => {
  const harness = await startHarness();
  try {
    const created = await createApproval(harness);
    const id = created.body.approval.id;
    const denied = await api(harness, `/v1/capabilities/approvals/${id}/cancel`, { method: 'POST', token: 'moderator-token' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'cancel_forbidden');
    const cancelled = await api(harness, `/v1/capabilities/approvals/${id}/cancel`, { method: 'POST', token: 'user-token' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.approval.status, 'cancelled');
    const again = await api(harness, `/v1/capabilities/approvals/${id}/cancel`, { method: 'POST', token: 'user-token' });
    assert.equal(again.status, 409);
  } finally {
    await harness.close();
  }
});
