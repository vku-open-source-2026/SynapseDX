# SynapseDX Tier-2 API reference

Base URL: `https://synapsedx.sbs` (gateway). All responses are JSON unless
noted. Every 4xx/5xx uses the error envelope below.

## Authentication

```http
Authorization: Bearer <Tier-1 access token>
X-API-Key: <Tier-1 API key>
X-Correlation-Id: <optional caller trace id>
X-SynapseDX-Product: city|sos|<product>
```

Tier-2 verifies the credential with Tier-1 IAM (`POST/GET /v1/auth/verify`).
Anonymous callers may read only published public datasets/entities. Writes
require a write-capable scope. Private records always require tenancy, even for
a public dataset.

Each Tier-3 product must use its own account-scoped Tier-1 key. A credential
carrying `*` (platform admin) or the shared service account is an administrator
identity and is not product-isolated.

`GET /health`, `GET /ready`, `GET /v1/capabilities`, `GET /v1/capabilities/health`,
`GET /v1/capabilities/ready`, `GET /v1/capabilities/datasets` (public filter),
`GET /v1/capabilities/datasets/:id/entities`, and the auth
login/register/refresh/password-forgot/password-reset/email-verify/OIDC routes
are reachable without a credential. Password change, session management and
email-verification requests need a user bearer token.

## Error envelope

```json
{
  "error": {
    "code": "version_conflict",
    "message": "the record was modified by another request",
    "requestId": "6f4c...",
    "details": { "currentVersion": 4 }
  }
}
```

Upstream Tier-1 URLs, collection names and response bodies are never copied
into the envelope. Unknown routes return `404 route_not_found`; unsupported
methods return `405 method_not_allowed` with an `Allow` header.

Stable codes: `invalid_request`, `invalid_json`, `invalid_limit`,
`invalid_offset`, `invalid_cursor`, `invalid_dataset_id`, `invalid_record_id`,
`invalid_slug`, `invalid_license`, `invalid_schema_version`, `invalid_retention`,
`retention_not_configured`, `field_required`, `data_must_be_an_object`,
`no_updatable_fields`, `public_must_be_boolean`,
`pagination_both_offset_and_cursor`, `unauthorized`, `invalid_credential`,
`authentication_unavailable`, `insufficient_scope`, `not_found`,
`dataset_not_found`, `record_not_found`, `dataset_already_exists`,
`record_already_exists`, `dataset_not_public`, `dataset_not_published`,
`dataset_not_empty`, `illegal_transition`, `version_conflict`,
`idempotency_key_required`, `idempotency_key_reuse`, `idempotency_in_progress`,
`idempotency_unavailable`, `unsupported_media_type`, `payload_too_large`,
`file_not_found`, `file_already_exists`, `file_too_large`,
`file_type_not_allowed`, `quota_exceeded`, `upload_incomplete`,
`presign_unsupported`, `notification_not_found`, `notification_not_cancellable`,
`notification_suppressed`, `template_not_found`, `template_invalid`,
`invalid_credentials`, `auth_rejected`, `org_not_allowed`,
`audience_not_allowed`, `exchange_forbidden`, `rate_limited`,
`geocoder_unavailable`, `tier1_capability_unavailable`, `dependency_unavailable`,
`upstream_auth_failed`, `upstream_conflict`, `upstream_unavailable`,
`upstream_timeout`, `query_rejected`, `internal_error`, `route_not_found`,
`method_not_allowed`, `job_not_found`, `job_kind_unknown`, `job_not_runnable`,
`job_run_in_progress`, `job_run_not_found`, `job_lease_invalid`.

## Pagination

- `limit` defaults to `100`, maximum `500` for Tier-2 routes (Tier-1 LDS caps
  entity exports at `500`). Invalid values return `400`, never a silent clamp.
- Records and query endpoints return
  `{items,total,limit,offset,nextCursor}` with the true total.
- Dataset lists return a JSON array for backward compatibility and expose
  `X-Total-Count`, `X-Limit`, `X-Offset`, `X-Next-Cursor` headers.
  `datasets.listPage()` in the SDK parses them.
- `cursor` and `offset` are mutually exclusive.
- Tier-1 Base queries scan a collection in-process. If a capability collection
  exceeds the Tier-1 query scan limit, Tier-2 returns
  `503 dependency_unavailable` with `details.reason = "query_scan_limit"`
  instead of silently truncating; retain/shard the dataset before that point
  (tracked in SynapseOne #29).

## Health and capability advertisement

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | Same payload as `/v1/capabilities/health` |
| GET | `/ready` | none | 200 only when critical dependencies are up |
| GET | `/v1/capabilities` | none | Advertisement, auth model, capability status |
| GET | `/v1/capabilities/health` | none | `{status,dependencies:[{name,status,latency_ms,critical,error?}],credentials,time}` |
| GET | `/v1/capabilities/ready` | none | 503 when `base`, `lds` or `queue` is down |

Dependencies probed: `base`, `lds`, `queue` (critical), `stream`, `iam`,
`workflow`, `faststore`, `storage`, `notifications` (non-critical).

## Datasets

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/datasets` | optional | List visible datasets. `publicOnly=true` filters in the Tier-1 query. Anonymous callers are forced to public+published. |
| POST | `/v1/capabilities/datasets` | write | Create a dataset (`name`, `entityType`, `license`, optional `slug`, `description`, `public`, `schemaVersion`, `retentionDays`, `licenseUrl`). |
| GET | `/v1/capabilities/datasets/:id` | optional | Dataset metadata. ETag carries the document version. |
| PATCH | `/v1/capabilities/datasets/:id` | write | Update metadata/visibility. Supports `If-Match`/`ifVersion`. |
| DELETE | `/v1/capabilities/datasets/:id` | write | Delete a dataset. `?purgeRecords=true` cascades record deletion; otherwise `409 dataset_not_empty` when records exist. |
| POST | `/v1/capabilities/datasets/:id/publish` | write | Publish/re-publish. `409 dataset_not_public` when `public:false`. |
| POST | `/v1/capabilities/datasets/:id/revoke` | write | Revoke and delete the public projection. |
| GET | `/v1/capabilities/datasets/:id/entities` | none for public | Public NGSI-LD entities with `Link: rel="license"`, `X-LDS-License`, `X-LDS-Datasource`, `X-LDS-Total`, `X-LDS-Context`, `Cache-Control`, `X-Total-Count`. |

### Validation

- `license` must exist in the Tier-1 LDS catalog or match
  `LicenseRef-[A-Za-z0-9._-]{1,128}`.
- A public dataset requires an open-data license.
- `schemaVersion` is semantic versioning.
- `entityType` matches `[A-Za-z][A-Za-z0-9_-]{0,63}`.
- `licenseUrl` must be HTTPS.
- `retentionDays` is an integer `1..3650`.

### Lifecycle

```text
draft --publish--> published --revoke/unpublish--> revoked
  ^                    |                              |
  |                    +--publish (idempotent)        |
  +-------------------------publish------------------+
```

`PATCH {public:false}` on a published dataset unpublishes it (status becomes
`revoked`). `PATCH {public:true}` on a dataset that was previously published
republishes it. `PATCH {public:true}` on a draft leaves it in `draft`; call
`publish` explicitly.

## Records

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/datasets/:id/records` | write-capable tenant or admin | List with true `total` and `nextCursor`. `publishedOnly=true`, `orderBy=field:asc\|desc`. |
| POST | `/v1/capabilities/datasets/:id/records` | tenant write | Create (`data`, optional `id`, optional `publish`). Caller IDs are preserved exactly. |
| POST | `/v1/capabilities/datasets/:id/records/query` | tenant read | Filter/sort with Tier-1 Base operators (`where`, `orderBy`, `limit`, `offset`, `cursor`). Payload fields are addressable directly (`{status:'open'}`) and are qualified to `data.*`; `id`, `datasetId`, `published`, `createdAt`, `updatedAt` stay top-level. |
| POST | `/v1/capabilities/datasets/:id/records/bulk` | tenant write | Create 1..100 records; returns `{created,errors}` per item. |
| GET | `/v1/capabilities/datasets/:id/records/:recordId` | tenant read | Single record (`version`, `published`, timestamps). |
| PATCH | `/v1/capabilities/datasets/:id/records/:recordId` | tenant write | Update data/publication. Supports `If-Match`/`ifVersion`. |
| DELETE | `/v1/capabilities/datasets/:id/records/:recordId` | tenant write | Hard delete + withdraw the LDS entity. Repeat returns `404`. |
| POST | `/v1/capabilities/datasets/:id/records/purge-expired` | tenant write | Delete records older than `retentionDays`; requires a retention policy. |

Record IDs must match `[A-Za-z0-9_@.:+-]{1,256}` (no `/`, `\`, newline, `.` or
`..`). Invalid IDs return `400 invalid_record_id`; they are never rewritten.

### Per-record publication

| `publish` | Behaviour |
| --- | --- |
| `true` | Publish this record. Requires a public+published dataset, otherwise `409 dataset_not_published`. |
| `false` | Never project the record; if it was projected, the projection is rebuilt without it. |
| omitted | Inherit the dataset default (published dataset → projected). |

Withheld records stay withheld across updates, republishes and LDS rebuilds.

## Idempotency, versioning and events

- `Idempotency-Key: <8..200 chars>` — replay the stored response for the same
  key and body; different body → `409 idempotency_key_reuse`; concurrent request
  → `409 idempotency_in_progress`. Stored through Tier-1 Faststore (24 h).
- `If-Match: "<version>"` or `{ "ifVersion": n }` — `409 version_conflict` with
  `details.currentVersion` when stale.
- Queue outage: the write returns success with `x-event-status: pending`; the
  event stays in the dataset outbox.

Events:

```json
{
  "eventId": "…",
  "type": "record.updated",
  "schemaVersion": 1,
  "datasetId": "city-incidents",
  "recordId": "INC_001",
  "at": "2026-11-04T…",
  "correlationId": "…",
  "idempotencyKey": "…"
}
```

Event types: `dataset.created`, `dataset.updated`, `dataset.published`,
`dataset.revoked`, `dataset.deleted`, `record.created`, `record.updated`,
`record.deleted`, `retention.purged`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/events` | any verified credential | Non-destructive stream feed. `since` (cursor), `type`, `datasetId`, `limit` (1..500). Returns `{items,count,nextCursor}`. At-least-once: dedupe on `eventId`. |
| POST | `/v1/capabilities/events/outbox/flush?datasetId=` | tenant write | Retry pending events and report the remaining count. |

## Identity/session

All routes proxy Tier-1 IAM; Tier-2 stores no password, session or identity
record. Password/session/OIDC flows are bound to the deployment organization
when `SYNAPSEDX_AUTH_ORG_SLUG` is set (a different `orgSlug` gets
`403 org_not_allowed`). Password and refresh responses are `cache-control:
no-store`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| POST | `/v1/capabilities/auth/register` | none | `{email,password,displayName?,orgSlug?}` → `201` session. Tier-1 registration policy applies. |
| POST | `/v1/capabilities/auth/login` | none | `{email,password?,orgSlug?}` → `{accessToken,refreshToken,user}`. Passwordless is only for Tier-1 dev deployments. |
| POST | `/v1/capabilities/auth/refresh` | none | `{refreshToken}`; Tier-1 rotates atomically. |
| POST | `/v1/capabilities/auth/logout` | none | `{refreshToken}` |
| POST | `/v1/capabilities/auth/logout-all` | none | `{refreshToken}` |
| POST | `/v1/capabilities/auth/password/change` | user bearer | `{currentPassword,newPassword}`; Tier-1 revokes all refresh sessions. |
| POST | `/v1/capabilities/auth/password/forgot` | none | `{email,orgSlug?}` → `202`; never reveals account existence. |
| POST | `/v1/capabilities/auth/password/reset` | none | `{token,newPassword}` |
| POST | `/v1/capabilities/auth/email/verify` | none | `{token}` |
| POST | `/v1/capabilities/auth/email/verify/request` | user bearer | Sends a verification token. |
| GET | `/v1/capabilities/auth/sessions` | user bearer | Active refresh sessions. |
| DELETE | `/v1/capabilities/auth/sessions/:id` | user bearer | Revoke one session. |
| GET | `/v1/capabilities/auth/me` | verified | Caller identity. |
| GET | `/v1/capabilities/auth/oidc/config` | none | Tier-1 OIDC configuration. |
| GET | `/v1/capabilities/auth/oidc/start?org=` | none | `{authorizeUrl,state}` (`?redirect=true` redirects). |
| POST | `/v1/capabilities/auth/oidc/callback` | none | `{code,state}` → session. |
| POST | `/v1/capabilities/auth/exchange` | service/admin | Delegated token: `{userId,accountId?,orgId?,scopes?,audience?,ttlSeconds?}`. The caller needs `*`, `synapsedx:admin`, `synapsedx:auth:exchange` or `auth:exchange`. |

`/auth/exchange` audience is bound to `SYNAPSEDX_AUTH_ALLOWED_AUDIENCES`
(default `synapsedx,synapsecity,synapsecitysos`; `x-synapsedx-product` selects
one when the body omits `audience`). Requested scopes must be a subset of the
caller's scopes. Tier-1 still enforces the target user/org/account and the
service-key scope ceiling.

**Tier-3 role mapping.** Tier-3 roles are not trusted claims. A product maps
its roles to Tier-1 policies/scopes and lets Tier-2/Tier-1 enforce them:

| Tier-3 intent | Tier-1 binding |
| --- | --- |
| citizen / read-only | account role with `*:read` (or product-specific `read`) |
| operator / write | account role with `write` scoped to the product account |
| administrator | account role with `synapsedx:admin`/`*` only for the platform operator, never handed to a product |
| product service | account-scoped API key for Tier-3 calls; Tier-2's service key stays server-side |

The caller always uses its own account-scoped key/token. Tier-2 derives
`tenantKey` from the verified account/org/subject and never reads a role from
the request body.

## Management console

The console at `cloud.synapsedx.sbs` is a React SPA backed by these routes.
Roles are derived from the verified Tier-1 principal; the browser cannot
choose a role. `admin` is `*`/`synapsedx:admin`, `operator` is `write`/
`synapsedx:operator`, `moderator` is `synapsedx:moderator`, and `manager` is a
read/manager scope. A credential with no explicit scopes keeps the legacy
full-access behaviour and resolves to `operator` + `manager`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/management/context` | verified | `{user, tenant, org?, account?, roles, permissions, auth}` for the console shell. |
| GET | `/v1/capabilities/management/summary` | verified | Tenant-scoped dataset counts, pending-review count, pending outbox events and recent audit. |
| GET | `/v1/capabilities/management/settings` | manager+ | Tenant settings (`requireReview`). |
| PATCH | `/v1/capabilities/management/settings` | admin | Update `{requireReview}`; publication returns `409 review_required` until a moderator approves the dataset. |
| GET | `/v1/capabilities/management/team` | admin | Project Tier-1 IAM members, roles and policies for the console. |
| GET/POST | `/v1/capabilities/management/team/:userId/roles` | admin | Read or assign a role (`{roleId}`). |
| DELETE | `/v1/capabilities/management/team/:userId/roles/:roleId` | admin | Remove a role assignment. |
| GET | `/v1/capabilities/management/review-queue` | manager+ | `{items,total,...}` filtered by `status=pending\|approved\|rejected\|all`. |
| POST | `/v1/capabilities/management/datasets/:id/submit-review` | write | Submit a public draft/revoked dataset for peer review (`{note?}`). |
| POST | `/v1/capabilities/management/datasets/:id/approve` | moderator/admin | Approve a pending review (`{note?}`). Publication remains a separate operator action. |
| POST | `/v1/capabilities/management/datasets/:id/reject` | moderator/admin | Reject a pending review; `{note}` is required and is shown to the operator. |

Review state is additive on the dataset: `reviewStatus`
(`none|pending|approved|rejected`), `reviewSubmittedAt`, `reviewedBy`,
`reviewedAt`, `reviewNote`. It never bypasses the existing
`draft → published → revoked` lifecycle or the public-license check.

## Approvals (human-in-the-loop)

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| POST | `/v1/capabilities/approvals` | write | `{title,module,action,approverRoles?,requiredApprovals?,entityType?,entityId?,payload?,dueAt?}`. |
| GET | `/v1/capabilities/approvals` | verified | Tenant-scoped list (`status`, `module`, `mine=requester\|approver`). |
| GET | `/v1/capabilities/approvals/:id` | verified | One approval with decisions and ETag version. |
| POST | `/v1/capabilities/approvals/:id/decide` | verified | `{decision:approve\|reject,note?}`. Requester cannot decide; configured approver roles are enforced; duplicate decisions return 409. |
| POST | `/v1/capabilities/approvals/:id/cancel` | requester/admin | Cancel a pending request. |

The state machine is `pending -> approved|rejected|cancelled`; `requiredApprovals`
accumulates independent approve decisions. Every transition is audited as
`approval.create`, `approval.decide` or `approval.cancel`. Domain effects remain
owned by the caller; this capability only records the human decision.

## Collaboration (#32, #35)

| Method | Route | Description |
| --- | --- | --- |
| POST | `/v1/capabilities/comments` | Comment with `mentions[]`; creates deduplicated inbox items (`idempotencyKey` supported). |
| GET | `/v1/capabilities/comments` | Filter by `entityType`, `entityId`, `module`. |
| GET | `/v1/capabilities/inbox` | Recipient inbox (`status`, `module`), unread count. |
| POST | `/v1/capabilities/inbox/:id/read` · `/archive` | Mark an item read or archived. |
| GET/PUT | `/v1/capabilities/notification-preferences` | Per-user channels, mute, digest and quiet hours. |
| POST/GET | `/v1/capabilities/workspaces` | PARA workspaces with owner/editor/viewer members. |
| PATCH/DELETE | `/v1/capabilities/workspaces/:id` | Update membership or delete pages + workspace. |
| POST/GET | `/v1/capabilities/workspaces/:id/pages` | Versioned wiki pages (`ifVersion` optimistic concurrency). |
| GET/PUT/DELETE | `/v1/capabilities/pages/:id` | Page + versions + backlinks; missing attachments are dropped. |
| POST | `/v1/capabilities/pages/:id/attachments` | Attach a Tier-2 file (bytes remain in Tier-1 storage). |
| GET | `/v1/capabilities/page-search?q=` | Permission-aware page search. |

## People / process / projects (#36, #37, #38)

- `/v1/capabilities/people`, `/org-units`: directory linked to IAM subjects.
- `/v1/capabilities/kpis`, `/kpis/:id/checkins`: progress derived only from check-ins.
- `/v1/capabilities/timesheets`, `/:id/submit`, `/:id/decide`: submit creates a HITL approval; self-approval is refused; approved periods lock.
- `/v1/capabilities/forms`, `/:id/versions`, `/:id/validate`: JSON-schema subset with conditional `visibleWhen` fields.
- `/v1/capabilities/processes`, `/:id/versions`, `/:id/start`; `/process-instances/:id/transition`: published versions pin per instance, illegal transitions return `409`.
- `/v1/capabilities/projects`, `/:id/tasks`, `/:id/dependencies` (cycle rejection), `/:id/gates` + submit/decide (HITL stage gates), `/:id/raid`, `/project-capacity`.

## Reports and data products (#39, #40)

| Method | Route | Description |
| --- | --- | --- |
| POST/GET | `/v1/capabilities/reports` | Saved report (`kind`, dataset, query, parameters). |
| POST | `/v1/capabilities/reports/:id/run` | Permission-checked execution (metric/trend/table/bar/line). |
| POST | `/v1/capabilities/reports/:id/export` | CSV/JSON/NDJSON, idempotent by key, audited. |
| POST | `/v1/capabilities/reports/:id/schedule` | Cron/format/recipient schedule. |
| POST | `/v1/capabilities/report-schedules/run-due` | Hourly idempotent schedule runner. |
| POST/GET | `/v1/capabilities/dashboards` | Widget layout + shared filters. |
| POST | `/v1/capabilities/dashboards/:id/share` | Stable share link id. |
| GET | `/v1/capabilities/dashboards/:id/data` | Runs every widget with the same filters. |
| POST | `/v1/capabilities/datasets/:id/contract` | Schema/semantic types/owner/SLA/license + compatibility check. |
| GET | `/v1/capabilities/datasets/:id/contract` | Current contract and history. |
| PUT | `/v1/capabilities/datasets/:id/quality/rules` | Required/unique/range/regex/freshness + publication gate. |
| POST/GET | `/v1/capabilities/datasets/:id/quality[/run]` | Run and inspect quality results. |
| POST/GET | `/v1/capabilities/lineage[/:type/:id]` | Tenant-scoped upstream/downstream traversal. |

## Intelligence (#43, #44, #45)

- `/v1/capabilities/ocr/jobs` + `/:id/redact` + `/:id/fields/:field/correct`: page/bbox provenance, low-confidence queue, PII redaction and record creation with provenance.
  - `POST /ocr/jobs {fileId}` OCRs the stored file with Tesseract (`vie+eng`); the job records `source: "engine"` and `engine {name, languages, durationMs}`, and every page keeps `lines[]` with text, bbox and confidence.
  - `POST /ocr/jobs {fileId, text | pages[]}` skips the engine and parses pre-extracted text (`source: "client_text"`).
  - Errors: `415 ocr_unsupported_type` (images only: PNG/JPEG/TIFF/BMP/WebP/GIF), `413 file_too_large`, `429 ocr_busy`, `503 ocr_engine_unavailable`, `504 ocr_timeout`, `422 ocr_failed` / `ocr_no_text`, `400 ocr_empty` (no `Label: value` lines).
- `/v1/capabilities/agents`, `/:id/runs`, `/:id/kill-switch`; `/agent-runs`, `/:id/resume`: deny-by-default tools, high-risk HITL pause, redacted traces, tenant kill switch.
- `/v1/capabilities/rag/documents`, `/rag/query`, `/rag/usage`: ACL-aware retrieval, numbered citations, no-answer path, prompt-injection refusal, per-tenant usage/cost.
  - Ingest returns `embeddingModel`: `tier1/<model>` when Tier-1 InferenceService reports a real embedding model, otherwise `local/hash-48`.
  - `POST /rag/query {question, topK?, generate?}` returns `answer`, `citations`, `confidence`, `noAnswer`, plus `generator` (`llm` | `extractive`), `retrieval` and, for LLM answers, `model`. An LLM answer is used only if each `[n]` cites a retrieved source; `generate: false` always quotes.

## AI/inference

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/ai/status` | verified | Tier-1 inference health. |
| POST | `/v1/capabilities/ai/chat` | verified | `{messages,model?,temperature?,max_tokens?}`. Streaming is not exposed. |
| POST | `/v1/capabilities/ai/embeddings` | verified | `{input,model?}` |
| POST | `/v1/capabilities/ai/decision` | verified | `{state,questions}` |
| POST | `/v1/capabilities/ai/route` | verified | `{input,choices,instruction?}` |

## KTTV hazards and knowledge base

The Tier-2 KTTV base feeds both the hazard map and the LLM features. Normalised
hazards live in SynapseBase; documents/chunks live in the knowledge collections
and are indexed in Tier-1 `/v1/search` with real 384-d pgvector embeddings plus
SynapseBase Graph entity links.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/hazards/today?hours=24&limit=50` | verified read | Active hazards in the window, newest first. |
| POST | `/v1/capabilities/hazards/brief` | verified read | `{hours?,limit?,focus?}`. Grounded LLM situation brief with `[H1]` citations; `fallback:true` + deterministic text when the provider is unavailable. |
| GET | `/v1/capabilities/hazards/status` | verified read | Last run/success, counts, source health (`nchmf+vndms`). |
| POST | `/v1/capabilities/crawlers/kttv/run` | admin | Trigger a crawl (also runs on the 30-minute scheduler). |
| POST | `/v1/capabilities/knowledge/documents` | write | `{title,body,source?,url?,kind?,tags?,id?}`; chunks + graph entities. |
| POST | `/v1/capabilities/knowledge/ingest/pdf` | write | `{id|url}` from the server-side KTTV PDF catalog; rejects arbitrary URLs. |
| GET | `/v1/capabilities/knowledge/documents?limit=` | verified read | Tenant-scoped document list. |
| POST | `/v1/capabilities/knowledge/query` | verified read | `{question,topK?,context?}` → grounded answer, citations (URL/date), entities; hybrid vector + graph RAG. |
| GET | `/v1/capabilities/knowledge/status` | verified read | Docs, chunks, graph node/edge counts. |

SDK: `@synapsedx/capabilities@0.5.1` exposes `knowledge.query`,
`knowledge.index`, `knowledge.ingestPdf`, `hazards.today`, `hazards.brief`,
`hazards.status` and `hazards.runCrawler`.

## Jobs (scheduled work)

Two executors share one API. `executor:"workflow"` (default) creates a Tier-1
cron workflow. `executor:"runner"` is the Tier-3-runner contract: Tier-2
projects `nextRunAt` and leases work through Tier-1 Faststore; the Tier-3
process executes its domain handler and reports completion. Full contract and
sample loop: [`RUNNER.md`](RUNNER.md).

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/jobs/kinds` | verified | Built-in runner kinds (`vndms.ingest`, `hazard.expire`, `report.generate`, `generic`) and the runner contract paths. |
| GET | `/v1/capabilities/jobs` | verified | List jobs for the caller's tenant. |
| POST | `/v1/capabilities/jobs` | write | `{name,kind?,executor?,schedule:{cron}|{everySeconds},payload?,datasetId?,enabled?,timeoutSeconds?,maxAttempts?}`. |
| GET | `/v1/capabilities/jobs/:id` | verified | Job, `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`, version. |
| PATCH | `/v1/capabilities/jobs/:id` | write | Update name/schedule/payload/enabled/timeout/maxAttempts. The executor cannot change. |
| DELETE | `/v1/capabilities/jobs/:id` | write | Deactivate/delete the workflow or cancel queued runner runs, then delete the job. |
| GET | `/v1/capabilities/jobs/:id/runs` | verified | Workflow executions or runner run records (`status`, `attempt`, timestamps, summary/error). |
| POST | `/v1/capabilities/jobs/:id/run` | write | Run now. Workflow: execute under a Faststore lease (`409 job_run_in_progress`). Runner: enqueue a manual run (`202`, idempotent while one is queued). |
| POST | `/v1/capabilities/jobs/lease` | write | `{runnerId,limit?,leaseSeconds?,kinds?}` → `{leases:[{jobId,runId,kind,payload,attempt,leaseToken,leaseExpiresAt,timeoutSeconds}]}`. One lease per job; at most one runner holds it. |
| POST | `/v1/capabilities/jobs/:id/runs/:runId/heartbeat` | write | `{leaseToken,leaseSeconds?}` extends the lease. |
| POST | `/v1/capabilities/jobs/:id/runs/:runId/complete` | write | `{leaseToken,status:succeeded\|failed\|dead,summary?,error?}`. Failed runs retry until `maxAttempts` (default 3); the response reports `retry`/`retryAt`. |

`schedule.cron` accepts a 5-field expression or `@hourly/@daily/@weekly/@monthly`;
`everySeconds` is `10..2592000`. Tier-2 has no timer process: a runner polls
the lease endpoint on its own schedule. A missing/expired lease is reclaimable;
a failed run is retried with bounded backoff, then marked `dead`.

## Audit and usage

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/audit` | verified | Tier-2 mutation audit, tenant-scoped (`action`, `datasetId`, `recordId`, `actor`, pagination). |
| GET | `/v1/capabilities/usage` | verified | Tier-1 IAM usage summary (`from`, `to`, `feature`, `accountId`, `actor`, `method`, `status`). |
| GET | `/v1/capabilities/usage/events` | verified | Tier-1 IAM usage drill-down (`q`, pagination). |

## Files

Metadata is a Tier-1 Base document; bytes live in the Tier-1 SynapseOCS bucket
`SYNAPSEDX_FILES_BUCKET` (default `synapsedx-files`) under a tenant-prefixed key.
Legacy default-bucket objects are copied into OCS lazily on first read.
Cross-tenant ids return `404 file_not_found`. Quotas, MIME/size limits and the
other `SYNAPSEDX_FILES_*` settings are enforced before the OCS call.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| POST | `/v1/capabilities/files` | write | `{filename,contentType?,size?,checksumSha256?,datasetId?,recordId?,id?,public?}` → `201` metadata + `upload` instructions. `public:true` requires `files:publish` (or platform admin). Supports `Idempotency-Key`. |
| PUT | `/v1/capabilities/files/:id/content` | write | Raw binary body (`Content-Type`, optional `X-Checksum-SHA256`). Verifies checksum/quota and uploads to SynapseOCS. |
| GET | `/v1/capabilities/files/:id/content` | verified | Streams the object with `Content-Type`, `Content-Length`, `Content-Disposition` and `X-Checksum-SHA256`. |
| GET | `/v1/capabilities/public/files/:id` | anonymous | Public metadata for a file created with `public:true`; private/unpublished ids return 404. |
| GET | `/v1/capabilities/public/files/:id/content` | anonymous | Stable public download for an explicitly published file. The bytes remain in Tier-1 SynapseOCS. |
| GET | `/v1/capabilities/files/:id` | verified | Metadata (size, MIME, checksum, dataset/record link). |
| GET | `/v1/capabilities/files` | verified | Tenant list (`prefix`, pagination). |
| GET | `/v1/capabilities/files/quota` | verified | `{usedBytes,quotaBytes,remainingBytes,files,maxFileBytes,allowedTypes}`. |
| POST | `/v1/capabilities/files/:id/complete` | write | Finalize a presigned/direct upload after `HEAD` verification (`{size?}`). |
| POST | `/v1/capabilities/files/:id/presign` | write | `{method?,expiresIn?}` → signed URL. `501 presign_unsupported` when the OCS backend cannot sign URLs. |
| DELETE | `/v1/capabilities/files/:id` | write | Delete object + metadata. |

Uploads are idempotent by file id + checksum (Tier-1 upsert). A presigned `PUT`
must be followed by `/complete` so metadata/checksum stay authoritative. The
reference gateway/nginx cap request bodies at 25 MiB; keep
`SYNAPSEDX_FILES_MAX_BYTES` at or below that, or raise the edge limit too.

## Notifications

Tier-2 owns templates and product-scoped preferences; Tier-1 owns delivery,
retries, backoff, dead letters and provider relays. Notification ids are
indexed by Tier-2 tenant, so another tenant gets `404 notification_not_found`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET/POST | `/v1/capabilities/notifications/templates` | verified/write | List/create `{id?,name,channel,subject?,body,locale?}`. Bodies use `{{var}}` placeholders. |
| GET/PATCH/DELETE | `/v1/capabilities/notifications/templates/:id` | verified/write | Read/update/delete a template. |
| POST | `/v1/capabilities/notifications/send` | write | `{channel?|channels?,recipient?|to,template?,variables?,subject?,body?,locale?,priority?,idempotencyKey?}` → `202 {notifications}`. |
| POST | `/v1/capabilities/notifications` | write | Backward-compatible alias for `/send`. |
| GET | `/v1/capabilities/notifications` | verified | Tenant list (`status`, `limit`). |
| GET | `/v1/capabilities/notifications/:id` | verified | Delivery status, attempt count, last error/dead reason. |
| POST | `/v1/capabilities/notifications/:id/cancel` | write | Cancel a queued/failed notification. |
| GET/PUT | `/v1/capabilities/notifications/preferences/:recipient` | verified/write | `{channels,unsubscribed}`; enforced before every send. |
| POST | `/v1/capabilities/notifications/unsubscribe` | write | `{recipient}` → permanently suppressed for that tenant. |

Channels: `email`, `sms`, `push`, `webhook`, `log`. Same-key sends are
deduplicated by Tier-1; a suppressed recipient gets `409
notification_suppressed`. Provider keys and relay URLs stay in Tier-1.

## Search and geocoding

A provider-neutral adapter serves City and SOS from one deployment-owned
credential. Results are normalized to `{id,label,address,lat,lon,raw}`.

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/v1/capabilities/geo/autocomplete?q=&limit=&focus=` | verified | Address suggestions. |
| GET | `/v1/capabilities/geo/geocode?address=` | verified | Forward geocode. |
| GET | `/v1/capabilities/geo/reverse?lat=&lon=` | verified | Reverse geocode. |
| GET | `/v1/capabilities/geo/place?id=` | verified | Place details (`{result}`). |

Presets:

- `SYNAPSEDX_GEOCODER_PROVIDER=vietmap` uses `https://maps.vietmap.vn/api`
  endpoints (`/autocomplete/v4`, `/search/v4`, `/reverse/v4`, `/place/v4`) and
  the `apikey` query parameter; `SYNAPSEDX_GEOCODER_API_KEY` is the VietMap
  key.
- `generic` calls `{baseUrl}/autocomplete|geocode|reverse|place` with
  `SYNAPSEDX_GEOCODER_AUTH_HEADER` (default `x-api-key`) or
  `SYNAPSEDX_GEOCODER_AUTH_QUERY`. Endpoint paths are configurable through
  `SYNAPSEDX_GEOCODER_*_PATH`.

The key never reaches Tier-3 or the response body. Responses carry
`Cache-Control: private, max-age=30`. A provider `429` becomes
`429 rate_limited` with `details.retryAfter`; other provider failures/timeouts
return `503 geocoder_unavailable` with `details.providerStatus`. Rate limiting
itself remains the provider/edge policy; Tier-2 does not add a second shared
counter. When no provider is configured the routes return the typed 503 naming
`SYNAPSEDX_GEOCODER_BASE_URL`; this is configuration, not a Tier-1 gap.

## CORS

Allowed origins are the comma-separated `CORS_ORIGINS` allow-list (defaults:
`https://synapsecity.sbs`, `https://sos.synapsecity.sbs`,
`https://synapsedx.sbs`, `https://cloud.synapsedx.sbs`). The response echoes
only an allowed `Origin`, sets `Vary: Origin`, allows
`GET,POST,PUT,PATCH,DELETE,OPTIONS`, and exposes
`idempotency-key`/`if-match`/correlation/licence/pagination headers. Unknown
origins receive no `Access-Control-Allow-Origin`.
