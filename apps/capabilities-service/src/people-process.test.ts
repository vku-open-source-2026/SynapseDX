// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** People/KPI/timesheets (#36), forms/processes (#37) and projects (#38). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

test('people, KPI check-ins and HITL timesheet approval (#36)', async () => {
  const harness = await startHarness();
  try {
    const person = await api(harness, '/v1/capabilities/people', {
      method: 'POST', token: 'user-token',
      body: { subject: 'user-1', name: 'Lan Nguyen', email: 'lan@example.com', manager: 'moderator-1', title: 'Ops lead' },
    });
    assert.equal(person.status, 201, JSON.stringify(person.body));
    const personId = person.body.person.id;

    const kpi = await api(harness, '/v1/capabilities/kpis', {
      method: 'POST', token: 'user-token',
      body: { name: 'Resolve incidents', owner: personId, period: '2026-Q4', start: 0, target: 100, unit: 'incidents' },
    });
    assert.equal(kpi.status, 201, JSON.stringify(kpi.body));
    const kpiId = kpi.body.kpi.id;

    const checkin = await api(harness, `/v1/capabilities/kpis/${kpiId}/checkins`, {
      method: 'POST', token: 'user-token', body: { value: 40, note: 'October' },
    });
    assert.equal(checkin.status, 201);
    assert.equal(checkin.body.progress, 0.4);
    const kpis = await api(harness, '/v1/capabilities/kpis', { token: 'user-token' });
    assert.equal(kpis.body.items[0].latestValue, 40);
    assert.equal(kpis.body.items[0].progress, 0.4);

    const timesheet = await api(harness, '/v1/capabilities/timesheets', {
      method: 'POST', token: 'user-token',
      body: { personId, period: '2026-11', entries: [{ projectId: 'p1', date: '2026-11-02', hours: 8 }, { date: '2026-11-03', hours: 7.5 }] },
    });
    assert.equal(timesheet.status, 201, JSON.stringify(timesheet.body));
    const timesheetId = timesheet.body.timesheet.id;

    const submitted = await api(harness, `/v1/capabilities/timesheets/${timesheetId}/submit`, { method: 'POST', token: 'user-token' });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    assert.equal(submitted.body.timesheet.status, 'submitted');
    assert.equal(submitted.body.approval.status, 'pending');

    const self = await api(harness, `/v1/capabilities/timesheets/${timesheetId}/decide`, {
      method: 'POST', token: 'user-token', body: { decision: 'approve' },
    });
    assert.equal(self.status, 403);
    assert.equal(self.body.error.code, 'self_approval_forbidden');

    const approved = await api(harness, `/v1/capabilities/timesheets/${timesheetId}/decide`, {
      method: 'POST', token: 'moderator-token', body: { decision: 'approve', note: 'ok' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.timesheet.status, 'approved');

    const locked = await api(harness, '/v1/capabilities/timesheets', {
      method: 'POST', token: 'user-token',
      body: { personId, period: '2026-11', entries: [{ date: '2026-11-04', hours: 8 }] },
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, 'period_locked');

    const managerView = await api(harness, '/v1/capabilities/timesheets', { token: 'moderator-token' });
    assert.equal(managerView.body.items.length, 1);
    const outsider = await api(harness, '/v1/capabilities/timesheets', { token: 'read-token' });
    assert.equal(outsider.status, 200);
    assert.equal(outsider.body.items.length, 0);
  } finally {
    await harness.close();
  }
});

test('forms validate conditional fields and process versions pin at start (#37)', async () => {
  const harness = await startHarness();
  try {
    const form = await api(harness, '/v1/capabilities/forms', {
      method: 'POST', token: 'user-token',
      body: {
        name: 'Dispatch request', published: true,
        schema: {
          type: 'object',
          required: ['incident', 'needsAmbulance'],
          properties: {
            incident: { type: 'string' },
            needsAmbulance: { type: 'boolean' },
            ambulanceReason: { type: 'string', visibleWhen: { field: 'needsAmbulance', equals: true } },
            severity: { type: 'number', minimum: 1, maximum: 5 },
          },
        },
      },
    });
    assert.equal(form.status, 201, JSON.stringify(form.body));
    const formId = form.body.form.id;

    const missing = await api(harness, `/v1/capabilities/forms/${formId}/validate`, {
      method: 'POST', token: 'user-token', body: { values: { incident: 'flood', needsAmbulance: true } },
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.valid, false);
    assert.ok(missing.body.errors.some((error: string) => error.includes('ambulanceReason')));

    const hidden = await api(harness, `/v1/capabilities/forms/${formId}/validate`, {
      method: 'POST', token: 'user-token', body: { values: { incident: 'flood', needsAmbulance: false, severity: 3 } },
    });
    assert.equal(hidden.body.valid, true, JSON.stringify(hidden.body));

    const version = await api(harness, `/v1/capabilities/forms/${formId}/versions`, {
      method: 'POST', token: 'user-token', body: { schema: { type: 'object', required: ['incident'], properties: { incident: { type: 'string' } } }, changelog: 'simplify' },
    });
    assert.equal(version.status, 201);
    assert.equal(version.body.form.version, 2);
    assert.equal(version.body.form.versions.length, 1);

    const process = await api(harness, '/v1/capabilities/processes', {
      method: 'POST', token: 'user-token',
      body: {
        name: 'Dispatch approval', published: true,
        nodes: [{ id: 'start', type: 'start' }, { id: 'review', type: 'userTask' }, { id: 'end', type: 'end' }],
        connections: { start: { main: [[{ node: 'review' }]] }, review: { main: [[{ node: 'end' }]] } },
      },
    });
    assert.equal(process.status, 201, JSON.stringify(process.body));
    const processId = process.body.process.id;

    const started = await api(harness, `/v1/capabilities/processes/${processId}/start`, {
      method: 'POST', token: 'user-token', body: { input: { incident: 'INC-1' }, assignment: { mode: 'role', value: 'dispatcher' } },
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.instance.processVersion, 1);
    assert.equal(started.body.instance.assignee, 'role:dispatcher');
    const instanceId = started.body.instance.id;

    const illegal = await api(harness, `/v1/capabilities/process-instances/${instanceId}/transition`, {
      method: 'POST', token: 'user-token', body: { node: 'nowhere' },
    });
    assert.equal(illegal.status, 409);
    assert.equal(illegal.body.error.code, 'invalid_transition');

    const legal = await api(harness, `/v1/capabilities/process-instances/${instanceId}/transition`, {
      method: 'POST', token: 'user-token', body: { node: 'review', action: 'claim' },
    });
    assert.equal(legal.status, 200);
    assert.equal(legal.body.instance.currentNode, 'review');
    const finished = await api(harness, `/v1/capabilities/process-instances/${instanceId}/transition`, {
      method: 'POST', token: 'user-token', body: { node: 'end', action: 'complete' },
    });
    assert.equal(finished.body.instance.status, 'completed');
  } finally {
    await harness.close();
  }
});

test('projects reject cycles, block stage gates and detect over-allocation (#38)', async () => {
  const harness = await startHarness();
  try {
    const badDates = await api(harness, '/v1/capabilities/projects', {
      method: 'POST', token: 'user-token', body: { name: 'Bad', startDate: '2026-12-01', endDate: '2026-11-01' },
    });
    assert.equal(badDates.status, 400);

    const project = await api(harness, '/v1/capabilities/projects', {
      method: 'POST', token: 'user-token',
      body: { name: 'Bridge maintenance', startDate: '2026-11-01', endDate: '2027-03-01', budget: 500000 },
    });
    assert.equal(project.status, 201);
    const projectId = project.body.project.id;

    const a = await api(harness, `/v1/capabilities/projects/${projectId}/tasks`, {
      method: 'POST', token: 'user-token', body: { title: 'Inspect', estimateHours: 16 },
    });
    const b = await api(harness, `/v1/capabilities/projects/${projectId}/tasks`, {
      method: 'POST', token: 'user-token', body: { title: 'Repair', estimateHours: 40 },
    });
    assert.equal(a.status, 201); assert.equal(b.status, 201);

    const dep = await api(harness, `/v1/capabilities/projects/${projectId}/dependencies`, {
      method: 'POST', token: 'user-token', body: { from: a.body.task.id, to: b.body.task.id },
    });
    assert.equal(dep.status, 201);
    const cycle = await api(harness, `/v1/capabilities/projects/${projectId}/dependencies`, {
      method: 'POST', token: 'user-token', body: { from: b.body.task.id, to: a.body.task.id },
    });
    assert.equal(cycle.status, 409);
    assert.equal(cycle.body.error.code, 'dependency_cycle');

    const gate = await api(harness, `/v1/capabilities/projects/${projectId}/gates`, {
      method: 'POST', token: 'user-token', body: { name: 'Design sign-off', order: 2, approverRoles: ['moderator'] },
    });
    assert.equal(gate.status, 201);
    const gateId = gate.body.gate.id;

    const blocked = await api(harness, `/v1/capabilities/projects/${projectId}`, {
      method: 'PATCH', token: 'user-token', body: { stage: 3 },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'stage_gate_blocked');

    const submitted = await api(harness, `/v1/capabilities/projects/${projectId}/gates/${gateId}/submit`, {
      method: 'POST', token: 'user-token',
    });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    const self = await api(harness, `/v1/capabilities/projects/${projectId}/gates/${gateId}/decide`, {
      method: 'POST', token: 'user-token', body: { decision: 'approve' },
    });
    assert.equal(self.status, 403);
    const approved = await api(harness, `/v1/capabilities/projects/${projectId}/gates/${gateId}/decide`, {
      method: 'POST', token: 'moderator-token', body: { decision: 'approve' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const advanced = await api(harness, `/v1/capabilities/projects/${projectId}`, {
      method: 'PATCH', token: 'user-token', body: { stage: 3 },
    });
    assert.equal(advanced.status, 200);

    // Capacity is derived from approved timesheet entries.
    const sheet = await api(harness, '/v1/capabilities/timesheets', {
      method: 'POST', token: 'user-token',
      body: { personId: 'missing', period: '2026-11', entries: [{ projectId, date: '2026-11-02', hours: 8 }] },
    });
    assert.equal(sheet.status, 404);
  } finally {
    await harness.close();
  }
});
