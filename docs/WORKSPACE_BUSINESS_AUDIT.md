# Workspace business audit — 2026-11-15

This audit covers the 14 operational plugins per product, their archived coded
console sources, DX runtime, app grants and Common capabilities. A declarative
form is not by itself evidence of feature parity or successful production
workflow completion. The original console sources remain archived in each
product's `plugins/source/`; they are not DX runtime imports.

## Authorization findings and fixes

| Finding | Resolution |
| --- | --- |
| Manager/operator could navigate to DX administration | `/admin` requires the server's verified `isOrganizationAdmin`; Studio edit CTA is restricted to verified organization admins |
| Global member roles could authorize both products | Explicit per-app grants; legacy global roles give no app membership |
| Shared DX starter implied one cross-product team | Retired; separate City/SOS Common workspace plugins and app-scoped capability storage |
| Secondary wiki/inbox/report endpoints could escape app scope | Scope applied to direct page/detail/search, project capacity, report schedules and intelligence routes too |
| Raw dataset writes could bypass product workflow authorization | Human product writes require protected workspace actions; metadata list filters app grants before pagination |
| Common CRUD permission could imply private product dataset authority | Preserve original dataset scopes; app-scoped CRUD does not broaden source-dataset read permission |
| Tables lost the capability record ID when projecting `id` | Stable capability record IDs retained for details/actions |
| Large form walls required copying identifiers manually | Action dialogs, selectable records, contextual prefill and destructive-action confirmation |
| Saving existing plugins sent the immutable product field | Update requests omit product; existing City/SOS IDs, resources and workflow bindings survive save/publish |
| Complex UI and business code required editing repository files | Component Code Studio plus Workflow Studio JavaScript node editor, versioned saves and protected runtime bindings |
| Maps were missing | Real tiles and record geometry; invalid coordinates rejected, paging and provider errors explicit |

Public projections remain public; private/source data and operational mutations
remain authenticated. A product app-admin grant never changes organization-admin
status. App context headers are selectors, never authorization evidence.

## Core operational coverage

| Product area | Current plugin surface |
| --- | --- |
| City assets/GIS | Registry CRUD, searchable records, details, asset/incident/geofence maps, geofence actions |
| City incidents | Intake, assignment, resolution and declared lifecycle/review actions |
| City maintenance | Work orders, assignment/start/complete, technician/review queues |
| City IoT | Sensor CRUD, readings entry and map |
| City administration | Alerts, budget/transaction decisions, operator profiles, reports and ingest job actions |
| SOS command | Events, status/phase actions, emergency map and command overview |
| SOS response | Dispatch decisions/status, resources, responder/rescue views and location maps |
| SOS planning/evidence | EOP, SITREP, AAR and approval/review actions |
| SOS intelligence/aid | Hazard layers/ingest actions and mutual-aid records |
| Common plugins | Tasks/projects, wiki, inbox, forms/process, reports, OCR and assistant; restricted governance tools require administration |

## LCDP scope

Product pages and the two Common plugins are portable JSON. Common v3 has 39
widgets across eight sections, without embedded React module screens. Studio
supports their field/reference bindings, inline/dialog forms, layout, Kanban
status actions, timeline and text. The runtime follows JSON ordering and widths.
The shell/sidebar and reusable widget/interaction implementations remain coded.
Opaque `capability` embeds cannot be published; use declarative components or a scoped code widget. See
`WORKSPACE_STUDIO.md` for collection limits and the binary upload limitation.

## Live capability event feed (SSE)

SOS hazard/SITREP and City operations pages consume capability events without
polling through `GET /v1/capabilities/events/stream`. This is a generic Tier-2
transport over the existing Tier-1 capability stream; it adds no queue,
database or product-specific logic.

- **Auth model:** the caller supplies a verified Tier-1 `Authorization: Bearer`
  or `X-API-Key` header. Tier-2 verifies it with IAM before any SSE header is
  written and forwards that same credential to Tier-1. The credential is never
  placed in a query string or an SSE `data:` field. A browser `EventSource`
  cannot attach these headers, so it is not a supported client; Tier-3 uses the
  capabilities SDK, which reads the body as a stream over `fetch`.
- **Wire format:** `retry: 3000`, then `event: ready` with
  `{cursor,stream,filters}`, then one frame per event:
  `id: <Tier-1 stream id>`, `event: capability`,
  `data: {"id":…,"event":{CapabilityEvent}}`. A `: keepalive` comment is sent
  after 15 s of idleness. The response is
  `text/event-stream; charset=utf-8`, `no-cache, no-transform`,
  `x-accel-buffering: no`.
- **Cursor and replay:** `Last-Event-ID` is the preferred cursor; explicit
  `?since=` wins when both are present. With neither, the server resolves the
  current tail with a one-record `range` read and never replays history. The
  cursor advances for filtered-out records, so `type`/`datasetId` filters
  cannot pin the reader to one record.
- **Lifecycle:** polling uses non-blocking `read(cursor, 100)` calls no more
  than once per second while idle (a full backlog is drained immediately); a
  missing topic (404) keeps the connection open until it is created. The server
  closes with `event: reconnect` after 30 minutes so clients reconnect with
  their last id. Client disconnect, write errors and the per-process limit of
  100 concurrent streams (503 `stream_capacity`) are enforced server-side; no
  process-local event buffer is kept.
- **Deployment prerequisite:** the public edge forwards `Last-Event-ID` and
  passes `text/event-stream` responses through without buffering or applying a
  whole-response timeout. The 0.9.12 release adds the streaming branch to the
  Rust gateway, an exact unbuffered location to both nginx layers, and
  `last-event-id` to CORS. The route is therefore reachable at
  `https://synapsedx.sbs/v1/capabilities/events/stream`.

## Server-side spatial queries

A dataset may declare `geo: {field: "<dotted record.data path>"}`. Record
writes validate WGS84 GeoJSON before the Base write and mirror the geometry into
a per-dataset SynapseBase PostGIS collection (`synapsedx_geo_<datasetId>`).
`POST /v1/capabilities/datasets/:id/records/spatial` accepts `near`, `bbox` or
`within` (Polygon/MultiPolygon), returns a FeatureCollection plus the normal
record response items, and re-checks record visibility so a stale index cannot
expose a withheld draft. `spatial.reindex` repairs up to 5,000 records per call;
`spatial.status` reports the collection and feature count. Index maintenance is
best-effort and never fails the authoritative Base write. City assets
(`geometry`) and incidents (`location.geometry`) can bind directly; page/API
adoption is tracked separately from capability availability.

## Deterministic assignment optimization

`POST /v1/capabilities/optimization/assign` is a domain-neutral
resource-to-demand solver: capacities, skills, optional `costMatrix` or
haversine distance, priority as an equal-cost tie-break, distance limits and
explicit unassigned reasons. It maximizes served demands with a b-flow stage,
then minimizes total cost by successive shortest paths; 200×200 inputs are
bounded and deterministic. It does not mutate SOS dispatch state; applying and
approving a plan remains the product's reviewed workflow.

## Plan orchestration (EOP)

`/v1/capabilities/plans` provides tenant-scoped phased plans with CAS
transitions, activation-time due dates, dependency-aware task status, a grounded
brief and an AI-assisted draft with deterministic fallback. AI output is
validated by the same plan validator and drafts are never persisted. SOS retains
EOP policy, approvals, publication and dispatch semantics.

## Parity gaps requiring product-owned implementation and verification

The following advanced coded-console features are not established as equivalent
by this release. They must not be advertised as complete merely because a generic
CRUD/execute form exists. Some legacy UI paths themselves used mock/stub results.

- City: lifecycle health/risk/history calculations; document/photo report flows;
  incident comments/upvotes and duplicate/merge workflows; preventive schedules;
  IoT batch/statistics; actual CSV upload/preview; generated report download.
  City nearby/bounds/polygon now call the Tier-2 spatial index with an
  in-memory fallback.
- SOS: applying/animating dispatch plans through the product workflow over the
  generic Tier-2 `optimization.assign` solver (the solver contract is in
  [OPTIMIZATION.md](OPTIMIZATION.md); SOS must still review and apply results
  through its own actions); adopting the Tier-2 SSE feed in place of the current
  dataset poller; connecting the generic plan orchestration to SOS EOP approval,
  publication and AI draft policy; rich EOP editing; live hazard
  timeline/deploy/expire; SITREP deltas and event-related views. SOS hazard
  near/polygon now call the Tier-2 spatial index with an in-memory fallback.
- Identity: app-grant editor stores tenant-scoped verified subject IDs, but does
  not yet validate target-subject existence in IAM when creating a grant.
- Migration: old organization-wide H-D-P-I records are preserved. Automatic
  assignment/copy to City and SOS would invent ownership; a destination-aware
  record migration is separate from plugin/layout import.

Business implementations belong to the owning product's portable workflow source
and must retain revision/checksum pins, state-transition/CAS rules and technical
credential ownership. No cross-product API, local database or copied user table is
introduced as a workaround.

## Release evidence

Backend authorization/isolation tests exercise members assigned to both apps,
app revocation, legacy roles, header spoofing, direct wiki IDs, tasks/projects,
inbox and raw dataset bypass. Browser tests exercise app-specific navigation,
Common context headers, non-admin route refusal, Studio templates/drag-drop and
responsive layouts. Map parsing tests cover JSON/GeoJSON and invalid coordinates.
Production release checks are recorded in the server-local `SERVER_AGENT.md`.

## Explicit action and data-source governance

The previous button-only registry left legacy form submissions, automatic reads,
board moves, reference options and navigation outside the Actions inventory. All
those declarative paths now require persisted actions and event references. The
server checks the immutable page registry before exposing technical read/mutation
bindings, including the code-widget exception's declared source/form bindings.
Missing query connections perform no network read; missing submit connections
stay disabled. Publication rejects incomplete connections and retired opaque
capability embeds. Preset fixed values and declared input fields are checked again
on the server. App membership,tenant isolation and pinned workflows remain required.

Existing layouts convert to explicit query,submit,open-form,row,export,board and
navigation actions through an idempotent authoring migration. Conversion preserves
source bindings,visual components and server pins; production releases add immutable
versions and audit instead of editing historical snapshots. Each Common workspace
keeps its own product context and membership. See WORKSPACE_STUDIO.md for supported
presets,event mappings,read-only query functions,charts and bounded preview behavior.

## Detailed buildability verification

See [LCDP_BUILDABILITY_AUDIT.md](LCDP_BUILDABILITY_AUDIT.md) for the 30-page inventory, source-versus-published checks, the repaired production workflow-pin defect, runtime regressions and remaining business parity gaps. Full legacy feature replacement is not established.
