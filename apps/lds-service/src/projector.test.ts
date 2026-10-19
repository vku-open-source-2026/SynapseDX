/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Security tests for the NGSI-LD projection layer. These assert the three
 * design rules from docs/specs/synapsedx-lds.md: structural allowlist,
 * default deny, and reserved-name rejection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntityId, ingestRecord, projectEntity, toNgsiLdAttribute, resolveIdentity,
  validateAttributeRegistry, isReservedAttributeName, LDS_RESERVED_ATTRIBUTES,
  NGSI_LD_CORE_CONTEXT,
} from './projector';
import type { RegistryAttribute, StoredRecord } from './projector';

const DS = { id: 'ds-1', entity_type: 'Organization' };

function registry(...entries: Array<Partial<RegistryAttribute> & { name: string }>): RegistryAttribute[] {
  return entries.map((e) => ({ ngsiLdType: 'Property', visibility: 'public', ...e } as RegistryAttribute));
}

test('reserved attribute names are rejected at registration', () => {
  for (const name of ['id', '@id', 'type', '@type', '@context', 'internalId', 'tenantId', 'sourceRecordId', '_core', 'createdAt']) {
    const v = validateAttributeRegistry([{ name, visibility: 'public' }]);
    assert.equal(v.ok, false, `expected '${name}' to be rejected`);
    if (v.ok === false) assert.equal(v.error, 'reserved_attribute');
  }
  // case-insensitive too
  const v = validateAttributeRegistry([{ name: 'InternalId', visibility: 'public' }]);
  assert.equal(v.ok, false);
  // the reserved list itself covers the documented set
  assert.equal(LDS_RESERVED_ATTRIBUTES.includes('scope'), true);
  assert.equal(isReservedAttributeName('ID'), true);
});

test('registry validation normalizes defaults to the safest bucket', () => {
  const v = validateAttributeRegistry([
    { name: 'name' },
    { name: 'locatedIn', ngsiLdType: 'Relationship' },
    { name: 'geometry', ngsiLdType: 'GeoProperty', visibility: 'restricted', description: 'geo' },
  ]);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.value, [
    { name: 'name', ngsiLdType: 'Property', visibility: 'internal' },
    { name: 'locatedIn', ngsiLdType: 'Relationship', visibility: 'internal' },
    { name: 'geometry', ngsiLdType: 'GeoProperty', visibility: 'restricted', description: 'geo' },
  ]);
  assert.equal(validateAttributeRegistry([{ name: 'ok' }, { name: 'ok' }]).ok, false);
  assert.equal(validateAttributeRegistry([{ name: 'bad name!' }]).ok, false);
  assert.equal(validateAttributeRegistry([{ name: 'x', ngsiLdType: 'Rollercoaster' }]).ok, false);
  assert.equal(validateAttributeRegistry('nope').ok, false);
});

test('ngsi-ld shaped values round-trip unchanged', () => {
  const shaped = { type: 'Property', value: 42, unitCode: 'C62' };
  assert.equal(toNgsiLdAttribute('x', shaped), shaped);
  const rel = { type: 'Relationship', object: 'urn:ngsi-ld:Area:danang' };
  assert.equal(toNgsiLdAttribute('x', rel), rel);
});

test('plain values are converted using the registry type', () => {
  assert.deepEqual(toNgsiLdAttribute('name', 'ACME'), { type: 'Property', value: 'ACME' });
  assert.deepEqual(
    toNgsiLdAttribute('locatedIn', 'urn:ngsi-ld:AdministrativeArea:danang', { name: 'locatedIn', ngsiLdType: 'Relationship', visibility: 'public' }),
    { type: 'Relationship', object: 'urn:ngsi-ld:AdministrativeArea:danang' },
  );
  const geo = { type: 'Point', coordinates: [108.2, 16.0] };
  assert.deepEqual(
    toNgsiLdAttribute('location', geo, { name: 'location', ngsiLdType: 'GeoProperty', visibility: 'public' }),
    { type: 'GeoProperty', value: geo },
  );
  assert.throws(() => toNgsiLdAttribute('locatedIn', '', { name: 'locatedIn', ngsiLdType: 'Relationship', visibility: 'public' }));
  assert.throws(() => toNgsiLdAttribute('location', 'not-geo', { name: 'location', ngsiLdType: 'GeoProperty', visibility: 'public' }));
});

test('entity ids are NGSI-LD URIs derived from the source id', () => {
  assert.equal(buildEntityId('Organization', '55001'), 'urn:ngsi-ld:Organization:55001');
  assert.equal(buildEntityId('Organization', 'a b/c'), 'urn:ngsi-ld:Organization:a%20b%2Fc');
  // explicit IRIs are respected, junk is rejected
  assert.equal(buildEntityId('Organization', '1', 'urn:ngsi-ld:Organization:abc'), 'urn:ngsi-ld:Organization:abc');
  assert.equal(buildEntityId('Organization', '1', 'https://data.example.vn/org/1'), 'https://data.example.vn/org/1');
  assert.equal(buildEntityId('Organization', '1', 'javascript:alert(1)'), 'urn:ngsi-ld:Organization:1');
});

test('ingest maps identity to _core + entity and keeps dynamic fields in attributes', () => {
  const reg = registry({ name: 'name' }, { name: 'locatedIn', ngsiLdType: 'Relationship' });
  const { record, quarantined } = ingestRecord(
    DS,
    reg,
    { id: '55001', name: 'Công ty ABC', locatedIn: 'urn:ngsi-ld:AdministrativeArea:danang', employeeCount: 120 },
    { sub: 'service:connector-01', org: 'tenant-danang' },
  );
  assert.equal(record.entity.id, 'urn:ngsi-ld:Organization:55001');
  assert.equal(record.entity.type, 'Organization');
  assert.deepEqual(record.attributes.name, { type: 'Property', value: 'Công ty ABC' });
  assert.deepEqual(record.attributes.locatedIn, { type: 'Relationship', object: 'urn:ngsi-ld:AdministrativeArea:danang' });
  assert.deepEqual(record.attributes.employeeCount, { type: 'Property', value: 120 });
  assert.equal(quarantined.length, 0);
  // _core carries the private metadata, source id preserved
  assert.equal(record.core.sourceRecordId, '55001');
  assert.equal(record.core.tenantId, 'tenant-danang');
  assert.equal(record.core.ingestedBy, 'service:connector-01');
  assert.equal(record.version, 1);
  assert.equal(record.core.internalId, undefined); // assigned by the store on first save
});

test('ingest quarantines reserved fields instead of promoting them', () => {
  const { record, quarantined } = ingestRecord(
    DS,
    registry({ name: 'name' }),
    { id: '1', name: 'x', internalId: 'attacker', tenantId: 'other-tenant', scope: 'admin', _core: { pwn: true } },
    null,
  );
  assert.equal(record.attributes.internalId, undefined);
  assert.equal(record.attributes.tenantId, undefined);
  assert.equal(record.attributes.scope, undefined);
  assert.equal(record.attributes._core, undefined);
  assert.equal(quarantined.length, 4);
  assert.ok(quarantined.every((q) => q.reason.includes('reserved')));
  // attacker cannot change the platform-managed core identity either
  assert.equal(record.core.tenantId, null);
});

test('ingest rejects records with no usable identity', () => {
  assert.throws(() => ingestRecord(DS, [], { name: 'no id' }, null), /needs an 'id'/);
  const withOverride = ingestRecord(DS, [], { ngsiLdId: 'urn:ngsi-ld:Organization:explicit', name: 'x' }, null);
  assert.equal(withOverride.record.entity.id, 'urn:ngsi-ld:Organization:explicit');
});

test('re-ingest bumps version and preserves internal id + created timestamp', () => {
  const first = ingestRecord(DS, registry({ name: 'name' }), { id: '1', name: 'a' }, null).record;
  first.core.internalId = 'internal-1';
  const second = ingestRecord(DS, registry({ name: 'name' }), { id: '1', name: 'b' }, null, first).record;
  assert.equal(second.version, 2);
  assert.equal(second.core.internalId, 'internal-1');
  assert.equal(second.core.createdAt, first.core.createdAt);
  assert.deepEqual(second.attributes.name, { type: 'Property', value: 'b' });
});

test('projection is a structural allowlist — _core never leaks, even with future fields', () => {
  const rec: StoredRecord = {
    datasourceId: 'ds-1',
    entityId: 'urn:ngsi-ld:Organization:1',
    sourceRecordId: '1',
    version: 4,
    core: {
      internalId: '019a1b72-3f51-7b43-92b0-26a042694820',
      tenantId: 'tenant-danang',
      sourceRecordId: '55001',
      // fields a future release might add — none of them may surface
      ownerUserId: 'user-01',
      connectionId: 'conn-01',
      securityLabel: 'restricted',
      secretKey: 'super-secret',
    },
    entity: { id: 'urn:ngsi-ld:Organization:1', type: 'Organization' },
    attributes: { name: { type: 'Property', value: 'ACME' } },
  };
  const out = projectEntity(rec, { registry: registry({ name: 'name' }), contextUrls: ['https://data.example.vn/context/organization.jsonld'] });
  assert.deepEqual(out, {
    id: 'urn:ngsi-ld:Organization:1',
    type: 'Organization',
    name: { type: 'Property', value: 'ACME' },
    '@context': [NGSI_LD_CORE_CONTEXT, 'https://data.example.vn/context/organization.jsonld'],
  });
  const serialized = JSON.stringify(out);
  for (const secret of ['internalId', 'tenantId', '019a1b72', 'sourceRecordId', 'ownerUserId', 'connectionId', 'securityLabel', 'super-secret', '_core']) {
    assert.equal(serialized.includes(secret), false, `projection leaked '${secret}'`);
  }
});

test('projection default-denies unregistered fields and non-public visibility', () => {
  const rec: StoredRecord = {
    datasourceId: 'ds-1',
    entityId: 'urn:ngsi-ld:Organization:1',
    sourceRecordId: '1',
    version: 1,
    core: { internalId: 'i' },
    entity: { id: 'urn:ngsi-ld:Organization:1', type: 'Organization' },
    attributes: {
      name: { type: 'Property', value: 'ACME' },
      taxCode: { type: 'Property', value: 'TAX-1' },
      internalNote: { type: 'Property', value: 'secret note' },
      neverRegistered: { type: 'Property', value: 'draft field' },
    },
  };
  const reg = registry(
    { name: 'name' },
    { name: 'taxCode', visibility: 'restricted' },
    { name: 'internalNote', visibility: 'internal' },
  );
  const pub = projectEntity(rec, { registry: reg });
  assert.deepEqual(Object.keys(pub).sort(), ['@context', 'id', 'name', 'type']);
  const internal = projectEntity(rec, { registry: reg, mode: 'restricted' });
  assert.deepEqual(Object.keys(internal).sort(), ['@context', 'id', 'name', 'taxCode', 'type']);
  // internal never leaves, even in restricted mode
  assert.equal(JSON.stringify(internal).includes('secret note'), false);
  assert.equal(JSON.stringify(internal).includes('draft field'), false);
});

test('resolveIdentity agrees between ingest and lookup paths', () => {
  const raw = { id: '55001', name: 'x' };
  const a = resolveIdentity(DS, raw);
  const b = ingestRecord(DS, [], raw, null).record;
  assert.equal(a.entityId, b.entityId);
  assert.equal(a.sourceRecordId, b.sourceRecordId);
});

test('prototype-chain names are never valid attributes and are quarantined at ingest', () => {
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const v = validateAttributeRegistry([{ name, visibility: 'public' }]);
    assert.equal(v.ok, false, name);
  }
  // JSON.parse creates real own properties for these keys — ingest must
  // quarantine them instead of storing/projecting anything.
  const raw = JSON.parse('{"id":"p1","__proto__":{"polluted":true},"constructor":"c","prototype":"p","name":"ok"}');
  const reg = registry({ name: 'name' });
  const { record, quarantined } = ingestRecord(DS, reg, raw, null);
  const fields = quarantined.map((q) => q.field).sort();
  assert.deepEqual(fields, ['__proto__', 'constructor', 'prototype']);
  assert.equal(({} as any).polluted, undefined, 'prototype must not be polluted');
  const out = projectEntity(record, { registry: reg });
  assert.deepEqual(Object.keys(out).sort(), ['@context', 'id', 'name', 'type']);
  assert.equal(JSON.stringify(out).includes('polluted'), false);
});
