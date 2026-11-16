// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness, Harness } from './testing/harness';

function planBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Flood response plan',
    objective: 'Coordinate the response to river flooding in District 1.',
    eventId: 'event-2026-001',
    severity: 'high',
    context: { locale: 'en', region: 'district-1', note: 'secret-context-value' },
    phases: [
      {
        id: 'phase-1',
        title: 'Prepare',
        objective: 'Confirm roles and resources.',
        startOffsetMinutes: 0,
        tasks: [
          { id: 'task-1', title: 'Confirm activation', ownerRole: 'incident_commander', dueOffsetMinutes: 15, dependsOn: [] },
          { id: 'task-2', title: 'Assess the event', ownerRole: 'planning_chief', dueOffsetMinutes: 30, dependsOn: ['task-1'] },
        ],
      },
      {
        id: 'phase-2',
        title: 'Respond',
        startOffsetMinutes: 60,
        tasks: [
          { id: 'task-3', title: 'Deploy teams', ownerRole: 'operations_chief', dueOffsetMinutes: 15, dependsOn: ['task-2'] },
          { id: 'task-4', title: 'Close out the response', dueOffsetMinutes: 30, dependsOn: [] },
        ],
      },
    ],
    ...overrides,
  };
}

async function createPlan(harness: Harness, overrides: Record<string, unknown> = {}, token = 'user-token') {
  return api(harness, '/v1/capabilities/plans', { method: 'POST', token, body: planBody(overrides) });
}

async function activate(harness: Harness, id: string, token = 'user-token', body: Record<string, unknown> = {}) {
  return api(harness, `/v1/capabilities/plans/${id}/activate`, { method: 'POST', token, body });
}

function taskOf(body: any, id: string): any {
  for (const phase of body.plan.phases) {
    const task = phase.tasks.find((entry: any) => entry.id === id);
    if (task) return task;
  }
  return undefined;
}

test('creates, lists, reads and patches a draft plan with tenant isolation', async () => {
  const harness = await startHarness();
  try {
    const created = await createPlan(harness);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.version, 1);
    assert.equal(created.body.plan.status, 'draft');
    assert.equal(created.body.plan.createdBy, 'user-1');
    assert.equal(created.body.plan.tenant, 'org-a');
    assert.equal(created.body.plan.phases.length, 2);
    assert.equal(taskOf(created.body, 'task-1').status, 'pending');
    assert.equal(taskOf(created.body, 'task-1').dueAt, undefined);
    assert.equal(created.headers.get('location'), `/v1/capabilities/plans/${created.body.plan.id}`);
    const id = created.body.plan.id;

    const list = await api(harness, '/v1/capabilities/plans?status=draft', { token: 'user-token' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((item: any) => item.id), [id]);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.limit, 100);
    assert.equal(list.body.nextCursor, null);

    const read = await api(harness, `/v1/capabilities/plans/${id}`, { token: 'user-token' });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('etag'), '"1"');
    assert.equal(read.body.plan.title, 'Flood response plan');

    const patched = await api(harness, `/v1/capabilities/plans/${id}`, {
      method: 'PATCH',
      token: 'user-token',
      headers: { 'if-match': '"1"' },
      body: {
        title: 'Flood response plan (revised)',
        objective: 'Coordinate response and recovery for District 1 flooding.',
        severity: 'critical',
        eventId: 'event-2026-002',
        context: { locale: 'vi', region: 'district-1' },
      },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.version, 2);
    assert.equal(patched.body.plan.title, 'Flood response plan (revised)');
    assert.equal(patched.body.plan.severity, 'critical');
    assert.equal(patched.body.plan.context.locale, 'vi');

    const otherRead = await api(harness, `/v1/capabilities/plans/${id}`, { token: 'other-token' });
    assert.equal(otherRead.status, 404);
    assert.equal(otherRead.body.error.code, 'plan_not_found');
    const otherPatch = await api(harness, `/v1/capabilities/plans/${id}`, {
      method: 'PATCH', token: 'other-token', body: { title: 'stolen plan' },
    });
    assert.equal(otherPatch.status, 404);
    const otherList = await api(harness, '/v1/capabilities/plans', { token: 'other-token' });
    assert.equal(otherList.status, 200);
    assert.equal(otherList.body.total, 0);

    // A deployment administrator may filter by tenant; an organization admin
    // and a plain member cannot widen tenant scope.
    const otherCreated = await createPlan(harness, { title: 'Other tenant plan' }, 'other-token');
    assert.equal(otherCreated.status, 201, JSON.stringify(otherCreated.body));
    const adminOrgA = await api(harness, '/v1/capabilities/plans?tenant=org-a', { apiKey: 'service-key' });
    assert.equal(adminOrgA.status, 200);
    assert.deepEqual(adminOrgA.body.items.map((item: any) => item.id), [id]);
    const adminOrgB = await api(harness, '/v1/capabilities/plans?tenant=org-b', { apiKey: 'service-key' });
    assert.deepEqual(adminOrgB.body.items.map((item: any) => item.id), [otherCreated.body.plan.id]);

    const readerPatch = await api(harness, `/v1/capabilities/plans/${id}`, {
      method: 'PATCH', token: 'read-token', body: { title: 'reader edit' },
    });
    assert.equal(readerPatch.status, 403);
    assert.equal(readerPatch.body.error.code, 'insufficient_scope');

    const methodNotAllowed = await api(harness, `/v1/capabilities/plans/${id}`, { method: 'DELETE', token: 'user-token' });
    assert.equal(methodNotAllowed.status, 405);
    assert.match(String(methodNotAllowed.headers.get('allow')), /GET/);
    const draftNotPost = await api(harness, '/v1/capabilities/plans/draft', { method: 'DELETE', token: 'user-token' });
    assert.equal(draftNotPost.status, 405);
    assert.match(String(draftNotPost.headers.get('allow')), /POST/);

    // Audits are tenant-scoped and never contain the full context payload.
    const auditCollection = harness.fake.collections.get('synapsedx_capability_audit')!;
    const actions = [...auditCollection.values()].map((doc: any) => doc.data.action);
    assert.ok(actions.includes('plan.create'));
    assert.ok(actions.includes('plan.update'));
    const serialized = JSON.stringify([...auditCollection.values()].map((doc: any) => doc.data));
    assert.ok(!serialized.includes('secret-context-value'));
  } finally {
    await harness.close();
  }
});

test('lists plans with offset and cursor pagination and rejects mixed paging', async () => {
  const harness = await startHarness();
  try {
    const ids: string[] = [];
    for (const title of ['Plan one', 'Plan two', 'Plan three']) {
      const created = await createPlan(harness, { title });
      assert.equal(created.status, 201);
      ids.push(created.body.plan.id);
    }

    const first = await api(harness, '/v1/capabilities/plans?limit=1', { token: 'user-token' });
    assert.equal(first.status, 200);
    assert.equal(first.body.total, 3);
    assert.equal(first.body.items.length, 1);
    assert.equal(first.body.limit, 1);
    assert.ok(first.body.nextCursor);
    assert.equal(first.headers.get('x-total-count'), '3');

    const second = await api(harness, '/v1/capabilities/plans?limit=1&offset=1', { token: 'user-token' });
    assert.equal(second.body.items.length, 1);
    assert.notEqual(second.body.items[0].id, first.body.items[0].id);

    const cursor = await api(harness, `/v1/capabilities/plans?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { token: 'user-token' });
    assert.equal(cursor.status, 200);
    assert.equal(cursor.body.items.length, 1);
    assert.notEqual(cursor.body.items[0].id, first.body.items[0].id);

    const mixed = await api(harness, `/v1/capabilities/plans?limit=1&offset=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, { token: 'user-token' });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'pagination_both_offset_and_cursor');
    const badStatus = await api(harness, '/v1/capabilities/plans?status=unknown', { token: 'user-token' });
    assert.equal(badStatus.status, 400);
    const badLimit = await api(harness, '/v1/capabilities/plans?limit=201', { token: 'user-token' });
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.body.error.code, 'invalid_limit');
    assert.deepEqual([...new Set(ids)].length, 3);
  } finally {
    await harness.close();
  }
});

test('validates title, objective, context, phase/task limits, ids, offsets and dependencies', async () => {
  const harness = await startHarness();
  try {
    const invalid = async (overrides: Record<string, unknown>, code = 'invalid_request') => {
      const response = await createPlan(harness, overrides);
      assert.equal(response.status, 400, `${JSON.stringify(overrides).slice(0, 120)} -> ${response.status} ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error.code, code);
    };

    await invalid({ title: 'ab' });
    await invalid({ objective: 'x'.repeat(4001) });
    await invalid({ context: { blob: 'x'.repeat(17_000) } });
    await invalid({ phases: [] });
    await invalid({
      phases: Array.from({ length: 21 }, (_, index) => ({
        id: `p-${index}`, title: 'Phase', startOffsetMinutes: 0,
        tasks: [{ id: `t-${index}`, title: 'Task', dueOffsetMinutes: 0 }],
      })),
    });
    await invalid({
      phases: [
        { id: 'dup', title: 'One', startOffsetMinutes: 0, tasks: [{ id: 't1', title: 'Task', dueOffsetMinutes: 0 }] },
        { id: 'dup', title: 'Two', startOffsetMinutes: 0, tasks: [{ id: 't2', title: 'Task', dueOffsetMinutes: 0 }] },
      ],
    });
    await invalid({
      phases: [
        { id: 'p1', title: 'One', startOffsetMinutes: 0, tasks: [{ id: 'same', title: 'Task', dueOffsetMinutes: 0 }] },
        { id: 'p2', title: 'Two', startOffsetMinutes: 0, tasks: [{ id: 'same', title: 'Task', dueOffsetMinutes: 0 }] },
      ],
    });
    await invalid({
      phases: [
        { id: 'p1', title: 'One', startOffsetMinutes: 0, tasks: [{ id: 't1', title: 'Task', dueOffsetMinutes: 0, dependsOn: ['missing'] }] },
      ],
    });
    await invalid({
      phases: [
        {
          id: 'p1', title: 'One', startOffsetMinutes: 0,
          tasks: [
            { id: 'a', title: 'A', dueOffsetMinutes: 0, dependsOn: ['b'] },
            { id: 'b', title: 'B', dueOffsetMinutes: 0, dependsOn: ['a'] },
          ],
        },
      ],
    }, 'dependency_cycle');
    await invalid({
      phases: [
        { id: 'p1', title: 'One', startOffsetMinutes: 0, tasks: [{ id: 't1', title: 'Task', dueOffsetMinutes: 10_081 }] },
      ],
    });
    await invalid({
      phases: [
        { id: 'p1', title: 'One', startOffsetMinutes: 10_081, tasks: [{ id: 't1', title: 'Task', dueOffsetMinutes: 0 }] },
      ],
    });
    await invalid({
      phases: [{ id: 'p1', title: 'One', startOffsetMinutes: 0, tasks: [] }],
    });
    await invalid({
      phases: [{
        id: 'p1', title: 'One', startOffsetMinutes: 0,
        tasks: Array.from({ length: 51 }, (_, index) => ({ id: `t-${index}`, title: 'Task', dueOffsetMinutes: 0 })),
      }],
    });
    await invalid({
      phases: Array.from({ length: 5 }, (_, phase) => ({
        id: `p-${phase}`,
        title: 'Phase',
        startOffsetMinutes: 0,
        tasks: Array.from({ length: 41 }, (_, task) => ({
          id: `t-${phase}-${task}`, title: 'Task', dueOffsetMinutes: 0,
        })),
      })),
    });
    await invalid({
      phases: [{ id: 'p 1', title: 'One', startOffsetMinutes: 0, tasks: [{ id: 't1', title: 'Task', dueOffsetMinutes: 0 }] }],
    });

    const list = await api(harness, '/v1/capabilities/plans', { token: 'user-token' });
    assert.equal(list.body.total, 0);
  } finally {
    await harness.close();
  }
});

test('activation computes due times, is idempotent and enforces the plan lifecycle', async () => {
  const harness = await startHarness();
  try {
    const created = await createPlan(harness);
    const id = created.body.plan.id;

    const earlyPause = await api(harness, `/v1/capabilities/plans/${id}/pause`, { method: 'POST', token: 'user-token' });
    assert.equal(earlyPause.status, 409);
    assert.equal(earlyPause.body.error.code, 'invalid_transition');
    const earlyComplete = await api(harness, `/v1/capabilities/plans/${id}/complete`, { method: 'POST', token: 'user-token' });
    assert.equal(earlyComplete.status, 409);
    const earlyArchive = await api(harness, `/v1/capabilities/plans/${id}/archive`, { method: 'POST', token: 'user-token' });
    assert.equal(earlyArchive.status, 409);

    const activated = await activate(harness, id);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.plan.status, 'active');
    assert.equal(activated.body.version, 2);
    const activatedAt = activated.body.plan.activatedAt;
    assert.ok(activatedAt);
    const base = Date.parse(activatedAt);
    assert.equal(Date.parse(taskOf(activated.body, 'task-1').dueAt) - base, 15 * 60_000);
    assert.equal(Date.parse(taskOf(activated.body, 'task-2').dueAt) - base, 30 * 60_000);
    assert.equal(Date.parse(taskOf(activated.body, 'task-3').dueAt) - base, (60 + 15) * 60_000);
    assert.equal(Date.parse(taskOf(activated.body, 'task-4').dueAt) - base, (60 + 30) * 60_000);

    // Idempotent retry: no new version and no moved due dates.
    const again = await activate(harness, id);
    assert.equal(again.status, 200);
    assert.equal(again.body.version, 2);
    assert.equal(again.body.plan.activatedAt, activatedAt);
    assert.equal(taskOf(again.body, 'task-1').dueAt, taskOf(activated.body, 'task-1').dueAt);

    const paused = await api(harness, `/v1/capabilities/plans/${id}/pause`, { method: 'POST', token: 'user-token' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.plan.status, 'paused');

    const resumed = await activate(harness, id);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.plan.status, 'active');
    assert.equal(Date.parse(taskOf(resumed.body, 'task-3').dueAt) - Date.parse(resumed.body.plan.activatedAt), 75 * 60_000);

    const archiveActive = await api(harness, `/v1/capabilities/plans/${id}/archive`, { method: 'POST', token: 'user-token' });
    assert.equal(archiveActive.status, 409);

    const completed = await api(harness, `/v1/capabilities/plans/${id}/complete`, { method: 'POST', token: 'user-token' });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.plan.status, 'completed');
    assert.ok(completed.body.plan.completedAt);

    const pauseCompleted = await api(harness, `/v1/capabilities/plans/${id}/pause`, { method: 'POST', token: 'user-token' });
    assert.equal(pauseCompleted.status, 409);

    const archived = await api(harness, `/v1/capabilities/plans/${id}/archive`, { method: 'POST', token: 'user-token' });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.plan.status, 'archived');

    const reactivate = await activate(harness, id);
    assert.equal(reactivate.status, 409);
    assert.equal(reactivate.body.error.code, 'invalid_transition');
    const patchArchived = await api(harness, `/v1/capabilities/plans/${id}`, {
      method: 'PATCH', token: 'user-token', body: { title: 'Cannot edit' },
    });
    assert.equal(patchArchived.status, 409);
    const archivedList = await api(harness, '/v1/capabilities/plans?status=archived', { token: 'user-token' });
    assert.equal(archivedList.body.total, 1);
  } finally {
    await harness.close();
  }
});

test('tasks enforce dependencies, terminal states and the administrator override', async () => {
  const harness = await startHarness();
  try {
    const created = await createPlan(harness);
    const id = created.body.plan.id;
    await activate(harness, id);

    const status = async (taskId: string, body: Record<string, unknown>, token = 'user-token') => api(
      harness,
      `/v1/capabilities/plans/${id}/tasks/${taskId}/status`,
      { method: 'POST', token, body },
    );

    const blockedByDependency = await status('task-2', { status: 'in_progress' });
    assert.equal(blockedByDependency.status, 409);
    assert.equal(blockedByDependency.body.error.code, 'dependency_incomplete');
    assert.deepEqual(blockedByDependency.body.error.details.missing, ['task-1']);

    const nonAdminOverride = await status('task-2', { status: 'in_progress', override: true });
    assert.equal(nonAdminOverride.status, 403);
    assert.equal(nonAdminOverride.body.error.code, 'admin_required');

    const started = await status('task-1', { status: 'in_progress', assignee: 'commander-1' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(taskOf(started.body, 'task-1').status, 'in_progress');
    assert.equal(taskOf(started.body, 'task-1').assignee, 'commander-1');

    const done = await status('task-1', { status: 'done', note: 'roles confirmed' });
    assert.equal(done.status, 200);
    assert.equal(taskOf(done.body, 'task-1').status, 'done');
    assert.ok(taskOf(done.body, 'task-1').completedAt);
    assert.equal(taskOf(done.body, 'task-1').notes, 'roles confirmed');

    const terminal = await status('task-1', { status: 'in_progress' });
    assert.equal(terminal.status, 409);
    assert.equal(terminal.body.error.code, 'invalid_transition');

    const nowAllowed = await status('task-2', { status: 'in_progress' });
    assert.equal(nowAllowed.status, 200);
    const blocked = await status('task-2', { status: 'blocked', note: 'access blocked' });
    assert.equal(blocked.status, 200);
    assert.equal(taskOf(blocked.body, 'task-2').status, 'blocked');

    // A verified organization administrator may override an incomplete
    // dependency; the bypass is recorded in notes and in the audit projection.
    const overridden = await status('task-3', { status: 'in_progress', override: true }, 'admin-token');
    assert.equal(overridden.status, 200, JSON.stringify(overridden.body));
    assert.equal(taskOf(overridden.body, 'task-3').status, 'in_progress');
    assert.match(taskOf(overridden.body, 'task-3').notes, /\[override: task-2 not done; approved by admin-1/);

    const auditCollection = harness.fake.collections.get('synapsedx_capability_audit')!;
    const auditRows = [...auditCollection.values()].map((doc: any) => doc.data)
      .filter((row: any) => row.action === 'plan.task_status' && row.details?.taskId === 'task-3');
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].details.override, true);
    assert.deepEqual(auditRows[0].details.missing, ['task-2']);

    const resumed = await status('task-2', { status: 'in_progress' });
    assert.equal(resumed.status, 200);
    const completedDependency = await status('task-2', { status: 'done' });
    assert.equal(completedDependency.status, 200);
    const task3Done = await status('task-3', { status: 'done' });
    assert.equal(task3Done.status, 200);

    const skipped = await status('task-4', { status: 'skipped', note: 'not needed' });
    assert.equal(skipped.status, 200);
    assert.ok(taskOf(skipped.body, 'task-4').completedAt);
    const skippedTerminal = await status('task-4', { status: 'in_progress' });
    assert.equal(skippedTerminal.status, 409);
    const skippedRetry = await status('task-4', { status: 'skipped' });
    assert.equal(skippedRetry.status, 200);
  } finally {
    await harness.close();
  }
});

test('optimistic concurrency rejects stale If-Match and body versions', async () => {
  const harness = await startHarness();
  try {
    const created = await createPlan(harness);
    const id = created.body.plan.id;

    const first = await api(harness, `/v1/capabilities/plans/${id}`, {
      method: 'PATCH',
      token: 'user-token',
      headers: { 'if-match': '"1"' },
      body: { title: 'Revision one' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);

    const stale = await api(harness, `/v1/capabilities/plans/${id}`, {
      method: 'PATCH',
      token: 'user-token',
      headers: { 'if-match': '"1"' },
      body: { title: 'Revision two' },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');

    const staleBody = await api(harness, `/v1/capabilities/plans/${id}/activate`, {
      method: 'POST', token: 'user-token', body: { ifVersion: 1 },
    });
    assert.equal(staleBody.status, 409);
    assert.equal(staleBody.body.error.code, 'version_conflict');

    const activated = await activate(harness, id, 'user-token', { ifVersion: 2 });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.version, 3);

    const staleTask = await api(harness, `/v1/capabilities/plans/${id}/tasks/task-1/status`, {
      method: 'POST', token: 'user-token', body: { status: 'in_progress', ifVersion: 2 },
    });
    assert.equal(staleTask.status, 409);
    assert.equal(staleTask.body.error.code, 'version_conflict');

    const task = await api(harness, `/v1/capabilities/plans/${id}/tasks/task-1/status`, {
      method: 'POST', token: 'user-token', body: { status: 'in_progress', ifVersion: 3 },
    });
    assert.equal(task.status, 200);
    assert.equal(task.body.version, 4);
  } finally {
    await harness.close();
  }
});

test('brief falls back deterministically when inference is empty or fails', async () => {
  const empty = await startHarness({ FAKE_TIER1_CHAT_REPLY: '' });
  try {
    const created = await createPlan(empty);
    const id = created.body.plan.id;
    await activate(empty, id);
    const brief = await api(empty, `/v1/capabilities/plans/${id}/brief`, {
      method: 'POST', token: 'user-token', body: { focus: 'flood response' },
    });
    assert.equal(brief.status, 200, JSON.stringify(brief.body));
    assert.equal(brief.body.fallback, true);
    assert.equal(brief.body.model, null);
    assert.equal(brief.body.language, 'en');
    assert.equal(brief.body.citations.length, 4);
    assert.deepEqual(brief.body.citations.map((citation: any) => citation.taskId), ['task-1', 'task-2', 'task-3', 'task-4']);
    assert.deepEqual(brief.body.citations.map((citation: any) => citation.index), [1, 2, 3, 4]);
    assert.match(brief.body.brief, /\[T1\]/);
    assert.match(brief.body.brief, /Flood response plan/);
    assert.match(brief.body.brief, /4\/4|0\/4/);
    assert.equal(empty.fake.chatRequests.length, 1);
    const request: any = empty.fake.chatRequests[0];
    assert.equal(request.max_tokens, 450);
    const system = String(request.messages?.[0]?.content || '');
    assert.match(system, /PLAN CONTEXT/);
    assert.match(system, /never use a higher number/);
  } finally {
    await empty.close();
  }

  const failing = await startHarness({ FAKE_TIER1_CHAT_ERROR: 'true' });
  try {
    const created = await createPlan(failing);
    const id = created.body.plan.id;
    const brief = await api(failing, `/v1/capabilities/plans/${id}/brief`, { method: 'POST', token: 'user-token' });
    assert.equal(brief.status, 200);
    assert.equal(brief.body.fallback, true);
    assert.equal(brief.body.model, null);
    assert.match(brief.body.brief, /not been activated/i);
  } finally {
    await failing.close();
  }
});

test('brief uses grounded model content and rejects invented citations', async () => {
  const good = await startHarness({ FAKE_TIER1_CHAT_REPLY: 'The plan is active [T1]. Next due is [T2].' });
  try {
    const created = await createPlan(good, { context: { locale: 'vi', region: 'district-1' } });
    const id = created.body.plan.id;
    const brief = await api(good, `/v1/capabilities/plans/${id}/brief`, { method: 'POST', token: 'user-token' });
    assert.equal(brief.status, 200);
    assert.equal(brief.body.fallback, false);
    assert.equal(brief.body.model, 'fake');
    assert.equal(brief.body.language, 'vi');
    assert.equal(brief.body.brief, 'The plan is active [T1]. Next due is [T2].');
  } finally {
    await good.close();
  }

  const invented = await startHarness({ FAKE_TIER1_CHAT_REPLY: 'A task that does not exist is cited as [T99].' });
  try {
    const created = await createPlan(invented);
    const id = created.body.plan.id;
    const brief = await api(invented, `/v1/capabilities/plans/${id}/brief`, { method: 'POST', token: 'user-token' });
    assert.equal(brief.status, 200);
    assert.equal(brief.body.fallback, true);
    assert.equal(brief.body.model, null);
    assert.doesNotMatch(brief.body.brief, /\[T99\]/);
  } finally {
    await invented.close();
  }
});

test('draft returns a validated model plan and never persists it', async () => {
  const modelDraft = {
    title: 'Flood Response EOP',
    objective: 'The model must not override the requested objective.',
    severity: 'high',
    phases: [
      {
        id: 'p1',
        title: 'Prepare',
        startOffsetMinutes: 0,
        tasks: [
          { id: 't1', title: 'Confirm roles', ownerRole: 'incident_commander', dueOffsetMinutes: 10, dependsOn: [] },
          { id: 't2', title: 'Check resources', ownerRole: 'logistics_chief', dueOffsetMinutes: 20, dependsOn: ['t1'] },
        ],
      },
      {
        id: 'p2',
        title: 'Respond',
        startOffsetMinutes: 30,
        tasks: [
          { id: 't3', title: 'Deploy teams', ownerRole: 'operations_chief', dueOffsetMinutes: 15, dependsOn: ['t2'] },
        ],
      },
    ],
  };
  const harness = await startHarness({
    FAKE_TIER1_CHAT_REPLY: '```json\n' + JSON.stringify(modelDraft) + '\n```',
  });
  try {
    const drafted = await api(harness, '/v1/capabilities/plans/draft', {
      method: 'POST',
      token: 'user-token',
      body: {
        objective: 'Coordinate flood response for District 1.',
        eventType: 'flood',
        context: { region: 'district-1' },
        phaseCount: 2,
      },
    });
    assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
    assert.equal(drafted.body.fallback, false);
    assert.equal(drafted.body.model, 'fake');
    assert.equal(drafted.body.planDraft.title, 'Flood Response EOP');
    assert.equal(drafted.body.planDraft.objective, 'Coordinate flood response for District 1.');
    assert.equal(drafted.body.planDraft.severity, 'high');
    assert.equal(drafted.body.planDraft.context.eventType, 'flood');
    assert.equal(drafted.body.planDraft.context.region, 'district-1');
    assert.equal(drafted.body.planDraft.phases.length, 2);
    assert.equal(drafted.body.planDraft.phases[0].tasks[1].status, 'pending');
    assert.equal(drafted.body.planDraft.phases[0].tasks[1].dueAt, undefined);

    const list = await api(harness, '/v1/capabilities/plans', { token: 'user-token' });
    assert.equal(list.body.total, 0);
    const request: any = harness.fake.chatRequests[0];
    assert.equal(request.max_tokens, 1800);
    assert.match(String(request.messages?.[0]?.content || ''), /STRICT JSON/);
  } finally {
    await harness.close();
  }
});

test('draft falls back to the three-phase template on invalid JSON, invalid plans and inference errors', async () => {
  const invalidJson = await startHarness({ FAKE_TIER1_CHAT_REPLY: 'Sorry, I cannot return JSON today.' });
  try {
    const response = await api(invalidJson, '/v1/capabilities/plans/draft', {
      method: 'POST',
      token: 'user-token',
      body: { objective: 'Coordinate flood response for District 1.', eventType: 'flood', phaseCount: 3 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.fallback, true);
    assert.equal(response.body.model, null);
    assert.equal(response.body.reason, 'invalid_json');
    assert.deepEqual(response.body.planDraft.phases.map((phase: any) => phase.title), ['Prepare', 'Respond', 'Recover']);
    assert.equal(response.body.planDraft.phases.flatMap((phase: any) => phase.tasks).length, 9);
    assert.ok(response.body.planDraft.phases.every((phase: any) => phase.tasks.every((task: any) => task.status === 'pending')));
    assert.equal(response.body.planDraft.context.eventType, 'flood');
  } finally {
    await invalidJson.close();
  }

  const cyclic = await startHarness({
    FAKE_TIER1_CHAT_REPLY: JSON.stringify({
      title: 'Cyclic plan',
      phases: [{
        id: 'p1',
        title: 'Loop',
        startOffsetMinutes: 0,
        tasks: [
          { id: 'a', title: 'A', dueOffsetMinutes: 0, dependsOn: ['b'] },
          { id: 'b', title: 'B', dueOffsetMinutes: 0, dependsOn: ['a'] },
        ],
      }],
    }),
  });
  try {
    const response = await api(cyclic, '/v1/capabilities/plans/draft', {
      method: 'POST', token: 'user-token', body: { objective: 'A plan that must be rejected.', phaseCount: 3 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.fallback, true);
    assert.equal(response.body.reason, 'invalid_plan');
    assert.equal(response.body.planDraft.phases.length, 3);
  } finally {
    await cyclic.close();
  }

  const down = await startHarness({ FAKE_TIER1_CHAT_ERROR: 'true' });
  try {
    const response = await api(down, '/v1/capabilities/plans/draft', {
      method: 'POST', token: 'user-token', body: { objective: 'A plan when inference is down.' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.fallback, true);
    assert.equal(response.body.reason, 'inference_unavailable');
  } finally {
    await down.close();
  }
});

test('draft request limits are enforced before inference', async () => {
  const harness = await startHarness();
  try {
    const invalid = async (body: Record<string, unknown>) => {
      const response = await api(harness, '/v1/capabilities/plans/draft', { method: 'POST', token: 'user-token', body });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'invalid_request');
    };
    await invalid({ phaseCount: 3 });
    await invalid({ objective: '' });
    await invalid({ objective: 'Valid objective', phaseCount: 0 });
    await invalid({ objective: 'Valid objective', phaseCount: 21 });
    await invalid({ objective: 'Valid objective', phaseCount: 2.5 });
    await invalid({ objective: 'Valid objective', context: { blob: 'x'.repeat(17_000) } });
    assert.equal(harness.fake.chatRequests.length, 0);
  } finally {
    await harness.close();
  }
});

test('a Vietnamese plan produces a Vietnamese deterministic fallback', async () => {
  const harness = await startHarness({ FAKE_TIER1_CHAT_REPLY: '' });
  try {
    const created = await createPlan(harness, {
      title: 'Kế hoạch ứng phó lũ',
      objective: 'Điều phối ứng phó lũ tại Quận 1.',
      context: { region: 'quan-1' },
    });
    const id = created.body.plan.id;
    const brief = await api(harness, `/v1/capabilities/plans/${id}/brief`, { method: 'POST', token: 'user-token' });
    assert.equal(brief.status, 200);
    assert.equal(brief.body.language, 'vi');
    assert.equal(brief.body.fallback, true);
    assert.match(brief.body.brief, /^Kế hoạch EOP/);
    assert.match(brief.body.brief, /chưa được kích hoạt/);
  } finally {
    await harness.close();
  }
});
