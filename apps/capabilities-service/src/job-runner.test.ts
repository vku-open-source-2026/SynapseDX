// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

function forceDue(harness: any, jobId: string): void {
  const docs = harness.fake.collections.get('synapsedx_capability_jobs');
  const doc = docs.get(jobId);
  doc.data.nextRunAt = new Date(Date.now() - 60_000).toISOString();
}

test('runner jobs expose a lease/run-now/complete contract for Tier-3 domain runners', async () => {
  const harness = await startHarness();
  try {
    const kinds = await api(harness, '/v1/capabilities/jobs/kinds', { token: 'user-token' });
    assert.equal(kinds.status, 200);
    const names = kinds.body.items.map((item: any) => item.kind);
    for (const kind of ['vndms.ingest', 'hazard.expire', 'report.generate']) assert.ok(names.includes(kind));

    const created = await api(harness, '/v1/capabilities/jobs', {
      method: 'POST', token: 'user-token',
      body: {
        name: 'vndms-live', kind: 'vndms.ingest', executor: 'runner',
        schedule: { everySeconds: 10 }, maxAttempts: 2,
        payload: { url: 'https://vndms.example/feed.json', district: 'Hai Chau' },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.executor, 'runner');
    assert.equal(created.body.workflowId, '');
    assert.ok(created.body.nextRunAt);
    const jobId = created.body.id;

    const notDue = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'city-runner' },
    });
    assert.equal(notDue.status, 200);
    assert.equal(notDue.body.count, 0);

    forceDue(harness, jobId);
    const leased = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'city-runner', leaseSeconds: 60 },
    });
    assert.equal(leased.status, 200);
    assert.equal(leased.body.count, 1);
    const lease = leased.body.leases[0];
    assert.equal(lease.jobId, jobId);
    assert.equal(lease.kind, 'vndms.ingest');
    assert.equal(lease.payload.district, 'Hai Chau');
    assert.equal(lease.attempt, 1);
    assert.ok(lease.leaseToken);
    assert.ok(lease.leaseExpiresAt);

    const doubleLease = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'other-runner' },
    });
    assert.equal(doubleLease.body.count, 0);

    const wrongHeartbeat = await api(harness, `/v1/capabilities/jobs/${jobId}/runs/${lease.runId}/heartbeat`, {
      method: 'POST', token: 'user-token', body: { leaseToken: 'wrong' },
    });
    assert.equal(wrongHeartbeat.status, 409);
    assert.equal(wrongHeartbeat.body.error.code, 'job_lease_invalid');

    const heartbeat = await api(harness, `/v1/capabilities/jobs/${jobId}/runs/${lease.runId}/heartbeat`, {
      method: 'POST', token: 'user-token', body: { leaseToken: lease.leaseToken, leaseSeconds: 120 },
    });
    assert.equal(heartbeat.status, 200);
    assert.ok(heartbeat.body.leaseExpiresAt);

    const completed = await api(harness, `/v1/capabilities/jobs/${jobId}/runs/${lease.runId}/complete`, {
      method: 'POST', token: 'user-token',
      body: { leaseToken: lease.leaseToken, status: 'succeeded', summary: { records: 12 } },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.retry, false);
    assert.equal(completed.body.run.status, 'succeeded');
    assert.deepEqual(completed.body.run.summary, { records: 12 });

    const job = await api(harness, `/v1/capabilities/jobs/${jobId}`, { token: 'user-token' });
    assert.equal(job.status, 200);
    assert.equal(job.body.lastStatus, 'succeeded');
    assert.ok(job.body.lastRunAt);

    const runs = await api(harness, `/v1/capabilities/jobs/${jobId}/runs`, { token: 'user-token' });
    assert.equal(runs.status, 200);
    assert.equal(runs.body.total, 1);
    assert.equal(runs.body.items[0].status, 'succeeded');
    assert.equal(runs.body.items[0].attempt, 1);

    const afterComplete = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'city-runner' },
    });
    assert.equal(afterComplete.body.count, 0);
  } finally {
    await harness.close();
  }
});

test('runner run-now queues work and failures retry up to maxAttempts', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/jobs', {
      method: 'POST', token: 'user-token',
      body: {
        name: 'hazard-expiry', kind: 'hazard.expire', executor: 'runner',
        schedule: { cron: '*/5 * * * *' }, maxAttempts: 2,
        payload: { ttlMinutes: 60 },
      },
    });
    assert.equal(created.status, 201);
    const jobId = created.body.id;

    const runNow = await api(harness, `/v1/capabilities/jobs/${jobId}/run`, { method: 'POST', token: 'user-token' });
    assert.equal(runNow.status, 202);
    assert.equal(runNow.body.status, 'queued');
    const duplicate = await api(harness, `/v1/capabilities/jobs/${jobId}/run`, { method: 'POST', token: 'user-token' });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.deduplicated, true);
    assert.equal(duplicate.body.runId, runNow.body.runId);

    const firstLease = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'sos-runner' },
    });
    assert.equal(firstLease.body.count, 1);
    const first = firstLease.body.leases[0];
    assert.equal(first.attempt, 1);

    const failed = await api(harness, `/v1/capabilities/jobs/${jobId}/runs/${first.runId}/complete`, {
      method: 'POST', token: 'user-token',
      body: { leaseToken: first.leaseToken, status: 'failed', error: 'feed timeout' },
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.retry, true);
    assert.ok(failed.body.retryAt);

    const retryLease = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'sos-runner' },
    });
    assert.equal(retryLease.body.count, 1);
    const retry = retryLease.body.leases[0];
    assert.equal(retry.attempt, 2);
    assert.equal(retry.runId !== first.runId, true);

    const dead = await api(harness, `/v1/capabilities/jobs/${jobId}/runs/${retry.runId}/complete`, {
      method: 'POST', token: 'user-token',
      body: { leaseToken: retry.leaseToken, status: 'failed', error: 'still failing' },
    });
    assert.equal(dead.status, 200);
    assert.equal(dead.body.retry, false);
    assert.equal(dead.body.run.status, 'dead');

    const job = await api(harness, `/v1/capabilities/jobs/${jobId}`, { token: 'user-token' });
    assert.equal(job.body.lastStatus, 'dead');
    assert.equal(job.body.lastError, 'still failing');

    const runs = await api(harness, `/v1/capabilities/jobs/${jobId}/runs`, { token: 'user-token' });
    assert.equal(runs.body.total, 2);
    assert.deepEqual(runs.body.items.map((item: any) => item.attempt).sort(), [1, 2]);
  } finally {
    await harness.close();
  }
});

test('an expired runner lease is reclaimed with a new attempt', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/jobs', {
      method: 'POST', token: 'user-token',
      body: {
        name: 'expiry-reclaim', kind: 'hazard.expire', executor: 'runner',
        schedule: { everySeconds: 30 }, maxAttempts: 3, payload: { ttlMinutes: 5 },
      },
    });
    assert.equal(created.status, 201);
    const jobId = created.body.id;
    await api(harness, `/v1/capabilities/jobs/${jobId}/run`, { method: 'POST', token: 'user-token' });

    const first = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'crashing-runner', leaseSeconds: 10 },
    });
    assert.equal(first.body.count, 1);
    assert.equal(first.body.leases[0].attempt, 1);

    const runs = harness.fake.collections.get('synapsedx_capability_job_runs')!;
    const stored = [...runs.values()].find((doc: any) => doc.id === first.body.leases[0].runId)!;
    stored.data.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();

    const reclaimed = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'user-token', body: { runnerId: 'healthy-runner' },
    });
    assert.equal(reclaimed.body.count, 1);
    assert.equal(reclaimed.body.leases[0].attempt, 2);
    assert.equal(reclaimed.body.leases[0].runId, first.body.leases[0].runId);
  } finally {
    await harness.close();
  }
});

test('runner jobs are tenant-scoped and deleting one cancels queued work', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/jobs', {
      method: 'POST', token: 'user-token',
      body: {
        name: 'daily-report', kind: 'report.generate', executor: 'runner',
        schedule: { cron: '@daily' }, payload: { reportType: 'daily-summary', format: 'json' },
      },
    });
    assert.equal(created.status, 201);
    const jobId = created.body.id;

    const otherGet = await api(harness, `/v1/capabilities/jobs/${jobId}`, { token: 'other-token' });
    assert.equal(otherGet.status, 404);
    const otherLease = await api(harness, '/v1/capabilities/jobs/lease', {
      method: 'POST', token: 'other-token', body: { runnerId: 'other-runner' },
    });
    assert.equal(otherLease.status, 200);
    assert.equal(otherLease.body.count, 0);

    const runNow = await api(harness, `/v1/capabilities/jobs/${jobId}/run`, { method: 'POST', token: 'user-token' });
    assert.equal(runNow.status, 202);
    const deleted = await api(harness, `/v1/capabilities/jobs/${jobId}`, { method: 'DELETE', token: 'user-token' });
    assert.equal(deleted.status, 204);

    const runs = harness.fake.collections.get('synapsedx_capability_job_runs');
    assert.ok(runs);
    const queued = [...runs!.values()].find((doc: any) => doc.data.jobId === jobId);
    assert.ok(queued);
    assert.equal(queued!.data.status, 'cancelled');
  } finally {
    await harness.close();
  }
});
