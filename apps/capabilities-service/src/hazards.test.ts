// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** KTTV hazard status precedence/freshness (#71) and schedule health (#72). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';
import { setKttvScheduleStateForTests } from './kttv-schedule';

const STATE_COLLECTION = 'synapsedx_kttv_state';

type StatePatch = Record<string, unknown>;

async function putState(harness: any, patch: StatePatch): Promise<void> {
  const now = new Date().toISOString();
  const data = {
    id: 'state',
    tenant: 'service:kttv',
    createdAt: now,
    updatedAt: now,
    last_run_at: null,
    last_success_at: null,
    running: false,
    hazards: 0,
    indexed: 0,
    sources: {},
    error: null,
    ...patch,
  };
  let collection = harness.fake.collections.get(STATE_COLLECTION);
  if (!collection) {
    collection = new Map();
    harness.fake.collections.set(STATE_COLLECTION, collection);
  }
  collection.set('state', { id: 'state', data, version: 1, createdAt: now, updatedAt: now });
}

test('hazard status prefers the latest failure and degrades a stale feed (#71)', async () => {
  const harness = await startHarness({ SYNAPSEDX_HAZARD_STALE_MINUTES: '90' });
  try {
    let status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'unconfigured');
    assert.equal(status.body.stale, false);

    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    await putState(harness, { last_run_at: fresh, last_success_at: fresh, error: null });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'ok');
    assert.equal(status.body.stale, false);
    assert.ok(status.body.last_success_age_seconds >= 0);
    assert.equal(status.body.threshold_minutes, 90);

    // A later failure must not be masked by the earlier successful run.
    const later = new Date().toISOString();
    await putState(harness, { last_run_at: later, last_success_at: fresh, error: 'upstream 503' });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'error');
    assert.equal(status.body.error, 'upstream 503');

    // A running crawl with an old success reports running, not error/stale.
    await putState(harness, {
      running: true,
      last_run_at: later,
      last_success_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
      error: null,
    });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'running');

    // An old success is stale even though it once succeeded.
    const stale = new Date(Date.now() - 91 * 60_000).toISOString();
    await putState(harness, { running: false, last_run_at: stale, last_success_at: stale, error: null });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'stale');
    assert.equal(status.body.stale, true);
    assert.ok(status.body.last_success_age_seconds > 90 * 60);
  } finally {
    await harness.close();
  }
});

test('KTTV schedule health degrades readiness when not provisioned or stale (#72)', async () => {
  const harness = await startHarness({
    SYNAPSEDX_KTTV_SCHEDULE_ENABLED: 'true',
    SYNAPSEDX_HAZARD_STALE_MINUTES: '90',
  });
  try {
    setKttvScheduleStateForTests({
      enabled: true,
      provisioned: false,
      error: 'missing_service_credential',
      lastAttemptAt: new Date().toISOString(),
    });
    let health = await api(harness, '/v1/capabilities/health');
    assert.equal(health.status, 200);
    const kttv = health.body.dependencies.find((dep: any) => dep.name === 'kttv');
    assert.ok(kttv);
    assert.equal(kttv.status, 'degraded');
    assert.equal(kttv.details.provisioned, false);
    let ready = await api(harness, '/v1/capabilities/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.status, 'degraded');

    // Provisioned but no successful crawl yet: still degraded.
    setKttvScheduleStateForTests({
      enabled: true,
      provisioned: true,
      workflowId: 'kttv-workflow',
      error: undefined,
      lastSuccessAt: new Date().toISOString(),
    });
    ready = await api(harness, '/v1/capabilities/ready');
    assert.equal(ready.status, 503);

    // Fresh completed crawl restores readiness.
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    await putState(harness, { last_run_at: fresh, last_success_at: fresh, error: null });
    ready = await api(harness, '/v1/capabilities/ready');
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    health = await api(harness, '/v1/capabilities/health');
    assert.equal(health.body.dependencies.find((dep: any) => dep.name === 'kttv').status, 'ok');

    // A stale feed degrades readiness again.
    const stale = new Date(Date.now() - 3 * 3600_000).toISOString();
    await putState(harness, { last_run_at: stale, last_success_at: stale, error: null });
    ready = await api(harness, '/v1/capabilities/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.dependencies.find((dep: any) => dep.name === 'kttv').details.feedStatus, 'stale');
  } finally {
    await harness.close();
  }
});
