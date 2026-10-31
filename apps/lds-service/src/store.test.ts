/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Store tests on the in-memory fallback (DATABASE_URL unset in tests).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDatasourceRec, getDatasourceRec, listDatasourceRecs, updateDatasourceRec, deleteDatasourceRec,
  getAttributesRec, replaceAttributesRec, upsertRecordRec, getRecordRec, listRecordRecs,
  datasourceStatsRec, __clearLdsMem,
} from './store';
import { ingestRecord } from './projector';
import type { RegistryAttribute } from './projector';

beforeEach(() => __clearLdsMem());

async function makeDs(slug = 'business-registry', org: string | null = 'tenant-danang') {
  return createDatasourceRec({
    slug, name: 'Business Registry', entity_type: 'Organization',
    license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
    contexts: [], default_visibility: 'internal', org_id: org, account_id: null, created_by: 'user-1',
  });
}

test('datasource lifecycle on memory store', async () => {
  const ds = await makeDs();
  assert.ok(ds.id);
  assert.equal((await getDatasourceRec(ds.id))?.slug, 'business-registry');
  // slug uniqueness is per scope
  await assert.rejects(() => makeDs('business-registry'), /already exists/);
  const other = await makeDs('business-registry', 'tenant-hue');
  assert.ok(other.id);
  // tenant filter
  assert.equal((await listDatasourceRecs({ orgId: 'tenant-hue' })).length, 1);
  assert.equal((await listDatasourceRecs()).length, 2);
  // patch
  const patched = await updateDatasourceRec(ds.id, { license: 'ODbL-1.0' });
  assert.equal(patched?.license, 'ODbL-1.0');
  // delete removes registry + records with it
  const reg: RegistryAttribute[] = [{ name: 'name', ngsiLdType: 'Property', visibility: 'public' }];
  await replaceAttributesRec(ds.id, reg);
  const rec = ingestRecord({ id: ds.id, entity_type: ds.entity_type }, reg, { id: '1', name: 'x' }, null).record;
  await upsertRecordRec(rec);
  assert.equal(await deleteDatasourceRec(ds.id), true);
  assert.deepEqual(await getAttributesRec(ds.id), []);
  assert.equal(await getRecordRec(ds.id, rec.entityId), null);
  assert.equal(await deleteDatasourceRec(ds.id), false);
});

test('attribute registry replace is atomic and complete', async () => {
  const ds = await makeDs();
  const reg: RegistryAttribute[] = [
    { name: 'name', ngsiLdType: 'Property', visibility: 'public' },
    { name: 'locatedIn', ngsiLdType: 'Relationship', visibility: 'public', sourceField: 'location_id' },
  ];
  const saved = await replaceAttributesRec(ds.id, reg);
  assert.deepEqual(saved.map((a) => a.name), ['locatedIn', 'name']);
  const replaced = await replaceAttributesRec(ds.id, [{ name: 'name', ngsiLdType: 'Property', visibility: 'internal' }]);
  assert.deepEqual(replaced, [{ name: 'name', ngsiLdType: 'Property', visibility: 'internal' }]);
});

test('record upsert tracks created/updated and stable internal ids', async () => {
  const ds = await makeDs();
  const first = ingestRecord({ id: ds.id, entity_type: ds.entity_type }, [], { id: 'a', v: 1 }, null).record;
  const up1 = await upsertRecordRec(first);
  assert.equal(up1.created, true);
  assert.ok(up1.record.core.internalId);
  const second = ingestRecord({ id: ds.id, entity_type: ds.entity_type }, [], { id: 'a', v: 2 }, null, up1.record).record;
  const up2 = await upsertRecordRec(second);
  assert.equal(up2.created, false);
  assert.equal(up2.record.version, 2);
  assert.equal(up2.record.core.internalId, up1.record.core.internalId);
  const { items, total } = await listRecordRecs(ds.id, { limit: 10 });
  assert.equal(total, 1);
  assert.deepEqual(items[0].attributes.v, { type: 'Property', value: 2 });
});

test('stats report record count and visibility buckets', async () => {
  const ds = await makeDs();
  await replaceAttributesRec(ds.id, [
    { name: 'a', ngsiLdType: 'Property', visibility: 'public' },
    { name: 'b', ngsiLdType: 'Property', visibility: 'restricted' },
    { name: 'c', ngsiLdType: 'Property', visibility: 'internal' },
  ]);
  const rec = ingestRecord({ id: ds.id, entity_type: ds.entity_type }, [], { id: '1', a: 'x' }, null).record;
  await upsertRecordRec(rec);
  const stats = await datasourceStatsRec(ds.id);
  assert.equal(stats.records, 1);
  assert.deepEqual(stats.attributes, { public: 1, restricted: 1, internal: 1 });
  assert.ok(stats.lastIngestAt);
});
