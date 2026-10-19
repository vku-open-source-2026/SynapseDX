/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * NGSI-LD projection layer — the security core of SynapseLDS.
 *
 * Three rules, enforced structurally (never by copy-then-delete):
 *   1. The serializer ONLY reads `entity.id`, `entity.type` and
 *      `attributes.*`. `_core/audit/security/storage/lineage` are never
 *      touched — new metadata fields can be added without any leak risk.
 *      The leading underscore is a naming convention, NOT a security
 *      mechanism (see docs/specs/synapsedx-lds.md).
 *   2. Default deny: an attribute that is not registered in the dataset
 *      schema registry, or whose visibility is not exportable for the
 *      caller, is skipped. New dynamic fields never auto-publish.
 *   3. Reserved attribute names (id, type, @context, internalId, …) are
 *      rejected at registration time so dynamic fields can never squat
 *      on NGSI-LD identity slots.
 */

export const NGSI_LD_CORE_CONTEXT =
  'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.9.jsonld';

/** Attribute names the registry refuses to store: they collide with NGSI-LD
 *  identity members or platform-managed metadata. Checked case-insensitively. */
export const LDS_RESERVED_ATTRIBUTES: string[] = [
  'id',
  '@id',
  'type',
  '@type',
  'context',
  '@context',
  'createdat',
  'modifiedat',
  'observedat',
  'datasetid',
  'instanceid',
  'scope',
  'internalid',
  'tenantid',
  'sourcerecordid',
  '_core',
  'ngsildid',
];

export type NgsiLdType = 'Property' | 'Relationship' | 'GeoProperty';
export type LdsVisibility = 'public' | 'restricted' | 'internal';

export interface RegistryAttribute {
  name: string;
  ngsiLdType: NgsiLdType;
  visibility: LdsVisibility;
  description?: string;
  sourceField?: string;
}

export interface StoredRecord {
  datasourceId: string;
  entityId: string;
  sourceRecordId: string | null;
  version: number;
  /** Private platform metadata. NEVER serialized to any API response. */
  core: Record<string, any>;
  entity: { id: string; type: string };
  /** Dynamic business attributes, already in NGSI-LD shape. */
  attributes: Record<string, any>;
}

export interface DatasourceLike {
  id: string;
  entity_type: string;
}

export interface IngestPrincipal {
  sub?: string | null;
  org?: string | null;
  account?: string | null;
}

export interface IngestResult {
  record: StoredRecord;
  quarantined: Array<{ field: string; reason: string }>;
}

export function isReservedAttributeName(name: string): boolean {
  if (typeof name !== 'string' || !name) return true;
  return LDS_RESERVED_ATTRIBUTES.includes(name.toLowerCase());
}

const ATTRIBUTE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.\-]{0,127}$/;
/** Prototype-chain names: never valid attributes (not exploitable today, but
 *  rejecting them removes a whole class of object-injection surprises). */
const UNSAFE_ATTRIBUTE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export function isValidAttributeName(name: string): boolean {
  return ATTRIBUTE_NAME_RE.test(name) && !UNSAFE_ATTRIBUTE_NAMES.has(name);
}

const NGSI_LD_TYPES: NgsiLdType[] = ['Property', 'Relationship', 'GeoProperty'];
const VISIBILITIES: LdsVisibility[] = ['public', 'restricted', 'internal'];

/** Validate + normalize a PUT /attributes registry payload.
 *  Returns an error object (with the offending names) for reserved or
 *  malformed entries — nothing is partially applied. */
export function validateAttributeRegistry(
  input: unknown,
): { ok: true; value: RegistryAttribute[] } | { ok: false; error: string; message: string; reserved?: string[] } {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'invalid_attributes', message: 'attributes must be an array' };
  }
  if (input.length > 200) {
    return { ok: false, error: 'invalid_attributes', message: 'attributes exceeds 200 entries' };
  }
  const reserved: string[] = [];
  const seen = new Set<string>();
  const out: RegistryAttribute[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_attributes', message: 'attributes[] entries must be objects' };
    }
    const a = raw as any;
    const name = typeof a.name === 'string' ? a.name : '';
    // Reserved names are reported as such (even '@id','@type' which would
    // otherwise look like malformed names) so stewards get the right hint.
    if (name && isReservedAttributeName(name)) {
      reserved.push(name);
      continue;
    }
    if (!name || !isValidAttributeName(name)) {
      return {
        ok: false,
        error: 'invalid_attribute_name',
        message: `attribute name '${String(name).slice(0, 64)}' must match ${ATTRIBUTE_NAME_RE.source}`,
      };
    }
    if (seen.has(name)) {
      return { ok: false, error: 'duplicate_attribute', message: `duplicate attribute '${name}'` };
    }
    seen.add(name);
    const ngsiLdType = a.ngsiLdType === undefined ? 'Property' : String(a.ngsiLdType);
    if (!NGSI_LD_TYPES.includes(ngsiLdType as NgsiLdType)) {
      return {
        ok: false,
        error: 'invalid_attribute_type',
        message: `attribute '${name}': ngsiLdType must be one of ${NGSI_LD_TYPES.join('|')}`,
      };
    }
    // Default deny: unstated visibility becomes the most private bucket.
    const visibility = a.visibility === undefined ? 'internal' : String(a.visibility);
    if (!VISIBILITIES.includes(visibility as LdsVisibility)) {
      return {
        ok: false,
        error: 'invalid_visibility',
        message: `attribute '${name}': visibility must be one of ${VISIBILITIES.join('|')}`,
      };
    }
    const entry: RegistryAttribute = { name, ngsiLdType: ngsiLdType as NgsiLdType, visibility: visibility as LdsVisibility };
    if (a.description !== undefined) {
      const d = String(a.description);
      if (d.length > 300) {
        return { ok: false, error: 'invalid_attributes', message: `attribute '${name}': description ≤300 chars` };
      }
      entry.description = d;
    }
    if (a.sourceField !== undefined) {
      const s = String(a.sourceField);
      if (!s || s.length > 128) {
        return { ok: false, error: 'invalid_attributes', message: `attribute '${name}': sourceField 1..128 chars` };
      }
      entry.sourceField = s;
    }
    out.push(entry);
  }
  if (reserved.length) {
    return {
      ok: false,
      error: 'reserved_attribute',
      message: `reserved attribute name(s) cannot be registered: ${reserved.join(', ')} — map them via sourceField instead`,
      reserved,
    };
  }
  return { ok: true, value: out };
}

/** NGSI-LD entity ids must be URIs. Source records keep their own id in
 *  `_core.sourceRecordId`; the public id is derived (or explicitly provided
 *  as a urn:/http(s) IRI by the connector). */
export function buildEntityId(entityType: string, sourceRecordId: string, override?: string): string {
  if (override && typeof override === 'string') {
    const o = override.trim();
    if (/^(urn:|https?:\/\/)/i.test(o) && o.length <= 512 && !/[\r\n]/.test(o)) return o;
  }
  const type = String(entityType || 'Entity').replace(/[^A-Za-z0-9_-]/g, '');
  const id = encodeURIComponent(String(sourceRecordId ?? '')).slice(0, 256);
  return `urn:ngsi-ld:${type || 'Entity'}:${id}`;
}

const IDENTITY_KEYS = new Set(['id', '@id', 'type', '@type', '@context', 'ngsildid', 'sourceid']);

/** Convert one dynamic field value into an NGSI-LD attribute object.
 *  Values that already carry a valid NGSI-LD `type` pass through untouched
 *  (round-trip safe); plain values become Property/Relationship/GeoProperty
 *  according to the registry definition. */
export function toNgsiLdAttribute(name: string, value: any, def?: RegistryAttribute): any {
  if (value && typeof value === 'object' && !Array.isArray(value) && NGSI_LD_TYPES.includes(value.type)) {
    return value;
  }
  const kind = def?.ngsiLdType || 'Property';
  if (kind === 'Relationship') {
    const object = typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.object ?? value.id ?? '') : String(value ?? '');
    if (!object) throw new Error(`attribute '${name}': Relationship needs a non-empty object IRI`);
    return { type: 'Relationship', object };
  }
  if (kind === 'GeoProperty') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`attribute '${name}': GeoProperty needs a GeoJSON object`);
    }
    return { type: 'GeoProperty', value };
  }
  return { type: 'Property', value };
}

/** Resolve the public identity (entity IRI + source id + type) for a raw
 *  record against its datasource. Single source of truth shared by ingest
 *  and the record-upsert path so lookups always agree. */
export function resolveIdentity(
  datasource: DatasourceLike,
  raw: Record<string, any>,
  previous?: StoredRecord | null,
): { entityId: string; sourceRecordId: string | null; entityType: string } {
  const rawType = raw.type ?? raw['@type'];
  const entityType = typeof rawType === 'string' && rawType.trim() ? rawType.trim().slice(0, 128) : datasource.entity_type;
  const overrideSrc =
    typeof raw.ngsiLdId === 'string' ? raw.ngsiLdId : typeof raw['@id'] === 'string' && /^(urn:|https?:\/\/)/i.test(raw['@id']) ? raw['@id'] : undefined;
  const sourceRecordId =
    raw.id !== undefined && raw.id !== null
      ? String(raw.id)
      : typeof raw['@id'] === 'string' && !/^(urn:|https?:\/\/)/i.test(raw['@id'])
        ? String(raw['@id'])
        : previous?.sourceRecordId ?? null;
  if (!sourceRecordId && !overrideSrc) {
    throw new Error("record needs an 'id' (source id) or an explicit 'ngsiLdId'/'@id' IRI");
  }
  return { entityId: buildEntityId(entityType, sourceRecordId ?? overrideSrc!, overrideSrc), sourceRecordId, entityType };
}

/**
 * Map one raw connector record into the split storage model:
 *   _core (private) + entity (public identity) + attributes (dynamic).
 *
 * - reserved field names are quarantined (never silently promoted),
 * - unregistered fields are stored anyway (business data is not lost) but
 *   default-deny keeps them out of exports until a steward registers them,
 * - identity fields never become attributes (no id-squatting).
 */
export function ingestRecord(
  datasource: DatasourceLike,
  registry: RegistryAttribute[],
  raw: Record<string, any>,
  principal: IngestPrincipal | null,
  previous?: StoredRecord | null,
): IngestResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('record must be a JSON object');
  }
  const quarantined: Array<{ field: string; reason: string }> = [];
  const { entityId, sourceRecordId, entityType } = resolveIdentity(datasource, raw, previous);
  const now = new Date().toISOString();
  // Null-prototype map: assigning a dynamic key can never touch Object.prototype.
  const attributes: Record<string, any> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    if (IDENTITY_KEYS.has(lower)) continue; // identity is handled above, never an attribute
    if (isReservedAttributeName(key)) {
      quarantined.push({ field: key, reason: 'reserved name — platform metadata cannot be set by records' });
      continue;
    }
    if (!isValidAttributeName(key)) {
      quarantined.push({ field: key, reason: 'invalid attribute name' });
      continue;
    }
    const def = registry.find((a) => a.name === key || a.sourceField === key);
    try {
      attributes[def ? def.name : key] = toNgsiLdAttribute(key, value, def);
    } catch (e: any) {
      quarantined.push({ field: key, reason: String(e?.message || e).slice(0, 200) });
    }
  }
  const core: Record<string, any> = {
    internalId: previous?.core?.internalId ?? undefined,
    tenantId: principal?.org ?? previous?.core?.tenantId ?? null,
    accountId: principal?.account ?? previous?.core?.accountId ?? null,
    datasourceId: datasource.id,
    sourceRecordId: sourceRecordId ?? null,
    version: (previous?.version ?? 0) + 1,
    ingestedBy: principal?.sub ?? previous?.core?.ingestedBy ?? null,
    createdAt: previous?.core?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    record: {
      datasourceId: datasource.id,
      entityId,
      sourceRecordId: sourceRecordId ?? null,
      version: core.version,
      core,
      entity: { id: entityId, type: entityType },
      attributes,
    },
    quarantined,
  };
}

export type ProjectionMode = 'public' | 'restricted';

/** STRUCTURAL ALLOWLIST — the only function allowed to turn a stored record
 *  into an API payload. It builds a fresh object from entity + registry-
 *  approved attributes and never reads `_core` (or any other region), so no
 *  amount of new metadata fields can leak through serialization. */
export function projectEntity(
  record: StoredRecord,
  opts: { registry: RegistryAttribute[]; contextUrls?: string[]; mode?: ProjectionMode },
): any {
  const mode: ProjectionMode = opts.mode === 'restricted' ? 'restricted' : 'public';
  const allowedVisibility = mode === 'restricted' ? new Set(['public', 'restricted']) : new Set(['public']);
  const out: any = {
    id: record.entity.id,
    type: record.entity.type,
  };
  for (const [name, attribute] of Object.entries(record.attributes || {})) {
    if (isReservedAttributeName(name)) continue; // belt & braces: reserved never project
    const def = opts.registry.find((a) => a.name === name);
    if (!def) continue; // default deny — unregistered field
    if (!allowedVisibility.has(def.visibility)) continue; // policy filter
    out[name] = attribute;
  }
  out['@context'] = [NGSI_LD_CORE_CONTEXT, ...(opts.contextUrls || [])];
  return out;
}
