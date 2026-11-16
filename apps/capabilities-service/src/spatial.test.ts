// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness, Harness } from './testing/harness';
import { extractRecordGeometry, geoCollectionName, validateGeoConfig } from './spatial';
import { parseSpatialQuery } from './routes/spatial';

const HANOI = { type: 'Point', coordinates: [105.8542, 21.0285] };
const HCMC = { type: 'Point', coordinates: [106.7009, 10.7769] };
/** ~1 km square around Hoan Kiem lake. */
const HANOI_AREA = {
  type: 'Polygon',
  coordinates: [[
    [105.8500, 21.0230],
    [105.8600, 21.0230],
    [105.8600, 21.0330],
    [105.8500, 21.0330],
    [105.8500, 21.0230],
  ]],
};
/** Only the Hanoi point is fully inside this polygon. */
const SMALL_BOX = {
  type: 'Polygon',
  coordinates: [[
    [105.8530, 21.0270],
    [105.8560, 21.0270],
    [105.8560, 21.0300],
    [105.8530, 21.0300],
    [105.8530, 21.0270],
  ]],
};

async function publishGeoDataset(
  harness: Harness,
  slug: string,
  geo: Record<string, unknown> = { field: 'geometry' },
): Promise<void> {
  const created = await createDataset(harness, { slug, name: slug, geo });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.geo, geo);
  const published = await api(harness, `/v1/capabilities/datasets/${slug}/publish`, {
    method: 'POST', token: 'user-token',
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
}

function featureIds(body: any): string[] {
  return body.features.map((feature: any) => feature.id);
}

test('geo config and geometry extraction helpers validate dotted paths', () => {
  assert.deepEqual(validateGeoConfig({ field: 'geometry' }), { field: 'geometry' });
  assert.deepEqual(validateGeoConfig({ field: 'metadata.area' }), { field: 'metadata.area' });
  assert.deepEqual(validateGeoConfig({ field: 'a.b_c.d1' }), { field: 'a.b_c.d1' });
  for (const value of [
    null,
    [],
    {},
    { field: '' },
    { field: '1abc' },
    { field: 'a..b' },
    { field: 'a.__proto__' },
    { field: 'a.constructor' },
    { field: 5 },
    { field: 'a'.repeat(65) },
    { field: 'a.b.c.d.e.f.g' },
  ]) {
    assert.throws(() => validateGeoConfig(value), /geo\.field|geo must/, String(JSON.stringify(value)));
  }

  assert.deepEqual(
    extractRecordGeometry({ geometry: HANOI }, 'geometry'),
    { geometry: HANOI },
  );
  assert.deepEqual(
    extractRecordGeometry({ metadata: { area: HANOI_AREA } }, 'metadata.area'),
    { geometry: HANOI_AREA },
  );
  assert.deepEqual(extractRecordGeometry({ metadata: {} }, 'metadata.area'), {});
  assert.deepEqual(extractRecordGeometry({ metadata: { area: null } }, 'metadata.area'), {});
  assert.match(
    extractRecordGeometry({ geometry: { type: 'Point', coordinates: [999, 0] } }, 'geometry').error || '',
    /WGS84|geometry/,
  );
  assert.equal(
    extractRecordGeometry({ geometry: HANOI }, 'metadata.area').geometry,
    undefined,
  );

  assert.equal(geoCollectionName('city-assets'), 'synapsedx_geo_city-assets');
  assert.match(geoCollectionName('a b/c'), /^synapsedx_geo_[a-z0-9_-]+$/);
  const longA = geoCollectionName('a'.repeat(80));
  const longB = geoCollectionName(`${'a'.repeat(79)}b`);
  assert.equal(longA.length, 64);
  assert.match(longA, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
  assert.notEqual(longA, longB);
});

test('spatial query parser enforces mode, WGS84 ranges, radius, bbox and limit', () => {
  assert.deepEqual(parseSpatialQuery({ mode: 'near', lat: 21, lng: 105, radiusMeters: 500 }), {
    mode: 'near', limit: 100, lat: 21, lng: 105, radiusMeters: 500,
  });
  assert.equal(parseSpatialQuery({ mode: 'near', lat: 21, lng: 105, radiusMeters: 500, limit: 5 }).limit, 5);
  assert.deepEqual(parseSpatialQuery({ mode: 'bbox', bbox: [105, 21, 106, 22] }).bbox, [105, 21, 106, 22]);
  assert.deepEqual(parseSpatialQuery({ mode: 'within', geometry: SMALL_BOX }).geometry, SMALL_BOX);
  for (const body of [
    {},
    { mode: 'nope' },
    { mode: 'near', lat: 91, lng: 105, radiusMeters: 100 },
    { mode: 'near', lat: 21, lng: 181, radiusMeters: 100 },
    { mode: 'near', lat: 21, lng: 105, radiusMeters: 0 },
    { mode: 'near', lat: 21, lng: 105, radiusMeters: 100_001 },
    { mode: 'near', lat: 21, lng: 105, radiusMeters: 100, limit: 0 },
    { mode: 'near', lat: 21, lng: 105, radiusMeters: 100, limit: 501 },
    { mode: 'bbox', bbox: [1, 2, 3] },
    { mode: 'bbox', bbox: [106, 21, 105, 22] },
    { mode: 'bbox', bbox: [105, 22, 106, 21] },
    { mode: 'within', geometry: { type: 'Point', coordinates: [105, 21] } },
    { mode: 'within', geometry: { type: 'Polygon', coordinates: [] } },
  ]) {
    assert.throws(() => parseSpatialQuery(body as Record<string, unknown>), String(JSON.stringify(body)));
  }
});

test('dataset geo config is accepted on create and patch', async () => {
  const harness = await startHarness();
  try {
    const created = await createDataset(harness, {
      slug: 'geo-config', name: 'Geo config', geo: { field: 'metadata.area' },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.geo, { field: 'metadata.area' });

    const fetched = await api(harness, '/v1/capabilities/datasets/geo-config', { token: 'user-token' });
    assert.deepEqual(fetched.body.geo, { field: 'metadata.area' });

    const patched = await api(harness, '/v1/capabilities/datasets/geo-config', {
      method: 'PATCH', token: 'user-token', body: { geo: { field: 'location' } },
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.geo, { field: 'location' });

    const cleared = await api(harness, '/v1/capabilities/datasets/geo-config', {
      method: 'PATCH', token: 'user-token', body: { geo: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.geo, undefined);

    const invalid = await api(harness, '/v1/capabilities/datasets/geo-config', {
      method: 'PATCH', token: 'user-token', body: { geo: { field: 'metadata..area' } },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_geo_field');

    const invalidCreate = await createDataset(harness, {
      slug: 'geo-invalid', name: 'Geo invalid', geo: { field: '__proto__.x' },
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal(invalidCreate.body.error.code, 'invalid_geo_field');
  } finally {
    await harness.close();
  }
});

test('near, bbox and within return matching records and GeoJSON features', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-shapes');
    for (const [id, geometry] of [['p-hanoi', HANOI], ['p-hcmc', HCMC], ['area-hanoi', HANOI_AREA]] as const) {
      const created = await api(harness, '/v1/capabilities/datasets/spatial-shapes/records', {
        method: 'POST', token: 'user-token', body: { id, data: { title: id, geometry } },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }

    const near = await api(harness, '/v1/capabilities/datasets/spatial-shapes/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'near', lat: 21.0285, lng: 105.8542, radiusMeters: 3000 },
    });
    assert.equal(near.status, 200, JSON.stringify(near.body));
    assert.equal(near.body.type, 'FeatureCollection');
    assert.equal(near.body.mode, 'near');
    assert.deepEqual(featureIds(near.body).sort(), ['area-hanoi', 'p-hanoi']);
    assert.equal(near.body.total, 2);
    assert.equal(near.body.limit, 100);
    assert.deepEqual(near.body.items.map((item: any) => item.id).sort(), ['area-hanoi', 'p-hanoi']);
    const hanoiFeature = near.body.features.find((feature: any) => feature.id === 'p-hanoi');
    assert.equal(hanoiFeature.properties.recordId, 'p-hanoi');
    assert.equal(typeof hanoiFeature.properties.distanceMeters, 'number');
    assert.equal(hanoiFeature.geometry.type, 'Point');
    assert.deepEqual(Object.keys(near.body.items[0]).sort(), ['createdAt', 'data', 'id', 'updatedAt', 'version']);

    const bbox = await api(harness, '/v1/capabilities/datasets/spatial-shapes/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'bbox', bbox: [105.84, 21.02, 105.87, 21.04], limit: 10 },
    });
    assert.equal(bbox.status, 200, JSON.stringify(bbox.body));
    assert.deepEqual(featureIds(bbox.body).sort(), ['area-hanoi', 'p-hanoi']);
    assert.equal(bbox.body.limit, 10);

    const within = await api(harness, '/v1/capabilities/datasets/spatial-shapes/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'within', geometry: SMALL_BOX },
    });
    assert.equal(within.status, 200, JSON.stringify(within.body));
    assert.deepEqual(featureIds(within.body), ['p-hanoi']);
    assert.equal(within.body.items[0].data.title, 'p-hanoi');

    const limited = await api(harness, '/v1/capabilities/datasets/spatial-shapes/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'bbox', bbox: [105.84, 21.02, 105.87, 21.04], limit: 1 },
    });
    assert.equal(limited.body.total, 1);
    assert.equal(limited.body.items.length, 1);
  } finally {
    await harness.close();
  }
});

test('spatial queries respect draft visibility and per-record publication', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-drafts');
    const published = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records', {
      method: 'POST', token: 'user-token', body: { id: 'visible', data: { geometry: HANOI } },
    });
    assert.equal(published.status, 201);
    const draft = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records', {
      method: 'POST', token: 'user-token',
      body: { id: 'draft', data: { geometry: HANOI }, publish: false },
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.published, false);

    const query = { mode: 'near', lat: 21.0285, lng: 105.8542, radiusMeters: 2000 };

    const member = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records/spatial', {
      method: 'POST', token: 'read-token', body: query,
    });
    assert.equal(member.status, 200, JSON.stringify(member.body));
    assert.deepEqual(featureIds(member.body).sort(), ['draft', 'visible']);

    const other = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records/spatial', {
      method: 'POST', token: 'other-token', body: query,
    });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.deepEqual(featureIds(other.body), ['visible']);

    // Promoting the row updates the indexed publication flag and visibility.
    const promoted = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records/draft', {
      method: 'PATCH', token: 'user-token', body: { data: { geometry: HANOI }, publish: true },
    });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    const collection = geoCollectionName('spatial-drafts');
    const feature = harness.fake.geo.get(collection)?.get('draft');
    assert.equal((feature?.properties as any).published, true);

    const otherAfter = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records/spatial', {
      method: 'POST', token: 'other-token', body: query,
    });
    assert.deepEqual(featureIds(otherAfter.body).sort(), ['draft', 'visible']);

    const withdrawn = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records/visible', {
      method: 'PATCH', token: 'user-token', body: { data: { geometry: HANOI }, publish: false },
    });
    assert.equal(withdrawn.status, 200);
    const otherWithdrawn = await api(harness, '/v1/capabilities/datasets/spatial-drafts/records/spatial', {
      method: 'POST', token: 'other-token', body: query,
    });
    assert.deepEqual(featureIds(otherWithdrawn.body), ['draft']);
  } finally {
    await harness.close();
  }
});

test('invalid geometry is rejected before the record write', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-invalid');
    const invalid = { type: 'Point', coordinates: [999, 0] };

    const create = await api(harness, '/v1/capabilities/datasets/spatial-invalid/records', {
      method: 'POST', token: 'user-token', body: { id: 'bad-create', data: { geometry: invalid } },
    });
    assert.equal(create.status, 400);
    assert.equal(create.body.error.code, 'invalid_geometry');
    assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-invalid/records/bad-create', {
      token: 'user-token',
    })).status, 404);

    const valid = await api(harness, '/v1/capabilities/datasets/spatial-invalid/records', {
      method: 'POST', token: 'user-token', body: { id: 'keep', data: { geometry: HANOI } },
    });
    assert.equal(valid.status, 201);

    const patch = await api(harness, '/v1/capabilities/datasets/spatial-invalid/records/keep', {
      method: 'PATCH', token: 'user-token', body: { data: { geometry: { type: 'Point', coordinates: [0] } } },
    });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.code, 'invalid_geometry');
    const after = await api(harness, '/v1/capabilities/datasets/spatial-invalid/records/keep', { token: 'user-token' });
    assert.deepEqual(after.body.data.geometry, HANOI);

    const bulk = await api(harness, '/v1/capabilities/datasets/spatial-invalid/records/bulk', {
      method: 'POST', token: 'user-token',
      body: {
        records: [
          { id: 'bulk-good', data: { geometry: HANOI } },
          { id: 'bulk-bad', data: { geometry: { type: 'Point', coordinates: [105] } } },
        ],
      },
    });
    assert.equal(bulk.status, 400);
    assert.equal(bulk.body.error.code, 'invalid_geometry');
    assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-invalid/records/bulk-good', {
      token: 'user-token',
    })).status, 404);
  } finally {
    await harness.close();
  }
});

test('a null geometry removes the feature and record delete removes it too', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-remove');
    for (const [id, geometry] of [['one', HANOI], ['two', HANOI]] as const) {
      assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-remove/records', {
        method: 'POST', token: 'user-token', body: { id, data: { geometry } },
      })).status, 201);
    }
    const collection = geoCollectionName('spatial-remove');
    assert.equal(harness.fake.geo.get(collection)?.size, 2);

    const cleared = await api(harness, '/v1/capabilities/datasets/spatial-remove/records/one', {
      method: 'PATCH', token: 'user-token', body: { data: { title: 'no geometry' } },
    });
    assert.equal(cleared.status, 200);
    assert.equal(harness.fake.geo.get(collection)?.has('one'), false);

    const deleted = await api(harness, '/v1/capabilities/datasets/spatial-remove/records/two', {
      method: 'DELETE', token: 'user-token',
    });
    assert.equal(deleted.status, 204);
    assert.equal(harness.fake.geo.get(collection)?.has('two'), false);

    const near = await api(harness, '/v1/capabilities/datasets/spatial-remove/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'near', lat: 21.0285, lng: 105.8542, radiusMeters: 2000 },
    });
    assert.deepEqual(near.body.features, []);
    assert.deepEqual(near.body.items, []);
  } finally {
    await harness.close();
  }
});

test('reindex repairs a lost or stale index and reports counts', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-reindex');
    for (const [id, geometry] of [['r1', HANOI], ['r2', HCMC]] as const) {
      assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-reindex/records', {
        method: 'POST', token: 'user-token', body: { id, data: { geometry } },
      })).status, 201);
    }
    assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-reindex/records', {
      method: 'POST', token: 'user-token', body: { id: 'r3', data: { title: 'no geometry' } },
    })).status, 201);

    const collection = geoCollectionName('spatial-reindex');
    harness.fake.geo.get(collection)?.delete('r1');
    harness.fake.geo.get(collection)?.set('ghost', {
      type: 'Feature',
      id: 'ghost',
      properties: { recordId: 'ghost', datasetId: 'spatial-reindex' },
      geometry: HANOI,
      updatedAt: new Date().toISOString(),
    });

    const reindex = await api(harness, '/v1/capabilities/datasets/spatial-reindex/records/spatial/reindex', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(reindex.status, 200, JSON.stringify(reindex.body));
    assert.equal(reindex.body.dataset_id, 'spatial-reindex');
    assert.equal(reindex.body.collection, collection);
    assert.equal(reindex.body.offset, 0);
    assert.equal(reindex.body.scanned, 3);
    assert.equal(reindex.body.indexed, 2);
    assert.equal(reindex.body.removed, 1);
    assert.equal(reindex.body.failed, 0);
    assert.equal(reindex.body.truncated, false);
    assert.equal(harness.fake.geo.get(collection)?.has('r1'), true);
    assert.equal(harness.fake.geo.get(collection)?.has('ghost'), false);

    const status = await api(harness, '/v1/capabilities/datasets/spatial-reindex/records/spatial/status', {
      token: 'user-token',
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, true);
    assert.equal(status.body.field, 'geometry');
    assert.equal(status.body.collection, collection);
    assert.equal(status.body.features, 2);
    assert.ok(status.body.extent);

    const near = await api(harness, '/v1/capabilities/datasets/spatial-reindex/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'near', lat: 21.0285, lng: 105.8542, radiusMeters: 2000 },
    });
    assert.deepEqual(featureIds(near.body), ['r1']);

    // Larger datasets continue from the reported offset.
    const secondPage = await api(harness, '/v1/capabilities/datasets/spatial-reindex/records/spatial/reindex', {
      method: 'POST', token: 'user-token', body: { offset: 2 },
    });
    assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
    assert.equal(secondPage.body.offset, 2);
    assert.equal(secondPage.body.scanned, 1);
    assert.equal(secondPage.body.indexed, 0);
    assert.equal(secondPage.body.truncated, false);

    const badOffset = await api(harness, '/v1/capabilities/datasets/spatial-reindex/records/spatial/reindex', {
      method: 'POST', token: 'user-token', body: { offset: -1 },
    });
    assert.equal(badOffset.status, 400);
    assert.equal(badOffset.body.error.code, 'invalid_offset');
  } finally {
    await harness.close();
  }
});

test('bulk create indexes features and retention purge removes them', async () => {
  const harness = await startHarness();
  try {
    const created = await createDataset(harness, {
      slug: 'spatial-bulk', name: 'Bulk spatial', geo: { field: 'geometry' }, retentionDays: 1,
    });
    assert.equal(created.status, 201);
    assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-bulk/publish', {
      method: 'POST', token: 'user-token',
    })).status, 200);

    const bulk = await api(harness, '/v1/capabilities/datasets/spatial-bulk/records/bulk', {
      method: 'POST', token: 'user-token',
      body: {
        records: [
          { id: 'bulk-a', data: { geometry: HANOI } },
          { id: 'bulk-b', data: { geometry: HANOI } },
          { id: 'bulk-no-geo', data: { title: 'no geometry' } },
        ],
      },
    });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    const collection = geoCollectionName('spatial-bulk');
    assert.equal(harness.fake.geo.get(collection)?.size, 2);

    // Age the Base rows so the retention purge applies to them.
    const docs = harness.fake.collections.get('synapsedx_capability_records');
    for (const id of ['bulk-a', 'bulk-b']) {
      const doc = docs?.get(id);
      assert.ok(doc);
      doc!.data.createdAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    }

    const purge = await api(harness, '/v1/capabilities/datasets/spatial-bulk/records/purge-expired', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(purge.status, 200, JSON.stringify(purge.body));
    assert.equal(purge.body.purged, 2);
    assert.equal(harness.fake.geo.get(collection)?.size, 0);
  } finally {
    await harness.close();
  }
});

test('a geo outage does not fail the Base write; reindex repairs it', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-outage');
    harness.fake.failGeo = true;
    const created = await api(harness, '/v1/capabilities/datasets/spatial-outage/records', {
      method: 'POST', token: 'user-token', body: { id: 'during-outage', data: { geometry: HANOI } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const collection = geoCollectionName('spatial-outage');
    assert.equal(harness.fake.geo.get(collection)?.size || 0, 0);

    harness.fake.failGeo = false;
    const reindex = await api(harness, '/v1/capabilities/datasets/spatial-outage/records/spatial/reindex', {
      method: 'POST', token: 'user-token',
    });
    assert.equal(reindex.status, 200, JSON.stringify(reindex.body));
    assert.equal(reindex.body.indexed, 1);
    assert.equal(harness.fake.geo.get(collection)?.has('during-outage'), true);
  } finally {
    await harness.close();
  }
});

test('geo collections are isolated per dataset and unconfigured datasets fail clearly', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-a');
    await publishGeoDataset(harness, 'spatial-b');
    assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-a/records', {
      method: 'POST', token: 'user-token', body: { id: 'a-point', data: { geometry: HANOI } },
    })).status, 201);
    assert.equal((await api(harness, '/v1/capabilities/datasets/spatial-b/records', {
      method: 'POST', token: 'user-token', body: { id: 'b-point', data: { geometry: HANOI } },
    })).status, 201);

    const query = { mode: 'near', lat: 21.0285, lng: 105.8542, radiusMeters: 2000 };
    const fromA = await api(harness, '/v1/capabilities/datasets/spatial-a/records/spatial', {
      method: 'POST', token: 'user-token', body: query,
    });
    assert.deepEqual(featureIds(fromA.body), ['a-point']);
    const fromB = await api(harness, '/v1/capabilities/datasets/spatial-b/records/spatial', {
      method: 'POST', token: 'user-token', body: query,
    });
    assert.deepEqual(featureIds(fromB.body), ['b-point']);
    assert.notEqual(geoCollectionName('spatial-a'), geoCollectionName('spatial-b'));

    await createDataset(harness, { slug: 'spatial-none', name: 'No geo' });
    const status = await api(harness, '/v1/capabilities/datasets/spatial-none/records/spatial/status', {
      token: 'user-token',
    });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { configured: false });

    const rejected = await api(harness, '/v1/capabilities/datasets/spatial-none/records/spatial', {
      method: 'POST', token: 'user-token', body: query,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'geo_not_configured');
  } finally {
    await harness.close();
  }
});

test('spatial routes participate in 405 handling and require record access', async () => {
  const harness = await startHarness();
  try {
    await publishGeoDataset(harness, 'spatial-http');
    const wrongMethod = await api(harness, '/v1/capabilities/datasets/spatial-http/records/spatial', {
      method: 'GET', token: 'user-token',
    });
    assert.equal(wrongMethod.status, 405);
    assert.match(String(wrongMethod.headers.get('allow')), /POST/);

    const wrongStatusMethod = await api(harness, '/v1/capabilities/datasets/spatial-http/records/spatial/status', {
      method: 'POST', token: 'user-token', body: {},
    });
    assert.equal(wrongStatusMethod.status, 405);

    const anonymous = await api(harness, '/v1/capabilities/datasets/spatial-http/records/spatial', {
      method: 'POST', body: { mode: 'near', lat: 21, lng: 105, radiusMeters: 100 },
    });
    // Visibility is checked before the geo binding, so an anonymous caller
    // cannot even learn whether the dataset exists.
    assert.equal(anonymous.status, 404);
    assert.equal(anonymous.body.error.code, 'dataset_not_found');

    const badLimit = await api(harness, '/v1/capabilities/datasets/spatial-http/records/spatial', {
      method: 'POST', token: 'user-token',
      body: { mode: 'near', lat: 21, lng: 105, radiusMeters: 100, limit: 501 },
    });
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.body.error.code, 'invalid_limit');
  } finally {
    await harness.close();
  }
});
