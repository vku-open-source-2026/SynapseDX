/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseLDS (Linked Data Service) — design spec: linked-data export of
 * datasource records through a structural allowlist projection.
 */

# SynapseLDS (Linked Data Service) — Design Spec

LDS exports datasource records as linked data (NGSI-LD-flavoured JSON-LD) through a
**structural allowlist projection**: the serializer can only read the fields it is
written to read. Status: **frozen design** — endpoints and rules below are normative;
JSON bodies are realistic examples.

## Problem

Core records store admin metadata (`internalId`, `tenantId`, `sourceRecordId`, audit
fields…) in the same object as dynamic business attributes. Blacklist-delete
serialization ("serialize everything, then `delete` the known-internal keys") leaks
every new metadata field added later: each exporter must remember to delete it, and
one miss is a data leak.

## Solution: structural allowlist projection

The export serializer is **only** allowed to read:

- `entity.id`, `entity.type` — the NGSI-LD identity of the record;
- `attributes.*` — filtered through the dataset schema registry.

It never reads `_core`, audit, security, storage or lineage — not because those are
deleted afterwards, but because no code path touches them. There is **no
`delete`-based blacklist anywhere** in the export path. The underscore in `_core` is
a naming convention, **not** a security control; security comes from the allowlist.

## Storage model (per record)

```json
{
  "_core": {
    "internalId": "rec_01J8Z9Q2H3",
    "tenantId": "acme",
    "datasourceId": "ds_airquality",
    "sourceRecordId": "station-42",
    "version": 8,
    "ingestedBy": "workflow/etl-nightly",
    "createdAt": "2026-10-18T11:00:03Z",
    "updatedAt": "2026-10-18T11:00:03Z"
  },
  "entity": {
    "id": "urn:ngsi-ld:AirQualityObserved:station-42",
    "type": "AirQualityObserved"
  },
  "attributes": {
    "pm25": { "type": "Property", "value": 12.4, "unitCode": "GQ" },
    "noiseDb": { "type": "Property", "value": 71 },
    "entry": { "type": "Relationship", "object": "urn:ngsi-ld:Building:city-hall" },
    "location": { "type": "GeoProperty", "value": { "type": "Point", "coordinates": [105.83, 21.03] } }
  }
}
```

## Registry: default deny

An attribute becomes exportable only by being registered in the datasource's dataset
schema registry. Unregistered attributes are still accepted and stored (no ingestion
loss), but are forced to `visibility=internal` and are **never exported**.

### Reserved attribute names (rejected at registration)

`id`, `@id`, `type`, `@type`, `@context`, `createdAt`, `modifiedAt`, `observedAt`,
`datasetId`, `instanceId`, `scope`, `internalId`, `tenantId`, `sourceRecordId`,
`_core`.

Reserved names cannot be shadowed by business attributes: identity, audit and
tenancy fields stay owned by the platform. Matching is case-insensitive.

## Visibility

| Level | Stored | Exported in NGSI-LD | Who can read |
|---|---|---|---|
| `public` | yes | yes | anyone reaching the API (no token needed on the public export routes) |
| `restricted` | yes | only via authenticated same-tenant query | callers in the datasource's org (or owning account) |
| `internal` | yes | never | never leaves the API |

The **public channel** is anonymous by design: the gateway marks the export
routes (`GET /v1/lds/licenses`, `GET /v1/lds/datasources/:id/entities[/:eid]`,
single path segment) as `auth: none` and stamps `x-synapseone-anon: 1`
(client-forged markers are stripped). A Bearer token that verifies is honoured
as *optional* auth on public routes (so same-tenant `?visibility=restricted`
queries reuse the same URL); an invalid or absent token stays anonymous. An
anonymous consumer gets exactly the
public projection slice — license surfacing included — and is refused
(`401 auth_required`) for everything else: writes, the registry, stats, listing
and `?visibility=restricted`. Authenticated callers from a *different* tenant
keep existence-privacy (`404`) — the anonymous route is the intended sharing
channel for published datasets. Direct `:4004` calls with the internal
credential but no principal are the platform (ops) class: full access, never
reachable through the edge.

## Licenses

Built-in catalog (fixed identifiers): `CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`,
`ODbL-1.0`, `PDDL-1.0`, plus `LicenseRef-Proprietary` (not open data). The user
picks one license per datasource at create/update time.

The license surfaces on every export in three places:

- `Link: <license-url>; rel="license"` response header,
- the license URL inside the export `@context`, and
- the license id in the `X-LDS-License` response header.

## API

Gateway proxy: `/v1/lds/*` → `lds-service:4004`. Auth is the standard gateway
either/or — `Authorization: Bearer <JWT>` or `X-API-Key`; direct `:4004` calls
additionally need the internal credential (see `SECURITY.md`). Every management
route is tenant-scoped from the propagated principal; the export/license read
surface is additionally open anonymously (see **Visibility**).

- `GET /v1/lds/licenses` → built-in catalog (bare array; `openData:false` marks
  not-open licenses — `LicenseRef-Proprietary` is reported as not-open).

```json
[
  { "id": "CC0-1.0", "name": "Creative Commons Zero 1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/", "openData": true },
  { "id": "CC-BY-4.0", "name": "Creative Commons Attribution 4.0", "url": "https://creativecommons.org/licenses/by/4.0/", "openData": true },
  { "id": "CC-BY-SA-4.0", "name": "Creative Commons Attribution-ShareAlike 4.0", "url": "https://creativecommons.org/licenses/by-sa/4.0/", "openData": true },
  { "id": "ODbL-1.0", "name": "Open Database License 1.0", "url": "https://opendatacommons.org/licenses/odbl/1.0/", "openData": true },
  { "id": "PDDL-1.0", "name": "Public Domain Dedication and License 1.0", "url": "https://opendatacommons.org/licenses/pddl/1.0/", "openData": true },
  { "id": "LicenseRef-Proprietary", "name": "Proprietary", "url": "https://synapseone.space/licenses/proprietary", "openData": false }
]
```

- `GET /v1/lds/datasources` → datasources in the caller's tenant.
- `POST /v1/lds/datasources` → create.

```json
{ "slug": "hanoi-air-quality", "name": "Hanoi air quality",
  "entityType": "AirQualityObserved", "license": "CC-BY-4.0" }
```

```json
{ "id": "ds_airquality", "slug": "hanoi-air-quality", "name": "Hanoi air quality",
  "entityType": "AirQualityObserved",
  "license": "CC-BY-4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
  "createdAt": "2026-10-18T09:00:00Z" }
```

- `GET /v1/lds/datasources/:id` — one datasource.
- `PATCH /v1/lds/datasources/:id` — partial update (name, license, …).
- `DELETE /v1/lds/datasources/:id` → `{ "ok": true }` (records included).
- `GET /v1/lds/datasources/:id/attributes` — current registry.
- `PUT /v1/lds/datasources/:id/attributes` — replace the registry.

```json
{ "attributes": [
  { "name": "pm25", "ngsiLdType": "Property", "visibility": "public" },
  { "name": "noiseDb", "ngsiLdType": "Property", "visibility": "restricted" },
  { "name": "entry", "ngsiLdType": "Relationship", "visibility": "public" },
  { "name": "ownerNotes", "ngsiLdType": "Property", "visibility": "internal" }
] }
```

Registry entries default to `ngsiLdType=Property` and `visibility=internal`; stored
attribute objects then carry the NGSI-LD `type` member. Reserved or malformed names
→ `400`, nothing is registered.

- `POST /v1/lds/datasources/:id/records` — ingest one (flat) record; reserved field
  names are quarantined (reported back, never promoted), and `_core` is stamped
  server-side (`internalId`, `tenantId`, `datasourceId`, `sourceRecordId`, `version`,
  timestamps).

```json
{ "id": "station-42",
  "type": "AirQualityObserved",
  "pm25": 13.1,
  "noiseDb": 72 }
```

```json
{ "entityId": "urn:ngsi-ld:AirQualityObserved:station-42",
  "version": 9, "quarantined": [] }
```

- `GET /v1/lds/datasources/:id/entities?limit=50&offset=0&visibility=public` —
  NGSI-LD export. `limit` 1..500, `offset` ≥ 0 (invalid values → `400`),
  `visibility=public|restricted` (default `public`).

```json
{
  "@context": ["https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.9.jsonld",
               "https://creativecommons.org/licenses/by/4.0/"],
  "id": "urn:ngsi-ld:AirQualityObserved:station-42",
  "type": "AirQualityObserved",
  "pm25": { "type": "Property", "value": 13.1, "unitCode": "GQ" },
  "location": { "type": "GeoProperty", "value": { "type": "Point", "coordinates": [105.83, 21.03] } }
}
```

with `Link: <https://creativecommons.org/licenses/by/4.0/>; rel="license"` and
`X-LDS-License: CC-BY-4.0` on the response. `internal` attributes and everything
outside `entity` + registered `attributes` are absent **by construction**.

- `GET /v1/lds/datasources/:id/entities/:entityId` — one entity (URN, URL-encoded),
  same projection; not found or not visible to the caller → `404`.
- `GET /v1/lds/datasources/:id/stats` — counters for dashboards and guards.

```json
{ "records": 42,
  "attributes": { "public": 6, "restricted": 1, "internal": 2 },
  "lastIngestAt": "2026-10-18T12:00:04Z" }
```

## Workflow integration

The `synapseone.api` node type gains resource `lds`:

| Resource.operation | Required args | Optional args |
|---|---|---|
| `lds.list-datasources` | — | — |
| `lds.publish-record` | `datasourceId` | `record` (object) |

`record` values support `={{ $json.x }}` templates and are deep-resolved against the
incoming item at run time. Unknown resource/operation and missing required args are
rejected at save time (same validation path as the other `synapseone.api` resources).

```json
{ "resource": "lds", "operation": "publish-record",
  "input": { "datasourceId": "ds_airquality",
             "record": { "id": "={{ $json.id }}",
                         "type": "AirQualityObserved",
                         "pm25": "={{ $json.pm25 }}" } } }
```

Built-in template `webhook-to-lds`: webhook trigger → publish to LDS → noOp — a
received Webhook item is published to a datasource with no extra nodes.

## Acceptance criteria

- [ ] Datasource + attributes-registry CRUD works through the gateway with JWT and API key alike.
- [ ] Unregistered attribute: accepted at ingest, persisted, `visibility=internal`, absent from every export (default deny).
- [ ] All 15 reserved attribute names are rejected at registration with `400`.
- [ ] Serializer regression proof: a new top-level field added to a stored record (next to `_core`) appears in no export.
- [ ] `visibility=restricted` export requires an authenticated same-tenant call; cross-org callers get `404`, anonymous callers get `401`, never data.
- [ ] `limit` is validated to 1..500 (`400` otherwise) and `offset` paging is stable and ordered.
- [ ] Every export carries `Link rel="license"`, the license URL in `@context`, and the id in `X-LDS-License`; `LicenseRef-Proprietary` is reported as not-open.
- [ ] `synapseone.api` save-time validation covers `lds.list-datasources` (no args) and `lds.publish-record` (requires `datasourceId`).
- [ ] Template `webhook-to-lds` builds a valid webhook → publish → noOp definition.
- [ ] `GET /v1/lds/datasources/:id/stats` reports the record count and public/restricted/internal attribute counts.

## Threat model

| Threat | Vector | Mitigation |
|---|---|---|
| Metadata leak | A new admin field (`reviewState`, `ownerTeam`, …) is added to storage after LDS ships and is forgotten by a blacklist delete | Structural allowlist projection: the serializer reads only `entity.id`, `entity.type` and registered `attributes.*`; regression test asserts new top-level fields never appear |
| Reserved-word squatting | Registering attributes named `@id`, `type`, `createdAt`, … to shadow or overwrite NGSI-LD identity/semantics | Reserved list rejected at registration (`400`); only registered attributes are ever exported; `_core` is never readable by the serializer |
| Cross-tenant access | Guessing `:id`/`:entityId` values belonging to another org | Every management route tenant-scoped from the propagated principal; `restricted` requires an authenticated same-tenant query; misses return `404` and leak no existence hints. The anonymous channel serves only the public projection of a deliberately shared dataset and can never escalate (no writes, no restricted, no registry) |
| License violation | Exporting under a license the datasource did not pick, or with no attribution at all | License is chosen per datasource from the fixed built-in catalog and frozen into every export via `Link rel="license"` + `@context`; proprietary content never gets an implicit open license |

Underscore is convention, not security: adding `_foo` to storage grants it no
protection and removing the underscore grants it no exposure — only the registry
and the allowlist decide what leaves the API.
