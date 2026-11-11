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
