# LCDP buildability and business parity audit — 2026-11-15

**Verdict: the 30 current City/SOS pages can be edited and rendered from SynapseDX configuration. Full replacement of every feature in the archived coded workspaces is not established.** Creating a form or changing a record status does not prove that the corresponding business process is implemented.

## What was verified

- All 30 source bundles pass the current DX schema, action governance and build/import round-trip after simulated import-time workflow reference resolution. Each product keeps its own source and data boundaries.
- The real bundle definitions contain 874 named actions, no `code` widgets and no opaque `capability` embeds. Their UI composition uses standard DX components. The shell, renderer primitives and underlying capabilities are platform code.
- Browser tests open every source page in Studio, edit a heading, save a fixture draft and render every declared section. Query requests must identify the published action and match its catalog source. These are fixture-backed authoring/runtime tests, not real member business writes.
- Read-only production SDK inventory matches source configuration for all 30 published pages, their immutable snapshots and installations. All 105 current product form bindings now match protected, same-tenant workflow artifacts.
- A read-only SDK probe verifies all 22 actual Tier-1 workflow graphs against their reviewed checksums, the organization technical identity and the engine credential-origin guard. The executor pins the just-read live revision after checking its graph; a cached revision number can differ after activation without a graph change.
- Existing product workflow engine tests run selected creates, state transitions, AAR generation, terminal-state refusal and CAS conflicts against the real engine with fake HTTP. They do not exercise every decision in the generic action workflows or live production writes.

## Production defect found and repaired

The prior registry migration built new immutable snapshots from draft widgets. Drafts intentionally omit server-owned workflow pins; the migration therefore dropped revision/checksum pins from **107 forms in 27 operational pages**. Those forms were disabled by the server, and building their published bundles would also fail. The earlier claim that all pins were preserved was incorrect.

The repair publishes new v7 snapshots using the exact pins from the prior reviewed v5 snapshots. Each of the 107 bindings still matches the current artifact graph and revision. Current declarative widgets/actions are retained; draft definitions are unchanged. Existing immutable history, 30 installs, two membership records and 20 workflow artifacts are preserved. Common pages and the read-only SOS volunteer page need no pin repair. Business records were not changed.

`npm run audit:workspaces -- --inventory <private-sdk-inventory.json>` now checks published snapshots, checksums, workflow ownership/pins and source equality. It fails against the inventory captured before this repair and passes against the repaired inventory. Inventory files remain private, outside git, and are never included in plugin bundles.

## Other defects fixed

| Defect | Result |
| --- | --- |
| Reference-option endpoints ignored query mappings | Fixed and required values are checked server-side; search/status/sort/pagination are applied. Native reference selects use the registry executor and refresh when their mapped inputs change. Truncated options are disclosed. |
| Product status filters were ignored when status was not a visible column | Status reaches persistence for tables and metrics independently of display columns. Text search includes published record IDs and rejects sources without published search columns instead of silently ignoring a filter. |
| Record details picked the first widget with a matching resource | Selection carries the originating widget/action; details use that exact published binding. Selected-record mappings respect origin too. |
| Pagination always moved 50 rows | Next advances by returned rows; Previous keeps visited offsets. Query limit/offset survive parsing. A delayed initial search timer no longer resets pagination. Controls without corresponding input mappings are disabled. |
| Deep action DAGs could pass depending on declaration order | Validation computes subtree height and worst-case cost; chains are acyclic, at most 12 edges deep and at most 128 native executions. Runtime validates before the first mutation and enforces the budget again. |
| Structured JSON mappings failed ordinary form validation | Declared JSON fields accept objects/arrays and normalize them into the existing JSON text contract. Other field types still reject structured values. |
| Section templates retained actions targeting removed widgets | Slice the visual template first, then author its explicit actions. All eight H-D-P-I templates pass governance independently. |

## Remaining gaps against the coded workspaces

| Area | Current configuration can do | Still missing or not established as equivalent |
| --- | --- | --- |
| City assets / GIS | Registry, tables, record detail, CRUD forms, geometry display, native Point/LineString/Polygon drawing/vertex editing; City nearby/bounds/polygon call the Tier-2 PostGIS index with an in-memory fallback | Lifecycle health/risk/history panels; document/photo flows |
| City incidents / technician work | Intake, assignment and workflow-backed transitions, contextual forms | Rich comments/internal visibility, upvotes, duplicate detection/merge; a generic note/status field is not equivalent |
| City maintenance | Work orders and selected checked state transitions | Preventive schedules and full review/technician workflow parity |
| City IoT / budgets / people | Declared registry/reading/decision forms | Batch sensor ingestion/statistics and exhaustive business validation/decision parity; creating an operator record does not create an IAM account |
| City ingest / reports | Native CSV preview/upload, validated resumable asset batches with duplicate/error results; five actual CSV/JSON report artifacts and governed download | Large-file streaming and formats beyond CSV/JSON; exhaustive archived report edge cases |
| SOS dispatch / rescue | Orders, assignments, statuses, resource maps | Dispatch optimization and complete event-linked operational context |
| SOS EOP / command | Plan/event records and lifecycle forms; generic Tier-2 phased-plan orchestration with CAS, dependency-aware tasks, grounded brief and validated AI draft | Rich plan editor; connecting the generic plan lifecycle to SOS EOP approval, publication and AI policy |
| SOS hazards / SITREP | Layer/ingest metadata, maps, JSON fields, Tier-2 SSE and spatial near/polygon adoption with in-memory fallback | Product adoption of SSE in place of its dataset poller; timeline, actual deploy/expire/ingest processing, calculated SITREP deltas and related-event views. Writing JSON fields alone does not implement these processes. |
| Common workspace | Independent per-app declarative tasks/projects/wiki/inbox/forms/reports/OCR/assistant/files, native upload/download and visual schema/query editors with typed filters | Destination-aware migration of old organization H-D-P-I records |
| Studio | Declarative native widgets, named actions/functions and a code editor per widget | Full Appsmith-equivalent authoring is not claimed. Native sequence/condition/mapping preview now runs a simulated interpreter, including declared reference fixtures; broad authoring coverage still needs extension. |

The archived sources are evidence, not runtime dependencies: City `plugins/source/apps/console/src/pages/admin/{AssetDetail,DataIngest}.tsx`, `pages/incidents/IncidentDetail.tsx`; SOS `plugins/source/apps/console/src/pages/emergency/` and its archived components. Some original functions used stubs, so they also require business acceptance criteria rather than visual imitation.

Custom widget/function code is an explicit extension point for presentation and declared bindings. It cannot access arbitrary network/DOM/npm or invent an unavailable backend operation. Missing business operations require product-owned reviewed workflows and, where needed, new reusable DX capability/widget contracts. The 0.9.12 release supplies the generic spatial-query, SSE and assignment/plan-orchestration connectors; page/runtime adoption and business acceptance remain separate work.

Other limits remain explicit: 64 visual components and 128 actions per page; allowlisted catalog queries rather than general SQL/joins; Common collections have bounded loading; charts aggregate the loaded page. These are material limits when deciding whether an advanced page can be built completely.

## Source inventory

All entries below passed source schema/governance/build-import checks and fixture browser authoring/render checks. A pass is **configuration buildability**, not a declaration of complete legacy business parity.

| Page | Visual widgets | Actions | Forms |
| --- | ---: | ---: | ---: |
| `city-alert-center` | 12 | 19 | 4 |
| `city-asset-registry` | 13 | 23 | 3 |
| `city-budget-office` | 14 | 24 | 5 |
| `city-common-workspace` | 42 | 103 | 21 |
| `city-data-ingest` | 11 | 18 | 2 |
| `city-gis-workspace` | 16 | 32 | 3 |
| `city-incident-desk` | 17 | 31 | 7 |
| `city-iot-network` | 14 | 25 | 4 |
| `city-maintenance-workshop` | 14 | 23 | 6 |
| `city-manager-review` | 14 | 24 | 3 |
| `city-operations-overview` | 19 | 32 | 2 |
| `city-people-admin` | 10 | 17 | 4 |
| `city-report-studio` | 9 | 14 | 2 |
| `city-technician-work` | 14 | 25 | 4 |
| `city-volunteer-desk` | 10 | 16 | 1 |
| `sos-after-action` | 11 | 18 | 4 |
| `sos-command-overview` | 20 | 34 | 3 |
| `sos-common-workspace` | 42 | 103 | 21 |
| `sos-dispatch-board` | 15 | 26 | 6 |
| `sos-eop-console` | 11 | 18 | 4 |
| `sos-event-command` | 15 | 27 | 5 |
| `sos-hazard-watch` | 15 | 28 | 6 |
| `sos-mutual-aid` | 10 | 17 | 4 |
| `sos-operator-review` | 16 | 29 | 4 |
| `sos-phase-boards` | 20 | 32 | 3 |
| `sos-rescue-operations` | 16 | 31 | 4 |
| `sos-resource-registry` | 12 | 21 | 4 |
| `sos-responder-board` | 16 | 29 | 4 |
| `sos-sitrep-desk` | 11 | 18 | 4 |
| `sos-volunteer-desk` | 9 | 17 | 0 |

## Reproduce

From SynapseDX, build the capabilities service, then run `npm run audit:workspaces`. The optional `--inventory` argument consumes an operator-only SDK inventory. Run the console Playwright suite `source-workspaces.spec.mjs` for the real source layouts, and `workspace-studio.spec.mjs` for action/input/source/pagination/detail regressions. Production-domain browser checks still intercept fixture APIs; the read-only production inventory and live workflow graph probe are separate evidence.

## Final release checks

Deployed local-source DX capabilities/console v0.9.9. Backend: 172 passed; console:
47 unit + six nginx/integrity passed; SDK: 22 passed. Product CLI: 30 per product;
workflow artifacts: six City / nine SOS; real engine with fake HTTP: five City /
ten SOS. Browser: 68 local passed with two nginx-only skips; **70 passed on the
public production domain, no skips**. Authenticated browser APIs are intercepted
fixtures. Both deployed services are healthy; all four tier readiness URLs return
200. Ten console files and three changed backend modules match local build bytes.
The read-only production inventory and 20 live workflow graph checks are separate
from the browser fixtures. No production business records were written by testing.

## Native files release (0.9.10)

Locally built and deployed DX capabilities, console and gateway. Four pages were
published: City CSV ingest/report studio v8 and each app's Common workspace v4.
Two protected, same-organization product-owned workflows were added; all 22 live
graphs and all 105 current product form pins pass read-only SDK verification.
The 30 published pages match portable source, with 874 named actions. Prior
history, installations and memberships are unchanged. No production business
records were written during verification.

Backend 176 tests; console 52 unit plus six integrity checks; gateway three tests
(including 3 MB exact binary transport with filename/app headers). Full browser
suite: 73 passed on the public production domain with no skips. API fixtures are
intercepted in these browser checks. The real Tier-1 engine with real DX HTTP
routes and fake persistence imported two assets, rejected one malformed row,
skipped both duplicates on retry and created five downloadable report artifacts.
This is executable integration evidence, not a live production business-write
claim. All three deployed services are healthy; ten public console assets match
the local build.

Native batch actions wait for workflow completion, carry the next offset and
retain a resumable offset after failure. CSV parsing rejects malformed input;
typed imports enforce coordinate ranges. Files retain app and tenant isolation,
including for organization admins using an app context. Downloads require a
published action. Limits: 50,000 rows/import or generated dataset report, 500 rows
per import batch, field maximum 20 MiB (default 10 MiB), CSV/JSON reports; report
source reads paginate rather than silently exporting only the loaded table page.

## Native editors release (0.9.11)

Deployed the locally built DX capabilities service and console. Published 15 new
immutable plugin versions: both Common pages v5 and 13 operational pages v8.
All 30 current published pages match portable source; 874 named actions and 105
pinned product forms pass the SDK inventory audit. All 22 live Tier-1 workflow
graphs match their reviewed artifacts. Memberships, installations and immutable
history are preserved. No production business record was changed by verification.

Native JSON fields now offer schema, query and geometry visual editors. Advanced
JSON is retained when editing visual properties. Schema validation previously
failed to enforce several advertised controls, including integer/object types,
formats and additional properties. The server now uses draft-7 validation for
schemas and submitted values, with local references and existing conditional
visibility. Invalid schemas fail before saving; no remote schema loader or data
coercion is enabled. Read-only production probing found no existing Common form
schemas requiring compatibility changes.

Query filters have explicit Text/Number/Boolean/Null types, so editing numeric
identifiers does not silently change their type or remove leading zeros.
Geometry controls support drawing, vertex dragging, coordinate editing, undo and
cancellation; the server rejects malformed or out-of-range WGS84 geometries.
Explicit selected-record paths repair `_json` field bindings throughout the
source bundles. Delayed detail reads fill untouched fields while preserving
draft edits; switching records resets the previous drawing session.

Backend: 181 tests passed; console: 52 unit and six integrity tests; SDK: 22;
portable product CLI: 30 per product; workflow artifact checks: six City and nine
SOS. The local full browser suite passed 74 tests with two nginx-only skips;
final editor regressions passed separately after the record-switch fix. Browser
API requests use intercepted fixtures; inventory and live graph checks are
separate read-only production evidence. The subsequent 0.9.12 capability release
adds spatial queries, SSE, deterministic assignment and generic plan
orchestration; the table above still tracks product adoption and business
acceptance rather than merely connector availability.

Final public-domain browser suite: **76 passed, zero skips**, including native
editor changes and both sandbox checks under the deployed nginx policy. The 11
public console build/bootstrap files and five changed backend modules match the
local build bytes. All four tier readiness endpoints return 200; affected
containers are healthy and have no startup errors.

## Capability expansion release (0.9.12)

This release adds four Tier-2 capabilities without changing the product
boundary:

- **Spatial record queries.** `dataset.geo` binds a record-data field to a
  per-dataset SynapseBase PostGIS collection. `POST
  /v1/capabilities/datasets/:id/records/spatial` serves `near`, `bbox` and
  `within`; candidates are re-checked against record visibility, so a stale
  index cannot expose a draft. `reindex` and `status` support repair and
  inspection. Geometry is validated before every authoritative Base write.
- **Live SSE feed.** `GET /v1/capabilities/events/stream` relays the Tier-1
  capability stream with `Last-Event-ID`/`since` resume, per-type/dataset
  filters, 15-second heartbeats and a 30-minute planned reconnect. The Rust
  gateway now streams `text/event-stream` instead of buffering it, and both
  nginx layers pass it unbuffered.
- **Deterministic assignment.** `POST /v1/capabilities/optimization/assign`
  solves capacity/skill/distance-constrained resource-to-demand matching with a
  maximum-flow stage followed by min-cost flow. It returns explicit unassigned
  reasons and never mutates product state.
- **Plan orchestration.** `/v1/capabilities/plans` provides tenant-scoped phased
  plans, CAS transitions, activation-time due dates, dependency-aware task
  status, a grounded brief and a validated AI draft with a deterministic
  fallback. SOS remains the owner of EOP approvals, publication and policy.

The capabilities are exposed through `@synapsedx/capabilities` and the public
Tier-2 API. City and SOS page adoption is not claimed by capability
availability; the remaining product work is listed in the table above and in
`CAPABILITY_RELEASE_0.9.12.md`.
