// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Dataset contracts/quality/lineage (#40) and reports/dashboards (#39). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';

test('contracts reject incompatible schema changes unless a migration is recorded (#40)', async () => {
  const harness = await startHarness();
  try {
    const dataset = await createDataset(harness, { slug: 'contract-data', public: false });
    assert.equal(dataset.status, 201);
    const id = dataset.body.id;

    const first = await api(harness, `/v1/capabilities/datasets/${id}/contract`, {
      method: 'POST', token: 'user-token',
      body: {
        schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
        semanticTypes: { id: 'identifier', name: 'label' }, compatibility: 'backward', license: 'CC-BY-4.0',
      },
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.contract.version, 1);

    const incompatible = await api(harness, `/v1/capabilities/datasets/${id}/contract`, {
      method: 'POST', token: 'user-token',
      body: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, compatibility: 'full' },
    });
    assert.equal(incompatible.status, 409);
    assert.equal(incompatible.body.error.code, 'incompatible_schema');

    const migrated = await api(harness, `/v1/capabilities/datasets/${id}/contract`, {
      method: 'POST', token: 'user-token',
      body: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, compatibility: 'full', migration: true },
    });
    assert.equal(migrated.status, 201, JSON.stringify(migrated.body));
    assert.equal(migrated.body.contract.version, 2);

    const read = await api(harness, `/v1/capabilities/datasets/${id}/contract`, { token: 'user-token' });
    assert.equal(read.status, 200);
    assert.equal(read.body.versions.length, 2);
    const foreign = await api(harness, `/v1/capabilities/datasets/${id}/contract`, { token: 'other-token' });
    assert.equal(foreign.status, 404);
  } finally {
    await harness.close();
  }
});

test('quality rules run over records and block publication when configured (#40)', async () => {
  const harness = await startHarness();
  try {
    const dataset = await createDataset(harness, { slug: 'quality-data', public: false });
    const id = dataset.body.id;
    const records = [
      { id: 'r1', data: { email: 'a@example.com', score: 4 } },
      { id: 'r2', data: { email: '', score: 9 } },
    ];
    for (const record of records) {
      const created = await api(harness, `/v1/capabilities/datasets/${id}/records`, { method: 'POST', token: 'user-token', body: record });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    const rules = await api(harness, `/v1/capabilities/datasets/${id}/quality/rules`, {
      method: 'PUT', token: 'user-token',
      body: {
        blockPublication: true,
        rules: [
          { name: 'email required', type: 'required', field: 'email' },
          { name: 'score range', type: 'range', field: 'score', min: 1, max: 5 },
        ],
      },
    });
    assert.equal(rules.status, 200, JSON.stringify(rules.body));

    const run = await api(harness, `/v1/capabilities/datasets/${id}/quality/run`, { method: 'POST', token: 'user-token' });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.equal(run.body.run.status, 'failed');
    assert.equal(run.body.run.failed, 2);

    const published = await api(harness, `/v1/capabilities/datasets/${id}/publish`, { method: 'POST', token: 'user-token' });
    assert.equal(published.status, 409);
    assert.equal(published.body.error.code, 'quality_gate_failed');

    const quality = await api(harness, `/v1/capabilities/datasets/${id}/quality`, { token: 'user-token' });
    assert.equal(quality.body.latest.status, 'failed');
    assert.ok(quality.body.latest.results.some((result: any) => result.name === 'email required'));
  } finally {
    await harness.close();
  }
});

test('lineage is tenant-scoped and traversable (#40)', async () => {
  const harness = await startHarness();
  try {
    const dataset = await createDataset(harness, { slug: 'lineage-data', public: false });
    const id = dataset.body.id;
    const link = await api(harness, '/v1/capabilities/lineage', {
      method: 'POST', token: 'user-token',
      body: { from: { type: 'dataset', id }, to: { type: 'report', id: 'report-1' }, relation: 'feeds' },
    });
    assert.equal(link.status, 201);
    const downstream = await api(harness, `/v1/capabilities/lineage/dataset/${id}?direction=downstream`, { token: 'user-token' });
    assert.equal(downstream.status, 200);
    assert.equal(downstream.body.nodes.length, 2);
    assert.equal(downstream.body.links.length, 1);
    const foreign = await api(harness, `/v1/capabilities/lineage/dataset/${id}?direction=downstream`, { token: 'other-token' });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.nodes.length, 1);
    assert.equal(foreign.body.links.length, 0);
  } finally {
    await harness.close();
  }
});

test('reports honour dataset permissions, export idempotently and schedule (#39)', async () => {
  const harness = await startHarness();
  try {
    const dataset = await createDataset(harness, { slug: 'report-data', public: false });
    const id = dataset.body.id;
    for (const record of [{ id: 'r1', data: { status: 'open', amount: 10 } }, { id: 'r2', data: { status: 'closed', amount: 5 } }]) {
      const created = await api(harness, `/v1/capabilities/datasets/${id}/records`, { method: 'POST', token: 'user-token', body: record });
      assert.equal(created.status, 201);
    }
    const report = await api(harness, '/v1/capabilities/reports', {
      method: 'POST', token: 'user-token',
      body: { name: 'Incident cost', kind: 'metric', datasetId: id, query: { aggregate: 'sum', field: 'amount', where: { status: 'open' } } },
    });
    assert.equal(report.status, 201, JSON.stringify(report.body));
    const reportId = report.body.report.id;

    const run = await api(harness, `/v1/capabilities/reports/${reportId}/run`, { method: 'POST', token: 'user-token', body: {} });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.rows[0].value, 10);
    assert.equal(run.body.total, 1);

    const foreign = await api(harness, `/v1/capabilities/reports/${reportId}/run`, { method: 'POST', token: 'other-token', body: {} });
    assert.equal(foreign.status, 404);

    const export1 = await api(harness, `/v1/capabilities/reports/${reportId}/export`, {
      method: 'POST', token: 'user-token', body: { format: 'csv', idempotencyKey: 'export-1' },
    });
    assert.equal(export1.status, 201, JSON.stringify(export1.body));
    assert.match(export1.body.content, /10/);
    const export2 = await api(harness, `/v1/capabilities/reports/${reportId}/export`, {
      method: 'POST', token: 'user-token', body: { format: 'csv', idempotencyKey: 'export-1' },
    });
    assert.equal(export2.status, 200);
    assert.equal(export2.body.duplicate, true);

    const schedule = await api(harness, `/v1/capabilities/reports/${reportId}/schedule`, {
      method: 'POST', token: 'user-token', body: { cron: '0 6 * * *', format: 'ndjson', recipient: 'ops@example.com' },
    });
    assert.equal(schedule.status, 200);
    assert.equal(schedule.body.report.schedule.format, 'ndjson');
    const due = await api(harness, '/v1/capabilities/report-schedules/run-due', { method: 'POST', token: 'user-token', body: {} });
    assert.equal(due.status, 200);
    assert.equal(due.body.deliveries.length, 1);
    const dueAgain = await api(harness, '/v1/capabilities/report-schedules/run-due', { method: 'POST', token: 'user-token', body: {} });
    assert.equal(dueAgain.body.deliveries[0].duplicate, true);
  } finally {
    await harness.close();
  }
});

test('dashboards apply the same filters to every widget (#39)', async () => {
  const harness = await startHarness();
  try {
    const dataset = await createDataset(harness, { slug: 'dashboard-data', public: false });
    const id = dataset.body.id;
    for (const record of [{ id: 'r1', data: { status: 'open', amount: 10 } }, { id: 'r2', data: { status: 'closed', amount: 5 } }]) {
      await api(harness, `/v1/capabilities/datasets/${id}/records`, { method: 'POST', token: 'user-token', body: record });
    }
    const report = await api(harness, '/v1/capabilities/reports', {
      method: 'POST', token: 'user-token', body: { name: 'Amount', kind: 'table', datasetId: id, query: {} },
    });
    const reportId = report.body.report.id;
    const dashboard = await api(harness, '/v1/capabilities/dashboards', {
      method: 'POST', token: 'user-token',
      body: { name: 'Ops', filters: { status: 'open' }, widgets: [{ id: 'w1', reportId, x: 0, y: 0, w: 4, h: 2 }] },
    });
    assert.equal(dashboard.status, 201, JSON.stringify(dashboard.body));
    const dashboardId = dashboard.body.dashboard.id;
    const data = await api(harness, `/v1/capabilities/dashboards/${dashboardId}/data`, { token: 'user-token' });
    assert.equal(data.status, 200);
    assert.equal(data.body.widgets[0].rows.length, 1);
    assert.equal(data.body.widgets[0].rows[0].status, 'open');
    const share = await api(harness, `/v1/capabilities/dashboards/${dashboardId}/share`, { method: 'POST', token: 'user-token', body: {} });
    assert.equal(share.status, 200);
    assert.match(share.body.shareUrl, /dashboards\/shared\//);
  } finally {
    await harness.close();
  }
});
