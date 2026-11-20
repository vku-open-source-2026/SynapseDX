// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** KTTV hazard status precedence/freshness (#71, #72) and source outcomes (#84). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';
import { setKttvScheduleStateForTests } from './kttv-schedule';
import { runKttvCrawl } from './routes/hazards';
import { CrawledDocument, CrawledHazard } from './crawlers/kttv';

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

async function readState(harness: any): Promise<Record<string, unknown>> {
  const collection = harness.fake.collections.get(STATE_COLLECTION);
  const doc = collection?.get('state');
  return (doc?.data || {}) as Record<string, unknown>;
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

test('hazard status distinguishes ok, degraded, error and stale source outcomes (#84)', async () => {
  const harness = await startHarness({ SYNAPSEDX_HAZARD_STALE_MINUTES: '90' });
  try {
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();

    // All configured sources healthy: ok, and the outcomes are exposed.
    await putState(harness, {
      last_run_at: fresh,
      last_success_at: fresh,
      error: null,
      sources: { nchmf_ok: true, sourceOk: true, nchmf: 2, vndms: 1, vndmsDocuments: 0 },
    });
    let status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'ok');
    assert.deepEqual(status.body.sources, { nchmf_ok: true, sourceOk: true, nchmf: 2, vndms: 1, vndmsDocuments: 0 });

    // One source down, the other still reporting: degraded, not ok.
    await putState(harness, {
      last_run_at: fresh,
      last_success_at: fresh,
      error: null,
      sources: { nchmf_ok: false, sourceOk: true, nchmf: 0, vndms: 1, vndmsDocuments: 0 },
    });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'degraded');
    assert.equal(status.body.sources.nchmf_ok, false);
    assert.equal(status.body.sources.sourceOk, true);

    // Every source failed on the latest run: error even with a recent success.
    const later = new Date().toISOString();
    await putState(harness, {
      last_run_at: later,
      last_success_at: fresh,
      error: 'all sources failed',
      sources: { nchmf_ok: false, sourceOk: false, nchmf: 0, vndms: 0, vndmsDocuments: 0 },
    });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'error');
    assert.equal(status.body.error, 'all sources failed');

    // A running crawl outranks a degraded latest outcome.
    await putState(harness, {
      running: true,
      last_run_at: later,
      last_success_at: fresh,
      error: null,
      sources: { nchmf_ok: false, sourceOk: true },
    });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'running');

    // Healthy sources but an old success: stale (degraded does not mask it).
    const stale = new Date(Date.now() - 91 * 60_000).toISOString();
    await putState(harness, {
      last_run_at: stale,
      last_success_at: stale,
      error: null,
      sources: { nchmf_ok: true, sourceOk: true },
    });
    status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'stale');
  } finally {
    await harness.close();
  }
});

test('a total KTTV source outage is an error, not a fresh successful run (#84)', async () => {
  const harness = await startHarness({ SYNAPSEDX_HAZARD_STALE_MINUTES: '90' });
  try {
    // Seed a previous successful run: the outage must not overwrite its
    // success timestamp, or the feed would look fresh with zero sources.
    const previous = new Date(Date.now() - 10 * 60_000).toISOString();
    await putState(harness, { last_run_at: previous, last_success_at: previous, error: null });

    const outageCrawl = async () => ({
      hazards: [] as CrawledHazard[],
      documents: [] as CrawledDocument[],
      stats: {
        nchmf: 0,
        vndms: 0,
        vndmsDocuments: 0,
        nchmf_ok: false,
        sourceOk: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    });
    const result = await runKttvCrawl(harness.config, outageCrawl);
    assert.equal(result.error, 'all sources failed');
    assert.equal(result.hazards, 0);
    assert.equal(result.sources.nchmf_ok, false);
    assert.equal(result.sources.sourceOk, false);

    const state = await readState(harness);
    assert.equal(state.error, 'all sources failed');
    assert.equal(state.running, false);
    // No success refresh: the previous timestamp survives the outage.
    assert.equal(state.last_success_at, previous);

    const status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'error');
    assert.equal(status.body.error, 'all sources failed');
    assert.equal(status.body.last_success_age_seconds !== null, true);
  } finally {
    await harness.close();
  }
});

test('a partial KTTV source outage refreshes the success and degrades the feed (#84)', async () => {
  const harness = await startHarness({ SYNAPSEDX_HAZARD_STALE_MINUTES: '90' });
  try {
    const hazard: CrawledHazard = {
      hazard_id: 'nchmf-outage-check',
      title: 'Cảnh báo lũ quét vùng núi phía Bắc',
      description: 'Cảnh báo lũ quét trên các tỉnh vùng núi.',
      event_type: 'flood',
      severity: 'medium',
      source: 'nchmf',
      url: 'https://www.nchmf.gov.vn/kttv/x-post1.html',
      published_at: new Date().toISOString(),
      provinces: ['Hà Giang'],
      geometry: null,
      text: 'Cảnh báo lũ quét sạt lở đất tại vùng núi provinces.',
      hash: 'outage-check-hash',
      approximate_geometry: true,
    };
    const partialCrawl = async () => ({
      hazards: [hazard],
      documents: [] as CrawledDocument[],
      stats: {
        nchmf: 1,
        vndms: 0,
        vndmsDocuments: 0,
        nchmf_ok: true,
        sourceOk: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    });
    const result = await runKttvCrawl(harness.config, partialCrawl);
    assert.equal(result.error, null);
    assert.equal(result.hazards, 1);

    const state = await readState(harness);
    assert.equal(state.error, null);
    assert.ok(state.last_success_at);
    const sources = state.sources as Record<string, unknown>;
    assert.equal(sources.nchmf, 1);
    assert.equal(sources.vndms, 0);
    assert.equal(sources.nchmf_ok, true);
    assert.equal(sources.sourceOk, false);

    const status = await api(harness, '/v1/capabilities/hazards/status', { token: 'user-token' });
    assert.equal(status.body.status, 'degraded');
    assert.equal(status.body.error, null);
  } finally {
    await harness.close();
  }
});
