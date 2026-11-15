# Capability expansion — 2026-11-16

Status: implemented and released as the `0.9.12` capability set. Product-page
adoption and domain acceptance are tracked separately.

## Scope

Four Tier-2 capabilities close the generic connectors that the LCDP audit
previously listed as missing:

1. **Spatial record queries** — server-side `near`, `bbox` and `within` over a
   dataset's declared GeoJSON field, backed by SynapseBase PostGIS.
2. **Live capability events (SSE)** — a reconnectable `text/event-stream`
   projection over the Tier-1 stream, in addition to the existing cursor feed.
3. **Assignment optimization** — deterministic resource-to-demand matching with
   capacity, skills, distance/cost limits and explicit unassigned reasons.
4. **Plan orchestration** — phased plan templates, activation, dependency-aware
   task transitions, grounded briefs and AI-assisted drafts with deterministic
   fallback.

The capabilities are generic. City and SOS keep their domain policy, approval
rules and workflow ownership; they call these endpoints through the Tier-2 API
or SDK. No Tier-1 credential, database, queue or local fallback is introduced.

## Contracts

### Spatial

Bind a dataset with `geo: {field: "<dotted record.data path>"}`. `field` is
1–6 dot-separated `[A-Za-z_][A-Za-z0-9_]{0,63}` segments. `PATCH {geo:null}`
removes the binding.

`POST /v1/capabilities/datasets/:id/records/spatial`:

```json
{"mode":"near","lat":21.03,"lng":105.85,"radiusMeters":2000,"limit":50}
{"mode":"bbox","bbox":[105.84,21.02,105.87,21.04],"limit":50}
{"mode":"within","geometry":{"type":"Polygon","coordinates":[[...]]},"limit":50}
```

`limit` is 1..500, radius 1..100000. The response is a FeatureCollection plus
`items` in the normal record shape. Draft readers see withheld records; other
callers only see published/inherited-published rows. `POST .../spatial/reindex`
repairs up to 5,000 records per call and accepts `offset`; `GET
.../spatial/status` reports the collection and feature count. Index maintenance
is best-effort and never fails the authoritative Base write.

### SSE

`GET /v1/capabilities/events/stream` (verified credential) accepts `since`,
`type` and `datasetId`; `Last-Event-ID` is the preferred cursor and `since` wins
when both are present. Without a cursor it starts at the stream tail.

```text
retry: 3000

event: ready
data: {"cursor":"…","stream":"…","filters":{…}}

id: <stream id>
event: capability
data: {"id":"…","event":{"eventId":"…","type":"record.created",…}}

: keepalive
```

Heartbeat is 15 s, planned reconnect is 30 minutes, and a process admits 100
concurrent streams (`503 stream_capacity`). The Rust gateway streams the body
without its normal 30 s whole-response timeout; both nginx layers are unbuffered
and forward `Last-Event-ID`. Browser `EventSource` cannot set the required
authorization header, so clients use the SDK's fetch-stream reader.

### Optimization

`POST /v1/capabilities/optimization/assign` accepts up to 200 resources and 200
demands. Costs come from `options.costMatrix[demandIndex][resourceIndex]` or
haversine distance; `null` marks an unusable edge. Capacity is 1..20 per
resource, priority 1..5 is an equal-cost tie-break, and skills are exact
set-inclusion. The solver maximizes served demands first, then minimizes total
cost. It returns `assignments`, `unassigned` reasons (`no_resource`, `capacity`,
`distance`, `skills`), `resourceUsage`, `totalCost` and the applied limits. It
does not mutate SOS dispatch state.

### Plans

`/v1/capabilities/plans` provides:

- `POST /plans` (draft), `GET /plans`, `GET/PATCH /plans/:id`;
- `POST /plans/:id/{activate,pause,complete,archive}` with CAS;
- `POST /plans/:id/tasks/:taskId/status` with dependency enforcement and an
  audited administrator override;
- `POST /plans/:id/brief` (grounded citations or deterministic fallback);
- `POST /plans/draft` (strict-JSON AI draft or a Prepare/Respond/Recover
  template; never persisted).

Limits: 1..20 phases, 1..50 tasks/phase, 200 tasks total, offsets 0..10080
minutes, acyclic dependencies, context ≤16 KiB. Activation computes each
task's `dueAt` from the activation time plus phase/task offsets. SOS retains EOP
approval, publication and domain policy.

## Verification

- Backend capability service: **234 tests passed** (includes 12 spatial, 11 SSE,
  18 optimization and 12 plan tests).
- JavaScript SDK: **31 tests passed**.
- Console: **52 unit tests + 7 nginx/integrity tests passed**.
- Rust gateway: **4 tests passed**, including SSE passthrough and
  `Last-Event-ID` forwarding.
- Root `npm run build` and `npm run workflows:validate` passed.
- Production: see the release evidence appended after deployment.

## Boundaries and remaining work

- City still serves its spatial API from an in-process scan; adopting the
  Tier-2 index is a product change with its own acceptance test.
- SOS still polls the hazard dataset; adopting the SSE feed requires the Rust
  SDK/event client release and a product workflow change.
- SOS applies dispatch plans through its own reviewed workflow; this capability
  only returns a deterministic recommendation.
- SOS owns EOP approvals, publication and AI policy; the generic plan lifecycle
  is a reusable substrate, not a replacement for those decisions.
