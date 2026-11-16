# Generic resource assignment (`optimization.assign`)

SynapseDX exposes a deterministic resource-to-demand assignment capability for
Tier-3 products. The solver is domain-neutral: it has no incident, SOS,
vehicle, responder or agency field. SynapseCitySOS maps its dispatch model onto
the generic arrays and remains responsible for applying the result through its
own reviewed workflow.

## Endpoint

```http
POST /v1/capabilities/optimization/assign
Authorization: Bearer <Tier-1-verifiable credential>
Content-Type: application/json
```

A verified caller is required because the result describes operational
capacity. A write scope is **not** required: the route is a pure computation and
writes no capability data. The only side effect is one `optimization.assign`
audit row containing counts (resource count, demand count, assigned count,
unassigned count, usable slots); the request payload and identifiers are not
copied into audit.

Request bodies are limited to **256 KB**. The solver accepts at most **200
resources** and **200 demands**. Each resource capacity is 1..20, so the
available slot bound is **4,000**. A single edge cost may not exceed **1e12**.

## Request

```json
{
  "resources": [
    {
      "id": "unit-1",
      "lat": 16.06,
      "lng": 108.22,
      "capacity": 1,
      "skills": ["medical"],
      "available": true
    }
  ],
  "demands": [
    {
      "id": "call-1",
      "lat": 16.06,
      "lng": 108.23,
      "priority": 5,
      "requiredSkills": ["medical"],
      "serviceMinutes": 30
    }
  ],
  "options": {
    "costMatrix": [[120]],
    "maxDistanceMeters": 10000,
    "unassignedPenalty": 1000000
  }
}
```

| Field | Rules |
| --- | --- |
| `resources[].id`, `demands[].id` | Required, unique within their array, 1..128 characters after trimming |
| `resources[].lat` / `lng` | Optional finite coordinates (`-90..90`, `-180..180`) |
| `demands[].lat` / `lng` | Optional finite coordinates (`-90..90`, `-180..180`) |
| `resources[].capacity` | Optional integer 1..20, default 1 |
| `resources[].skills` | Optional array, at most 32 entries of 1..64 characters |
| `resources[].available` | Optional boolean, default `true`; `false` removes all slots |
| `demands[].priority` | Optional integer 1..5, default 3; 5 is highest |
| `demands[].requiredSkills` | Optional array, at most 32 entries of 1..64 characters |
| `demands[].serviceMinutes` | Optional finite non-negative number, accepted for caller semantics |
| `options.costMatrix` | Optional `matrix[demandIndex][resourceIndex]`; dimensions must match exactly |
| `options.maxDistanceMeters` | Optional finite non-negative edge-cost ceiling |
| `options.unassignedPenalty` | Optional 0..1e12, default 1e9 |

Skills are matched case-sensitively after trimming. A resource is compatible
only when it contains **every** required skill. `serviceMinutes` is validated
but capacity is slot based (one assigned demand consumes one slot); it does not
silently change the capacity count.

## Cost resolution

1. If `options.costMatrix` is present, its exact dimensions must be
   `demands.length` rows by `resources.length` columns. A numeric cell is used
   verbatim; `null` marks that demand/resource edge as unusable.
2. Otherwise the cost is the haversine distance in meters between the demand and
   resource coordinates, rounded to millimetres.
3. If neither a matrix cell nor a complete coordinate pair exists, the request
   fails with `400 cost_unavailable` for that pair.

`NaN`, `Infinity`, negative and non-numeric matrix values are rejected with
`400 invalid_cost_matrix`. `maxDistanceMeters` excludes edges whose resolved
cost is greater than the limit. `distanceMeters` on an assignment is present
whenever both endpoints have coordinates, even when a cost matrix supplied the
cost.

## Objective and determinism

The solver's objective is lexicographic:

1. maximize the number of fully served demands;
2. minimize the total actual cost of the selected edges;
3. among equal-total-cost solutions, prefer higher-priority demands.

It is an exact minimum-cost maximum-cardinality bipartite b-matching. The
implementation runs Dinic maximum flow to fix the maximum served count, then
successive-shortest-path min-cost flow for that fixed count using the
lexicographic edge weight `(cost, -priority)` with potentials. Residual
rerouting is therefore allowed, and each demand is served at most once while
each resource slot is used at most once.

Priority is a tie-break, not a hard preemption: a sufficiently cheaper
low-priority assignment still wins. Callers that need priority to dominate
distance should encode that policy in the cost matrix. `unassignedPenalty` is
accepted as the caller's declared opportunity cost, but the maximum-cardinality
stage runs first, so the penalty can never cause an assignable demand to be
dropped. `totalCost` reports the sum of assignment costs only; it does not include
the conceptual penalty of unassigned demands.

For identical input, output order and tie-breaks are deterministic. Candidate
nodes are processed in input order (demand index, then resource index); IDs are
used for identity and duplicate rejection. `assignments` and `unassigned` follow
demand input order, and `resourceUsage` follows resource input order.

### Complexity

The graph has at most 402 nodes (`source`, 200 demands, 200 resources, `sink`)
and about 40,400 forward edges, with at most 200 units of flow. Maximum flow and
the min-cost phase are bounded by the 200 x 200 input cap; the test suite
solves a fully connected 200 x 200 matrix in well under two seconds on the
release machine. The capability has no database, queue, cache or filesystem
dependency.

## Response

```json
{
  "assignments": [
    {
      "demandId": "call-1",
      "resourceId": "unit-1",
      "cost": 120,
      "distanceMeters": 1111.2
    }
  ],
  "unassigned": [
    { "demandId": "call-2", "reason": "capacity" }
  ],
  "totalCost": 120,
  "assignedCount": 1,
  "demandCount": 2,
  "resourceSlots": 1,
  "resourceUsage": [
    {
      "resourceId": "unit-1",
      "capacity": 1,
      "used": 1,
      "remaining": 0,
      "available": true
    }
  ],
  "algorithm": "min_cost_flow",
  "at": "2026-11-15T18:00:00.000Z",
  "limits": {
    "maxResources": 200,
    "maxDemands": 200,
    "maxSlots": 4000,
    "maxCost": 1000000000000
  }
}
```

Unassigned reasons are best-effort and deterministic:

| Reason | Meaning |
| --- | --- |
| `no_resource` | No usable available resource exists (including all unavailable or all matrix edges null) |
| `skills` | Available resources exist, but none contains every required skill |
| `distance` | Skill-compatible resources exist, but every usable edge exceeds `maxDistanceMeters` |
| `capacity` | At least one compatible, reachable resource exists, but its slots are consumed by higher-ranked demands |

## Errors

Errors use the service's stable JSON envelope. Relevant codes are
`invalid_request`, `field_required`, `too_many_resources`, `too_many_demands`,
`invalid_cost_matrix`, `cost_unavailable` and `payload_too_large` (body over
256 KB).

## SOS integration rule

This capability computes a plan; it does not dispatch anybody. SynapseCitySOS
must still apply the returned assignments through its own reviewed workflow
(approval/status transition, domain validation and product audit). The solver
must not become an automatic dispatch side effect, and SOS must not persist its
dispatch state in Tier 2. The generic solver exists so the optimization itself
is reusable and testable across products rather than duplicated in a product
UI.
