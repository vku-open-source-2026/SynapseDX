// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

test('capability events are consumable from the Tier-2 feed with a cursor', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'feed', name: 'Feed' });
    const first = await api(harness, '/v1/capabilities/datasets/feed/records', {
      method: 'POST', token: 'user-token', body: { id: 'r1', data: { x: 1 } },
    });
    assert.equal(first.status, 201);
    const second = await api(harness, '/v1/capabilities/datasets/feed/records', {
      method: 'POST', token: 'user-token', body: { id: 'r2', data: { x: 2 } },
    });
    assert.equal(second.status, 201);

    const feed = await api(harness, '/v1/capabilities/events?limit=50&datasetId=feed', { token: 'user-token' });
    assert.equal(feed.status, 200);
    const created = feed.body.items.filter((item: any) => item.event.type === 'record.created');
    assert.equal(created.length, 2);
    assert.ok(created[0].event.correlationId);
    assert.equal(created[0].event.schemaVersion, 1);
    assert.ok(feed.body.nextCursor);

    const firstEventId = created[0].id;
    const after = await api(harness, `/v1/capabilities/events?since=${encodeURIComponent(firstEventId)}&datasetId=feed`, { token: 'user-token' });
    const remaining = after.body.items.filter((item: any) => item.event.type === 'record.created');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].event.recordId, 'r2');

    const anonymous = await api(harness, '/v1/capabilities/events');
    assert.equal(anonymous.status, 401);
  } finally {
    await harness.close();
  }
});

test('health reports per-dependency status and readiness fails on a critical outage', async () => {
  const harness = await startHarness();
  try {
    const health = await api(harness, '/v1/capabilities/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    const names = health.body.dependencies.map((dependency: any) => dependency.name);
    for (const name of ['base', 'lds', 'queue', 'iam', 'workflow', 'faststore', 'storage', 'notifications']) assert.ok(names.includes(name));
    for (const dependency of health.body.dependencies) {
      assert.equal(typeof dependency.latency_ms, 'number');
      assert.equal(typeof dependency.critical, 'boolean');
    }

    harness.fake.failBase = true;
    const degraded = await api(harness, '/v1/capabilities/ready');
    assert.equal(degraded.status, 503);
    assert.equal(degraded.body.status, 'down');
    const baseDependency = degraded.body.dependencies.find((dependency: any) => dependency.name === 'base');
    assert.equal(baseDependency.status, 'down');
    assert.equal(baseDependency.error, 'upstream_503');
  } finally {
    await harness.close();
  }
});

test('errors use a stable envelope, hide Tier-1 details and answer JSON 404/405', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'errs', name: 'Errs' });
    const missing = await api(harness, '/v1/capabilities/datasets/errs/records/does-not-exist', { token: 'user-token' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'record_not_found');
    assert.ok(missing.body.error.requestId);
    const serialized = JSON.stringify(missing.body);
    assert.equal(serialized.includes('synapseone'), false);
    assert.equal(serialized.includes('synapsedx_capability_records'), false);
    assert.equal(serialized.includes('/v1/base/'), false);
    assert.equal(missing.headers.get('x-correlation-id'), missing.body.error.requestId);

    const unknown = await api(harness, '/v1/capabilities/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'route_not_found');

    const wrongMethod = await api(harness, '/v1/capabilities/datasets', { method: 'PUT', token: 'user-token' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.error.code, 'method_not_allowed');
    assert.match(String(wrongMethod.headers.get('allow')), /POST/);

    const malformed = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', token: 'user-token', raw: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'invalid_json');
  } finally {
    await harness.close();
  }
});

test('AI, identity, jobs, audit and usage capabilities are reachable through Tier-2', async () => {
  const harness = await startHarness();
  try {
    const status = await api(harness, '/v1/capabilities/ai/status', { token: 'user-token' });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'ok');

    const chat = await api(harness, '/v1/capabilities/ai/chat', {
      method: 'POST', token: 'user-token', body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.body.choices[0].message.content, 'ok');

    const embeddings = await api(harness, '/v1/capabilities/ai/embeddings', {
      method: 'POST', token: 'user-token', body: { input: 'hello' },
    });
    assert.equal(embeddings.status, 200);

    const login = await api(harness, '/v1/capabilities/auth/login', {
      method: 'POST', body: { email: 'operator@example.test' },
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.accessToken);

    const me = await api(harness, '/v1/capabilities/auth/me', { token: 'user-token' });
    assert.equal(me.status, 200);

    const register = await api(harness, '/v1/capabilities/auth/register', {
      method: 'POST', body: { email: 'new@example.test', password: 'correct horse battery' },
    });
    assert.equal(register.status, 201);
    assert.ok(register.body.accessToken);

    const job = await api(harness, '/v1/capabilities/jobs', {
      method: 'POST', token: 'user-token',
      body: { name: 'hazard-expiry', kind: 'hazard-expiry', schedule: { everySeconds: 60 }, payload: { scope: 'hazards' } },
    });
    assert.equal(job.status, 201);
    assert.equal(job.body.enabled, true);
    const workflow = harness.fake.workflows.get(job.body.workflowId);
    assert.ok(workflow);
    assert.equal(workflow!.active, true);

    const run = await api(harness, `/v1/capabilities/jobs/${job.body.id}/run`, { method: 'POST', token: 'user-token' });
    assert.equal(run.status, 200);
    const runs = await api(harness, `/v1/capabilities/jobs/${job.body.id}/runs`, { token: 'user-token' });
    assert.equal(runs.status, 200);
    assert.equal(runs.body.items.length, 1);
    assert.equal(runs.body.items[0].status, 'success');

    const disabled = await api(harness, `/v1/capabilities/jobs/${job.body.id}`, {
      method: 'PATCH', token: 'user-token', body: { enabled: false },
    });
    assert.equal(disabled.status, 200);
    assert.equal(harness.fake.workflows.get(job.body.workflowId)!.active, false);

    await createDataset(harness, { slug: 'audited', name: 'Audited' });
    const audit = await api(harness, '/v1/capabilities/audit?action=dataset.create', { token: 'user-token' });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.items.length, 1);
    assert.equal(audit.body.items[0].datasetId, 'audited');

    const usage = await api(harness, '/v1/capabilities/usage', { token: 'user-token' });
    assert.equal(usage.status, 200);
    assert.equal(usage.body.totals.requests, 3);
  } finally {
    await harness.close();
  }
});

test('files and notifications are live capabilities; unconfigured geo stays a typed 503', async () => {
  const harness = await startHarness();
  try {
    const files = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'a.png', contentType: 'image/png' },
    });
    assert.equal(files.status, 201);
    assert.ok(files.body.id);
    assert.equal(files.body.upload.method, 'PUT');

    const notifications = await api(harness, '/v1/capabilities/notifications', {
      method: 'POST', token: 'user-token', body: { channel: 'sms', to: '+840000', body: 'hello' },
    });
    assert.equal(notifications.status, 202);
    assert.equal(notifications.body.notifications.length, 1);

    const geo = await api(harness, '/v1/capabilities/geo/geocode?address=Hanoi', { token: 'user-token' });
    assert.equal(geo.status, 503);
    assert.equal(geo.body.error.code, 'geocoder_unavailable');

    const anonymous = await api(harness, '/v1/capabilities/files', {
      method: 'POST', body: { filename: 'a.png' },
    });
    assert.equal(anonymous.status, 401);
  } finally {
    await harness.close();
  }
});
