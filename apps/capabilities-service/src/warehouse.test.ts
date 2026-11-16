// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';

test('warehouse capability lists use cases and forwards SQL', async () => {
  const harness = await startHarness();
  try {
    const useCases = await api(harness, '/v1/capabilities/warehouse/use-cases');
    assert.equal(useCases.status, 200);
    assert.equal(useCases.body.items.length, 3);

    const created = await api(harness, '/v1/capabilities/warehouse/datasets', {
      method: 'POST',
      token: 'user-token',
      body: {
        id: 'city_incidents',
        name: 'City incidents',
        columns: [
          { name: 'ts', type: 'timestamp' },
          { name: 'city', type: 'string' },
        ],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'city_incidents');

    const query = await api(harness, '/v1/capabilities/warehouse/query', {
      method: 'POST',
      token: 'user-token',
      body: { sql: 'SELECT city, count(*) AS incidents FROM city_incidents GROUP BY city' },
    });
    assert.equal(query.status, 200);
    assert.equal(query.body.rowCount, 2);
    assert.equal(query.body.rows[0].city, 'Hanoi');

    const invalid = await api(harness, '/v1/capabilities/warehouse/query', {
      method: 'POST',
      token: 'user-token',
      body: { sql: 'DROP TABLE city_incidents' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_sql');
  } finally {
    await harness.close();
  }
});

test('saved report runs and publishes an immutable snapshot for Tier 3', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/warehouse/reports', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Incident hotspots',
        description: 'Manager view',
        sql: 'SELECT city, count(*) AS incidents FROM city_incidents GROUP BY city',
      },
    });
    assert.equal(created.status, 201);
    const reportId = created.body.id;

    const run = await api(harness, `/v1/capabilities/warehouse/reports/${reportId}/run`, {
      method: 'POST',
      token: 'user-token',
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.result.rowCount, 2);

    const published = await api(harness, `/v1/capabilities/warehouse/reports/${reportId}/publish`, {
      method: 'POST',
      token: 'user-token',
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.visibility, 'published');
    assert.ok(published.body.shareId);

    const publicRead = await api(
      harness,
      `/v1/capabilities/warehouse/public/reports/${published.body.shareId}`,
    );
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.body.name, 'Incident hotspots');
    assert.equal(publicRead.body.result.rowCount, 2);
  } finally {
    await harness.close();
  }
});

test('city operations use case seeds datasets, ETL, reports and a dashboard', async () => {
  const harness = await startHarness();
  try {
    const seeded = await api(harness, '/v1/capabilities/warehouse/use-cases/city-operations/seed', {
      method: 'POST',
      token: 'user-token',
    });
    assert.equal(seeded.status, 201);
    assert.deepEqual(seeded.body.datasets, ['city_incidents', 'city_daily']);
    assert.equal(seeded.body.reports.length, 2);
    assert.ok(seeded.body.dashboard);
    assert.equal(seeded.body.dashboard.widgets.length, 2);

    const query = await api(harness, '/v1/capabilities/warehouse/query', {
      method: 'POST',
      token: 'user-token',
      body: { sql: 'SELECT day, category, events FROM city_daily' },
    });
    assert.equal(query.status, 200);
    assert.equal(query.body.rowCount, 2);
  } finally {
    await harness.close();
  }
});

test('Tier-1 ETL workflow templates are listed and instantiated through Tier 2', async () => {
  const harness = await startHarness();
  try {
    const listed = await api(harness, '/v1/capabilities/warehouse/workflow-templates', { token: 'user-token' });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map((item: any) => item.name), ['etl-batch-warehouse', 'etl-stream-microbatch']);

    const created = await api(harness, '/v1/capabilities/warehouse/workflow-templates/etl-batch-warehouse/instantiate', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Demo ETL' },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.id);
  } finally {
    await harness.close();
  }
});

test('dataset detail and delete are proxied through Tier 2', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/warehouse/datasets', {
      method: 'POST',
      token: 'user-token',
      body: { id: 'temp_ds', name: 'Temp dataset', columns: [{ name: 'value', type: 'number' }] },
    });
    assert.equal(created.status, 201);

    const detail = await api(harness, '/v1/capabilities/warehouse/datasets/temp_ds', { token: 'user-token' });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, 'temp_ds');
    assert.equal(detail.body.columns[0].name, 'value');

    const removed = await api(harness, '/v1/capabilities/warehouse/datasets/temp_ds', {
      method: 'DELETE',
      token: 'user-token',
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);

    const missing = await api(harness, '/v1/capabilities/warehouse/datasets/temp_ds', { token: 'user-token' });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test('stream job detail, resume and delete are exposed at Tier 2', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/warehouse/datasets', {
      method: 'POST',
      token: 'user-token',
      body: { id: 'stream_ds', name: 'Stream dataset', columns: [{ name: 'value', type: 'number' }] },
    });
    assert.equal(created.status, 201);

    const stream = await api(harness, '/v1/capabilities/warehouse/etl/stream', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'stream-job', targetDatasetId: 'stream_ds', streamTopic: 'iot-sensors' },
    });
    assert.equal(stream.status, 201);
    const jobId = stream.body.job.id as string;

    const detail = await api(harness, `/v1/capabilities/warehouse/jobs/${jobId}`, { token: 'user-token' });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.mode, 'stream');

    const resumed = await api(harness, `/v1/capabilities/warehouse/jobs/${jobId}/resume`, {
      method: 'POST',
      token: 'user-token',
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, 'running');

    const removed = await api(harness, `/v1/capabilities/warehouse/jobs/${jobId}`, {
      method: 'DELETE',
      token: 'user-token',
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
  } finally {
    await harness.close();
  }
});

test('saved reports and dashboards can be edited and deleted through Tier 2', async () => {
  const harness = await startHarness();
  try {
    const report = await api(harness, '/v1/capabilities/warehouse/reports', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Draft', sql: 'SELECT 1 AS value', limit: 10 },
    });
    assert.equal(report.status, 201);

    const patched = await api(harness, `/v1/capabilities/warehouse/reports/${report.body.id}`, {
      method: 'PATCH',
      token: 'user-token',
      body: { name: 'Final', sql: 'SELECT 2 AS value' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, 'Final');
    assert.equal(patched.body.visibility, 'private');

    const dashboard = await api(harness, '/v1/capabilities/warehouse/dashboards', {
      method: 'POST',
      token: 'user-token',
      body: {
        name: 'Ops',
        widgets: [{ reportId: report.body.id, title: 'Final' }],
      },
    });
    assert.equal(dashboard.status, 201);

    const blocked = await api(harness, `/v1/capabilities/warehouse/reports/${report.body.id}`, {
      method: 'DELETE',
      token: 'user-token',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'report_in_use');

    const dashboardPatched = await api(harness, `/v1/capabilities/warehouse/dashboards/${dashboard.body.id}`, {
      method: 'PATCH',
      token: 'user-token',
      body: { name: 'Ops v2', widgets: [] },
    });
    assert.equal(dashboardPatched.status, 400);

    const dashboardGet = await api(harness, `/v1/capabilities/warehouse/dashboards/${dashboard.body.id}`, {
      token: 'user-token',
    });
    assert.equal(dashboardGet.status, 200);
    assert.equal(dashboardGet.body.name, 'Ops');

    const dashboardDeleted = await api(harness, `/v1/capabilities/warehouse/dashboards/${dashboard.body.id}`, {
      method: 'DELETE',
      token: 'user-token',
    });
    assert.equal(dashboardDeleted.status, 200);

    const reportDeleted = await api(harness, `/v1/capabilities/warehouse/reports/${report.body.id}`, {
      method: 'DELETE',
      token: 'user-token',
    });
    assert.equal(reportDeleted.status, 200);
  } finally {
    await harness.close();
  }
});
