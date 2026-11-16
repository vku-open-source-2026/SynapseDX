# Plan orchestration (EOP)

SynapseDX exposes a **domain-neutral emergency/operations plan (EOP)**
capability. It owns the mechanics that every product would otherwise implement
twice: phased task plans, activation due-time computation, dependency-aware task
transitions, a grounded status brief and an AI-assisted draft.

It does **not** own emergency-management policy. SynapseCitySOS remains
responsible for EOP approval, who may activate/dispatch, hazard linkage, SITREP
deltas and AAR. SOS calls this capability through its reviewed workflows; the
capability never executes a plan, sends a dispatch or invents a domain event.

All plan state is a Tier-1 Base document (`synapsedx_capability_plans`) written
through `@synapseone/sdk`. There is no Tier-2 database, queue or in-memory
production store.

## Data model

```ts
interface PlanRecord {
  id: string;                 // server-generated UUID
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  objective: string;
  eventId?: string;
  severity?: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  context?: Record<string, unknown>;
  activatedAt?: string;
  completedAt?: string;
  phases: Array<{
    id: string;
    title: string;
    objective?: string;
    startOffsetMinutes: number;
    tasks: Array<{
      id: string;
      title: string;
      ownerRole?: string;
      dueOffsetMinutes: number;
      dependsOn: string[];
      status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';
      assignee?: string;
      notes?: string;
      completedAt?: string;
      dueAt?: string;
    }>;
  }>;
}
```

New plans are always `draft`, every task starts `pending` and no task has a
`dueAt` until activation. Task status, `dueAt` and `completedAt` are owned by the
lifecycle endpoints, never by the create/patch author.

## Limits and validation

| Field | Rule |
| --- | --- |
| `title` | 3..200 characters |
| `objective` | 1..4000 characters |
| `context` | JSON object, at most 16 KiB serialized UTF-8 |
| `eventId` | optional, at most 128 characters |
| `severity` | optional, at most 32 characters (SOS owns the vocabulary) |
| phases | 1..20 |
| tasks per phase | 1..50 |
| tasks per plan | at most 200 |
| phase/task ids | `[A-Za-z0-9_-]{1,64}`, unique across the whole plan |
| offsets | integer minutes 0..10080 for both phase start and task due offset |
| dependencies | every `dependsOn` id must exist, must be a task id and the graph must be acyclic |
| task note | at most 2000 characters |
| task assignee | at most 128 characters |

Duplicate phase ids, duplicate task ids and collisions between a phase id and a
task id return `400 invalid_request`. Unknown dependencies return
`400 invalid_request`; a dependency cycle returns `400 dependency_cycle`.

## Plan lifecycle

```text
draft --activate--> active
active --pause----> paused
paused --activate-> active
active   --complete--> completed
paused   --complete--> completed
completed --archive--> archived
```

- `draft` can only leave through `activate`; `pause`, `complete` and `archive`
  return `409 invalid_transition`.
- `archive` is only valid from `completed`.
- `archived` is terminal.
- Activation is idempotent: activating an already active plan returns the
  current document and version without moving due dates.
- Resuming a paused plan sets a new `activatedAt` and recomputes **all** task
  `dueAt` values (including already completed tasks) from that new timestamp.

Any other transition returns `409 invalid_transition` with
`details: {from, to, allowed}`.

### Activation due times

```text
task.dueAt = plan.activatedAt
           + (phase.startOffsetMinutes + task.dueOffsetMinutes) minutes
```

The sum may be at most 20160 minutes (14 days) even though each offset is
individually limited to 10080 minutes.

## Task state machine and dependencies

```text
pending     -> in_progress | done | skipped
in_progress -> done | blocked | skipped
blocked     -> in_progress | skipped
done        -> (terminal)
skipped     -> (terminal)
```

A request that repeats the current status is an idempotent no-op: it returns
the current plan and version and does not reset `completedAt`. Any other
disallowed transition returns `409 invalid_transition` with
`details: {from, to, allowed}`. Task status changes are only accepted while the
plan itself is `active` or `paused`.

Before a task may enter `in_progress` or `done`, **every** id in `dependsOn`
must already be `done`. Otherwise the request returns:

```json
{
  "error": {
    "code": "dependency_incomplete",
    "message": "all dependent tasks must be done first",
    "details": { "taskId": "task-2", "missing": ["task-1"] }
  }
}
```

`done` and `skipped` tasks are terminal. A plan may be completed with unfinished
tasks; whether that is acceptable is SOS policy, not a Tier-2 rule.

### Administrator override

`override: true` bypasses the dependency check only for a verified organization
administrator (`isTenantAdmin`) or deployment administrator (`isAdmin`). Anyone
else receives `403 admin_required`. When an override actually skips missing
dependencies:

- the task note gets an `[override: <missing ids> not done; approved by
  <subject> at <timestamp>]` line;
- `plan.task_status` audit details include `override: true` and the missing ids.

The override is deliberately visible and never granted from a request header or
a wildcard token scope.

## Optimistic concurrency

Every plan document version is a CAS precondition:

- reads return `ETag: "<version>"` and `{plan, version}`;
- writes accept `If-Match: "<version>"` or a body `ifVersion`;
- the route also passes the loaded version as `ifVersion` to Tier-1, so a
  concurrent writer always yields `409 version_conflict`;
- `If-Match` and `ifVersion` must agree when both are supplied
  (`400 invalid_request` otherwise).

## API contract

All routes require a Tier-1-verifiable credential and are tenant-scoped.
Non-admin callers can only read/write their own tenant; another tenant's plan
returns `404 plan_not_found` (existence is not disclosed).

| Method and path | Behaviour |
| --- | --- |
| `POST /v1/capabilities/plans` | Create a draft. Returns `201 {plan, version}` and `Location`. |
| `GET /v1/capabilities/plans` | List plans. Query: `status`, `tenant` (deployment-admin filter), `limit`, `offset`, `cursor`. Returns `{items,total,limit,offset,nextCursor}`. |
| `GET /v1/capabilities/plans/:id` | Read one plan. Returns `{plan, version}` with `ETag`. |
| `PATCH /v1/capabilities/plans/:id` | Draft-only metadata update of `title`, `objective`, `eventId`, `severity`, `context`. |
| `POST /v1/capabilities/plans/:id/activate` | `draft|paused -> active`, sets `activatedAt` and computes all `dueAt`. Idempotent while active. |
| `POST /v1/capabilities/plans/:id/pause` | `active -> paused`. |
| `POST /v1/capabilities/plans/:id/complete` | `active|paused -> completed`, sets `completedAt`. |
| `POST /v1/capabilities/plans/:id/archive` | `completed -> archived`. |
| `POST /v1/capabilities/plans/:id/tasks/:taskId/status` | Body `{status, note?, assignee?, override?, ifVersion?}`. Applies the task state machine and dependency rule. |
| `POST /v1/capabilities/plans/:id/brief` | Body `{focus?}`. Returns a grounded brief with citations. |
| `POST /v1/capabilities/plans/draft` | Body `{objective, eventType?, context?, phaseCount?}`. Returns an unpersisted AI draft. |

List pages are capped at 200 items. `cursor` and `offset` are mutually
exclusive; invalid pagination returns `400 invalid_limit`/`invalid_offset`/
`invalid_cursor`/`pagination_both_offset_and_cursor`.

## Grounded status brief

`POST /plans/:id/brief` builds a deterministic citation map first:

```json
{
  "brief": "EOP plan \"...\" is active.\n... [T1] ...",
  "citations": [
    {
      "index": 1,
      "taskId": "task-1",
      "phaseId": "prepare",
      "title": "Confirm activation",
      "status": "in_progress",
      "ownerRole": "incident_commander",
      "dueAt": "2026-11-15T03:15:00.000Z",
      "dependsOn": []
    }
  ],
  "language": "en",
  "model": "…",
  "fallback": false,
  "generated_at": "2026-11-15T03:00:00.000Z"
}
```

- Every `[Tn]` corresponds to `citations[n-1].taskId`; the model is told the
  exact citation count and may not use a higher number.
- Model output containing an unknown/invented `[T99]` marker, no citation, an
  empty reply or any inference error is discarded and replaced by the
  deterministic brief. That response has `model: null` and `fallback: true`.
- The deterministic brief is built only from the plan's real phase/task rows,
  statuses, owners and due times, and lists blocked tasks with their incomplete
  dependency citations.
- One inference attempt is made with `temperature: 0.2`, `max_tokens: 450`, a
  12-second timeout and no retries. The brief is never persisted.
- `language` is `vi` when `context.locale`/`context.language` starts with `vi`,
  or when the plan/focus text contains Vietnamese diacritics; otherwise `en`.

## AI-assisted draft

`POST /plans/draft` executes one strict-JSON inference call (20-second timeout,
no retries, 1800 output tokens), tolerates a fenced ```json block, and runs the
result through the **same** `normalizePlanInput` validator used by plan
creation. The requested `objective` is authoritative; a model-supplied
objective/eventId is never trusted. `eventType` is stored in the draft's
`context.eventType`; `severity` is taken from the model when valid. The draft is
returned, never persisted.

Shape: `{planDraft, model, fallback: false}` on success.

Fallback returns `{planDraft, model: null, fallback: true, reason}` where
`reason` is one of:

- `inference_unavailable` — network/HTTP failure;
- `empty_response` — no content;
- `invalid_json` — no parseable JSON object;
- `invalid_plan` — JSON parsed but failed the plan validator, exceeded the
  requested `phaseCount`, or the dependencies were cyclic/unknown.

The fallback is a deterministic three-phase **Prepare / Respond / Recover**
template with nine linked tasks, all `pending`, offsets within limits and ids
matching `[A-Za-z0-9_-]{1,64}`. It is valid input for `POST /plans` unchanged.
`phaseCount` selects the requested phase count for a successful model draft
(1..20, default 3); the deterministic template itself always has three phases.

## Audit

Every write records a Tier-1 audit projection with `actor`, `tenant`,
`correlationId` and no plan `context` payload:

| Action | Details |
| --- | --- |
| `plan.create` | `planId`, phase count, task count |
| `plan.update` | `planId`, changed field names |
| `plan.activate` | `planId`, `from`, `to` |
| `plan.pause` / `plan.complete` / `plan.archive` | `planId`, `from`, `to` |
| `plan.task_status` | `planId`, `taskId`, `from`, `to`, and `{override:true, missing}` when bypassed |

Idempotent activation and same-status task retries perform no write and
therefore add no audit row. Briefs and drafts are read-only AI calls and are not
audited as plan mutations.

## Ownership boundary

This capability deliberately has no concept of emergency approvals, dispatch
units, hazard severity policy, SITREP, AAR or public alerts. SOS must still:

1. decide who may request/approve activation and completion;
2. map its events and hazards to `eventId`/`context` and choose the EOP policy;
3. review AI drafts before creating a plan (drafts are suggestions, not
   decisions);
4. execute dispatch and record SITREP/AAR state in SOS-owned capability data.

No capability event type is emitted by this feature; the audit projection is
the write trail. Adding plan events is a separate, reviewed contract change.
