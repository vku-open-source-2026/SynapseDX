# Changelog

All notable changes to this project will be documented in this file.
Format based on Keep a Changelog; versioning follows SemVer.

## [Unreleased]

## [0.6.1] - 2026-10-27

### Added — Full SDK API Coverage & Workflow Credentials
- **Complete Multi-SDK Coverage for All Services**:
  - **AI Assistant Client (`c.ai`)**: Added `agent()` query method for the natural language API guidance assistant (`POST /v1/ai/agent`) across JavaScript (`client.ai.agent()`), Python (`client.ai.agent()`), and Go (`client.AIAgent()`).
  - **Workflow Credentials API (`c.workflow`)**: Full support for encrypted credentials (`createCredential`, `listCredentials`, `getCredential`, `rotateCredential`, `deleteCredential`) in JavaScript, Python, and Go SDKs.
  - **Gateway Webhooks Convenience**: Added `triggerWebhook` / `trigger_webhook` helpers to dispatch public inbound webhooks through the gateway.
- **Engine & Gateway Credential Route Aliases**:
  - Added wildcard route `- path: /v1/accounts/*/credentials` in Gateway `routes.yaml`.
  - Workflow service mounts `/v1/accounts/:accountId/credentials` as an alias alongside `/v1/credentials` with automatic parameter resolution (`name, kind/type, secret`).
  - Added `rotateCredentialRec`, `GET /v1/credentials/:id`, and `POST /v1/credentials/:id/rotate` in Workflow Service.
- **SynapseFlow AI Agent & Vector Search Integration**:
  - Support for SynapseFlow Decision Engine multi-branching and canvas socket tools.
  - SynapseBase vector store integration with natural-language auto-embedding.

## [0.6.0] - 2026-10-21

### Added — Synapse Inference Engine & Multi-SDK Ecosystem
- **Synapse Inference Engine (`apps/inference-service`)**: New dedicated multi-model
  inference microservice running FastAPI:
  - **LLM Proxy**: OpenRouter completions client (`/v1/inference/chat/completions`)
    with resilient exponential backoff, SSE streaming and model fallback.
  - **Self-Hosted Lightweight Embeddings**: `sentence-transformers/all-MiniLM-L6-v2`
    (384 dimensions) with deterministic L2 normalized fallback for constrained dev environments.
  - **Self-Hosted Decision-2.0-Eos-0.8B SLM**: Structured question evaluation (`system_one`)
    and semantic intent classification/routing (`/v1/inference/decision/route`).
  - **Security & Headers**: Standardized `x-request-id`, internal secret gating (`x-synapsedx-internal`),
    HSTS headers, and non-root Docker container.
- **Console Web UI Integration**:
  - Added dedicated **SynapseInference** playground (`/inference`) with interactive tabs for
    Decision & Semantic Routing (with confidence score visualizer), Text Embeddings
    (with vector preview & stats), and LLM Chat Playground.
  - Integrated into the Services sidebar drawer under "AI & Inference" (`faBrain`).
  - Added dedicated service dashboards for SynapseBase, Synapse Faststore, and SynapseQueue.
- **SDK Ecosystem (JS/TS, Python, Go)**:
  - **JavaScript / TypeScript SDK** (`@synapsedx/sdk`): Exposed under `client.inference.*`
    (`health`, `chat`, `embeddings`, `decision`, `route`).
  - **Python SDK** (`synapsedx_sdk`): Exposed under `client.inference.*`
    (`health`, `chat`, `embeddings`, `decision`, `route`).
  - **Go SDK** (`github.com/synapsedx/synapsedx-sdk-go`): Added `c.InferenceHealth()`,
    `c.InferenceChat()`, `c.InferenceEmbeddings()`, `c.InferenceDecision()`, and `c.InferenceRoute()`.
- **E2E & Unit Test Coverage**:
  - `npm run test:e2e:inference`: 8/8 comprehensive E2E tests through Gateway.
  - `npm run test:e2e:go`: 10/10 comprehensive E2E tests for Go SDK through live microservice stack.
  - Unit test coverage updated for all SDKs and services.

## [0.5.2] - 2026-10-21

### Fixed
- IAM `GET /v1/usage/summary` on real PostgreSQL: the timeline series query
  grouped by a duplicated parameterized bucket expression whose Drizzle
  placeholders were numbered differently in `SELECT` (`$1/$2`) and `GROUP BY`
  (`$6/$7`), so Postgres rejected it with `column "usage_events.created_at"
  must appear in the GROUP BY clause` and the endpoint returned 500 (the
  in-memory unit tests could not catch this). The query now groups/orders by
  the output column position (`GROUP BY 1 / ORDER BY 1`).
- E2E regression guard: `tests/e2e/api-check.sh` now exercises
  `/v1/usage/summary` (totals, features, series), `/v1/usage/events` (+ total)
  and org-wide attribution (`authKind=user` events carry an org, no account) on
  the real Postgres stack in CI/CD.

## [0.5.1] - 2026-10-21

### Added — usage analytics & request telemetry
- **Gateway telemetry**: every matched route records a usage event at response
  `finish` (request id, feature, route, method, path, status, duration, auth
  kind, org/account/user, error). Events are buffered per instance and flushed
  to IAM `POST /v1/usage/ingest` with the shared internal secret; the gateway
  never blocks traffic on telemetry. Disable with `USAGE_TELEMETRY=false`.
- **IAM usage store**: `usage_events` lives in Postgres (Drizzle migration
  `0001_true_zodiak`) with an in-memory fallback for dev/tests. Tenants only
  ever see their own org slice. `GET /v1/usage/summary` returns totals (success
  /4xx/5xx, error rate, avg/p95 latency, unique users/accounts, last request),
  per-feature statistics, a bucketed timeline and top routes;
  `GET /v1/usage/events` returns the raw request log (newest first, filters +
  offset paging) used for drill-down. Retention is swept hourly
  (`USAGE_RETENTION_DAYS`, default 30 — `0` keeps events forever).
- **Console Dashboard — "Usage & Requests" tab**: KPI cards, stacked
  success/error timeline, feature usage breakdown with traffic share/latency,
  top API endpoints, method/status/feature/search filters, paging and a
  per-request detail modal (status, error, latency, request id with copy,
  caller, feature, path). "System & Health" keeps the cluster inventory view.
  Telemetry is aggregated org-wide: login JWTs only carry an `org` claim, so
  the account picker deliberately does not filter usage (it would hide every
  user-session request).
- **SDK (JS/TS)**: `usageSummary(params?)` and `usageEvents(params?)` on the
  IAM client, exported from the root and `@synapsedx/sdk/iam` subpath.
- **API catalog / docs**: `/v1/usage/*` added to the in-console API explorer,
  `docs/api.md`, `docs/monitoring.md` and `docs/console.md`.

### Changed — PostgreSQL schema management
- IAM, Workflow, LDS and Base now use Drizzle ORM for all PostgreSQL
  persistence. `apps/*/src/schema.ts` is the schema source of truth and each
  service ships versioned migrations in `apps/*/drizzle/`.
- Services apply migrations on startup under per-service advisory locks and
  journals (`drizzle.__drizzle_migrations_{iam,workflow,lds,base}`), so they can
  share one database safely. `infra/postgres/init.sql` is now bootstrap-only
  (extensions + the migration-journal schema); table/index DDL and the IAM demo
  seed live in migrations.
- Memory fallbacks, tenant scoping, JSONB handling and transaction/concurrency
  semantics are unchanged.

### Fixed
- Dashboard usage queries now compute the `[from, to]` bounds at fetch time, so
  reloads always cover the freshest window instead of a time range frozen at
  first render.

## [0.5.0] - 2026-10-21

### Added — three self-managed data services
- **SynapseBase** (`apps/base-service`, :4005, gateway `/v1/base`, auth
  `either`): collections of JSON documents with Postgres (memory fallback),
  server-side validation and a logical **object ↔ data mapping**
  (`{fields: {logical: {path, type?, required?}}, additional?}`, plus the
  `{logical: "dot.path"}` shorthand). Writes send exactly one of `data`/`object`;
  reads use `?as=object`. Includes filters (`eq/ne/gt/gte/lt/lte/in/nin/contains/
  startsWith/endsWith/exists` + `and/or/not`), ordering, offset/cursor paging,
  projection, metadata fields (`$id/$version/$createdAt/$updatedAt`), optimistic
  concurrency (`ifVersion` / `If-Match`), atomic increments, batch writes and a
  change feed. Collections are org/account-bound and tenant-resolved.
- **Synapse Faststore** (`apps/faststore-service`, :4006, gateway
  `/v1/faststore`, auth `either`): Redis-backed cache/KV with TTL/NX/XX,
  atomic counters, hashes, lists, sets, sorted sets, key scans, batches and
  token-owned distributed locks. In-memory fallback for dev/tests. Keys are
  namespaced per tenant (`org:`/`account:`/`user:`; platform callers use
  `x-synapsedx-tenant` or `?tenant=`).
- **SynapseQueue** (`apps/queue-service`, :4007, gateway `/v1/queue`, auth
  `either`): at-least-once queues with delayed publishing, dedupe keys, custom
  message ids/headers, visibility-timeout leases + receipts, ack/ack-batch,
  nack/retry/dead-letter, heartbeat, inspection, purge, stats, dead-letter
  replay/delete. Redis sorted sets + Lua in production, in-memory fallback in
  dev/tests. Delivery is at-least-once, `maxAttempts` is enforced on nack, and
  expired leases are reclaimed regardless of attempt count.
- Gateway routes for all three prefixes and `/ready` probes; tenant header
  `x-synapsedx-tenant` forwarded for platform callers (other client identity
  headers remain stripped).
- Compose, production compose, `.env.example`, K8s manifests and Prometheus
  scrape/alert configs for the new services; root workspace dev scripts.

### Added — SDK 0.5.0
- **Python** (`synapsedx-sdk` 0.5.0): split into per-service modules
  (`iam`, `workflow`, `lds`, `base`, `faststore`, `queue`) exposed as
  `SynapseDXClient` namespaces, plus typed `BaseCollection`, `QueryResult`,
  `UNSET` sentinel, `tenant` support and `as_view=` for Base reads. Legacy flat
  methods remain and emit `DeprecationWarning`; LDS drops the `lds_` prefix.
- **JavaScript/TypeScript** (`@synapsedx/sdk` 0.5.0): per-service modules and
  subpath exports (`./iam`, `./workflow`, `./lds`, `./base`, `./faststore`,
  `./queue`), typed `BaseCollection`, `tenant`/`setTenant`, runtime-installed
  deprecated flat methods, `SynapseDXError` with `status`/`body`.
- **Go** (`synapsedx-sdk-go`): `base.go`, `faststore.go`, `queue.go` with full
  endpoint coverage, generic `BaseCollection[T]`, object↔data conversion and
  `Client.Tenant` / `SetTenant`.
- New SDK tests for every service; Python 32 tests, JS 34 tests, Go suite pass.

### Added — documentation
- New guides: `docs/synapsebase.md`, `docs/faststore.md`, `docs/queue.md`
  (concepts, endpoint tables, tenancy, errors, limits, curl + Python/JS/Go).
- `docs/api.md` covers the three services and the tenant header; docs index,
  architecture, configuration, quickstart, SDK guides and root README updated.

## [0.4.0] - 2026-10-20
### Added — SynapseLDS (linked data service)
- New `apps/lds-service` (:4004, gateway `/v1/lds`, auth `either`): licensed
  NGSI-LD datasources with an attribute schema registry
  (`Property|Relationship|GeoProperty`; visibility `public|restricted|internal`),
  record ingest with quarantine reporting, stats, and JSON-LD exports that carry
  `X-LDS-License: <SPDX>` + `Link: <licenseUrl>; rel="license"`.
- Security by construction (spec: `docs/specs/synapsedx-lds.md`): records store
  `{_core, entity, attributes}`; the projector is a **structural allowlist**
  (it never reads `_core`, so future metadata cannot leak); unregistered fields
  default-deny (stored but never exported); reserved names
  (`id/type/@context/internalId/tenantId/…`) are rejected at registration and
  quarantined at ingest; restricted exports require an authenticated caller in
  the datasource org.
- Hardened after an independent QA review (all fix points covered by tests and
  live production audits): datasource listing is principal-scoped (query params
  can only narrow — no cross-tenant enumeration, incl. API-key principals);
  org-bound/account-bound rows 404 outside their tenant (only unbound dev rows
  are platform-scoped); account principals can never create into an org; the
  ingest summary no longer echoes `_core` ids; the license URL rides inside the
  export `@context` as well as the headers; escaped entity ids fetch correctly;
  `limit/offset` and malformed bodies return `400` (never silent clamps or
  500s); restricted exports are `Cache-Control: private, no-store`; registry
  entries inherit `defaultVisibility`; webhook/cron runs execute as the
  workflow's tenant principal (SynapseLDS publishes stay tenant-scoped);
  `synapsedx.api` required args are validated at save time; prototype-chain
  attribute names are rejected; Postgres record versions bump atomically.
- **Anonymous public export channel** (spec "public = anyone reaching the
  API"): gateway wildcard routes `/v1/lds/licenses` and
  `/v1/lds/datasources/:id/entities[/:entityId]` are `auth: none` and stamp an
  internal `x-synapsedx-anon` marker; LDS serves anonymous callers only the
  public projection (license surfacing included) and answers `401
  auth_required` for every write, the registry, stats, listing and
  `?visibility=restricted`. A verifying Bearer token is honoured as optional
  auth on public routes (same-tenant restricted queries keep working through
  the same URL). Callers from a different tenant still get `404`
  (existence stays private); the ingest/export copyable URL in the console now
  works without a session. Gateway route syntax gains one-segment `*`
  wildcards (specificity-scored; exclusive proxy matching).
- Beyond the checklist: the workflow engine rejects trigger-less definitions
  at save time (no more "active but dead" workflows; test-run sandboxes opt
  out), the console pre-validates the create wizard against the server
  contract with actionable messages, the schema "Saved" confirmation survives
  the post-save refresh, and monitoring now scrapes `lds:4004/metrics`
  (`synapsedx_lds_*`) + `workflow:4002/metrics` alongside the gateway.

### Fixed
- Console overlays (New-datasource modal, workflow editor, code editor): the
  page-enter animation froze `transform: translateY(0)` on `<main>`, which made
  `<main>` the containing block for every `position: fixed` child — tall modals
  opened partly above the top edge (title and first fields unreachable, backdrop
  not covering the page) and full-screen editors stopped covering the sidebar.
  The animation no longer fill-forwards its transform and modals portal to
  `<body>`, so overlays always cover the viewport; `Input` also merges a caller
  `className` again instead of dropping it.
- Prod edge (`infra/prod/*.conf`, `infra/tls/nginx-tls.conf`): upstreams resolve
  dynamically via Docker's embedded DNS, so recreating `console`/`gateway`
  (new container IP) no longer leaves the edge serving `502`s from a stale
  upstream until the next nginx restart/reload.
- License catalog built in (CC0-1.0, PDDL-1.0, CC-BY-4.0, CC-BY-SA-4.0,
  ODbL-1.0, LicenseRef-Proprietary) — the user picks one per datasource.
- Workflow integration: `synapsedx.api` resource `lds`
  (`list-datasources`, `publish-record`) + template `webhook-to-lds`.
- Console: **Linked Data** page — datasource create with license picker, schema
  editor with visibility, JSON ingest, NGSI-LD preview, copyable export URL.
- Clients at 0.4.0: JS/Python/Go SDKs and the CLI gain full LDS support;
  gateway `/ready` aggregates lds; compose ships `synapsedx/lds:0.4.0`
  (all images bumped to 0.4.0); e2e `api-check.sh` covers the LDS flow incl.
  a metadata-leak assertion.
### Changed — workflow engine replaced (BREAKING from n8n)
- Removed n8n (SUL) from the default stack: `workflow-service` now runs its own
  Apache-2.0 local engine (`src/engine.ts` + `src/store.ts`, Postgres with in-memory
  fallback). Same REST contract (`/v1/workflows`, `/v1/executions`, `/v1/templates`,
  `ANY /webhook/:path`), plus `POST /v1/workflows/test-run`.
- Every node type executes: webhook/cron/manual triggers, httpRequest (SSRF-guarded),
  code (vm sandbox, 5s timeout, `$input/$json/$now`, console capture), set (incl.
  `={{ }}` templating), if (condition/value/conditions shapes, true=`main[0]`),
  noOp. Manual `execute` works for any trigger, active or not; activate gates only
  cron + public webhooks. New `code-transform` template; editor has Test-run + per-type
  examples. `tools/setup-n8n.sh` deprecated; compose no longer ships n8n.
### Added
- AI testing assistant: new `apps/ai-service` (`POST /v1/ai/agent`, gateway `auth: either`,
  never public/undocumented) — a decision model picks the endpoint from the API catalog,
  then the LLM generates path params + JSON body (OpenRouter backend, key server-side
  only, per-principal rate limit, fail-closed catalog validation, retry policy,
  different-provider fallback model, per-route 120s gateway timeout,
  multi-turn conversation history, how-to questions answered with guidance
  instead of 502, AI catalog covered by a drift gate in CI
  (`tools/catalog-check.mjs`)). Console API Docs gained a
  floating chatbot bubble (auth-gated) that explains and pre-fills try-it forms,
  plus Copy-as-cURL (secrets referenced as `$ENV`, never pasted raw).
- Workflow editor: `PUT /v1/workflows/:id {name?, definition?}` (SSRF/size-validated,
  name-only renames merged server-side since n8n requires full nodes) + "Edit definition"
  modal on the Console Workflows page; `POST /v1/workflows/:id/execute` now fires the
  workflow's real webhook trigger (declared `httpMethod` honored, 409 when inactive,
  400 when no webhook node) instead of proxying a non-existent n8n endpoint.
  `updateWorkflow` added to all three SDKs (JS/Python/Go) for parity.
- Console production hardening: shared `ScopeProvider` + Google-Cloud-style
  org/account picker in the header (mobile menu included), visual drag-and-drop
  workflow editor (pan/zoom/fit, palette, click-to-connect, inspector, undo/redo,
  JSON tab — pure `lib/workflow-graph.js`, unit-tested) over the PUT endpoint,
  blank-canvas creation, draft autosave with restore banner (session expiry
  never eats work), upgraded Dashboard
  (inventory stats, current context, service health, recent activity), `ErrorBoundary`
  around all routes (render errors show recovery UI instead of a white screen),
  array-shape guards + busy/double-submit guards + silent-refresh `api.call` on every
  page, user creation UI, "sign out all sessions", OIDC-start shape check,
  cross-tab refresh-token race handling (sibling tab's rotation is picked up instead
  of logging the user out).
- IAM tenant isolation on every write: creating/attaching/assigning/deleting roles,
  policies, keys, service accounts, accounts and users requires caller membership
  in the target tenant (role-based account binding, or same-org fallback since login
  JWTs carry org but no account; machine service-account tokens stay strictly
  account-bound) — `403 forbidden` otherwise. Gateway-stamped tenant headers are
  trusted only when `SYNAPSEDX_INTERNAL_SECRET` is set (dev direct callers can't
  spoof tenant); reads and org creation stay open by design. Key-creation `userId`
  validated; malformed UUIDs now `400 invalid_id`; auth-store outages answer
  `503 iam_unavailable`; creates under ghost parents answer `404` on both backends.
- API key inventory: `GET /v1/accounts/:accountId/keys` (id/prefix metadata only,
  `LIMIT 500`, tenant-bound `403` for foreign accounts) + key list/revoke UI on the
  Console Keys page; `listKeys` added to all three SDKs and `keys list` to the CLI.
  SA-token mint validates scopes before tenant checks and derives caller scopes from
  the verified credential when the stamped header is untrusted (dev).
- Workflow deletion: `DELETE /v1/workflows/:id` + Console Delete button (confirm) +
  `workflows delete|rm` in the CLI + `deleteWorkflow` in all three SDKs.
  Console Duplicate button (fresh webhookIds + collision-free `-copy` path, starts
  inactive), execution I/O data in run details, executions Load-more pagination
  + status filter, per-node Fill-example parameters.
- IAM management completeness: `GET /v1/roles/:roleId/policies` (attached list),
  `DELETE .../policies/:policyId` (detach), `GET /v1/users/:userId/roles`
  (assigned list), `DELETE .../roles/:roleId` (unassign) + Console attach/detach/
  assign/unassign UI (expandable rows) + SDK (JS/Python/Go) and CLI parity.
- No-orphan creates: org/account/role/policy/key/service-account creation under a
  ghost parent now answers `404 org_not_found`/`account_not_found` on both backends
  (body validation still runs first, so bad payloads stay `400`).
- Audit retention: opt-in `AUDIT_RETENTION_DAYS` (hourly batched purge of old
  `audit_log` rows, clamped 1–3650 days; default 0 = disabled).
- Audit decision filter: `GET /v1/audit?allowed=true|false` + Console dropdown.
- Oversized request bodies answer `413 payload_too_large` (was `500 internal`)
  on all JSON services.
- Fixed prod SSO redirect: `OIDC_REDIRECT_URI` was missing from the IAM compose
  env (container fell back to unreachable `localhost:4001`) and pointed at the
  API in `.env`; now wired through compose/k8s and set to the Console
  `/oidc/callback` page per `infra/authentik/README.md`. (Full browser SSO still
  needs Authentik exposed publicly with a matching issuer — infra follow-up.)
- Console SSR smoke test (`npm run test:ssr`, part of `npm test`): server-renders
  every route under both anonymous and signed-in sessions — catches module-eval
  crashes, missing providers and broken imports without a browser.
- Console UI strings unified to English (repo convention); Esc closes modals and the
  chatbot popup; Docs page snippets cover the new SDK methods.
### Changed
- Removed dead gateway route `/v1/n8n` (no service handler, zero references).
- Real OIDC Authorization Code flow in IAM (`apps/iam-service/src/oidc.ts`, zero new
  dependencies): HMAC-signed `state`, IdP discovery + JWKS caching, asymmetric-only
  ID-token verification (issuer/audience checks), shadow-user upsert from verified
  claims. `POST /v1/auth/oidc/callback {code, state}` now works in production; the
  demo-email path stays dev-only behind `IAM_ALLOW_OIDC_DEMO_CALLBACK`.
- Console SSO round-trip: `/oidc/callback` page (single-use code POST, tokens never
  touch the URL) + "Continue with SSO" on `/login`. Set `OIDC_REDIRECT_URI` to the
  Console page (e.g. `https://cloud.example.com/oidc/callback`).
- CLI one-line installer (`tools/cli/install.sh`, mirrored at `/install.sh` on the web
  frontend): `curl -fsSL https://synapsedx.sbs/install.sh | sh`. CLI tarball slimmed
  via `files: ["bin", "README.md"]`; `npx -y @synapsedx/cli@latest` verified live.
### Changed
- All user-facing documentation and Console UI strings translated to English
  (`README.md`, `docs/*.md`, Console pages, template descriptions, CLI README).
### Added (SDK/CLI full-system coverage)
- Go SDK rewritten to full API parity: auth (login/refresh/logout/logout-all/verify/me),
  orgs/accounts/users (+effective policies), roles/policies/attach/assign, authorize +
  dry-run, audit, API keys (+verify), service accounts (+token), workflows
  (list/get/create-from-template/create-raw/activate/deactivate/execute), templates
  (+single),   executions (list/get); `NewWithClient`, path-escaping, 7 offline tests.
  (Breaking, pre-1.0: `Login(email)` → `Login(email, orgSlug)`; package renamed
  `danax` → `synapsedx`.)
- Python SDK: `list_accounts`, `user_policies`, `verify_api_key`, `get_template`,
  `create_workflow` (raw), `deactivate_workflow`, `execute_workflow`,
  `list/get_execution(s)`; `set_token`/`set_api_key`; URL-encoding everywhere.
- JS SDK: same new endpoints as Python; per-request timeout (default 15s, configurable),
  empty-body tolerance, path-escaping on every id.
- CLI: `refresh`, `logout-all`, `verify`, `users create`, `users policies`,
  `keys verify`, `executions`, `templates <name>`, `workflows create --file`;
  refresh token persisted; config file 0600 + secrets redacted in `config`;
  URL-encoding on all ids.
### Fixed (security hardening)
- IAM/workflow no longer trust the network: `SYNAPSEDX_INTERNAL_SECRET` (shared with
  gateway) gates all `/v1/*` (except `/v1/auth/*`); dev fallback verifies the caller's
  own Bearer/API key. Gateway strips + re-sets `x-synapsedx-internal` after auth.
- OIDC demo callback (email-trusting, impersonation-capable) now kill-switchable via
  `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` (production); zod-validated email/slug inputs
  on login/callback/org/account/user creation.
- `IAM_JWT_SECRET` weak/default refuses to boot under `NODE_ENV=production` (warns in dev).
- API-key/refresh hashes at rest support `IAM_API_KEY_PEPPER` (HMAC-SHA256) with legacy
  fallback so pre-pepper keys keep working; constant-time internal-secret compare.
- Gateway: dedicated brute-force quota for `/v1/auth/*` (`AUTH_RATE_LIMIT_*`, 60/min),
  health/metrics/ready excluded from quota, sanitized `x-request-id`, baseline security
  headers, CORS-open warning; workflow: executions query allowlist, same headers.
- Containers run as non-root `node` (+ dev deps pruned); console nginx ships security
  headers + CSP; CLI/README/docs updated; `THIRD-PARTY.md` added; LICENSE/NOTICE
  rebrand leftovers (`danax`) fixed.
- Images strip compiled test files (`dist/*.test.js`) + `.dockerignore` hardened
  (no `.env` baked anywhere, incl. console).
- Compose: `restart: unless-stopped` on all long-running services (one-shot
  init jobs excluded); TLS profile included.
- Policy engine: `validatePolicyDocument` enforced on create + dry-run (caps on
  statements/patterns/condition bytes — blocks stored-ReDoS and oversized docs);
  eval-time guards (overlong StringLike never matches, oversized context rejected).
- Postgres: FK-column indexes (`idx_*_org/account/user`) for list + CASCADE paths
  (hash/slug lookups already covered by UNIQUE); migration note for existing DBs
  in `docs/production.md`.
- IAM input hardening: attach/assign verify references first (404 `role/user/policy_not_found`
  instead of 500; FK race mapped 23503→404); slug regex on role/SA create; scopes/name/expiry
  validation on key create + SA token; action/resource length caps on authorize/dry-run;
  workflow create validates name/template.
- Token TTLs (`IAM_JWT_EXPIRES_IN`, `IAM_REFRESH_EXPIRES_IN`) clamped at startup
  (garbage env → safe defaults, no NaN expiries).
- JWT `issuer: synapsedx-iam` pinned on every verify (gateway + IAM) — foreign
  tokens signed with a leaked/shared secret but wrong issuer no longer pass.
- Gateway: routes.yaml validated at boot (unknown auth mode / bad path → fail fast,
  not silent 401s); proxy `on.error` (HPM v3 API, not v2 `onError`) returns fast 502
  JSON instead of default 504 page on upstream death — live-verified (26ms);
  `PROXY_TIMEOUT_MS` clamped.
- Gateway rate-limiters no longer share one Redis store (was counting ALL traffic
  against the 60/min auth quota → spurious 429s, caught from a CI log): separate
  `synapsedx:rl:` / `synapsedx:rl:auth:` keyspaces; live-verified against real
  Redis (20 non-auth → untouched, 6th auth → 429 exactly at max=5) + unit test.
- K8s manifests: gateway now receives `IAM_JWT_SECRET` (was missing → all Bearer
  checks failed closed in-cluster); `SYNAPSEDX_INTERNAL_SECRET` + pepper wired via
  secrets; production env flips (`NODE_ENV`, dev-login/OIDC-demo off, HSTS, CORS,
  `GATEWAY_VERIFY_APIKEY`); `runAsNonRoot` securityContext; secrets example extended.
- Console `api.js`: URL-encoding on all ids (path-injection parity with SDKs/CLI).
- Console auth: silent access-token rotation (one retry on 401 via api-level
  session hook — no per-page changes; single-flight so parallel 401s share one
  rotation and can't burn each other's single-use refresh) and server-side logout
  (refresh revoked, previously local-only for up to 30 days).
- Console `src/lib/api.test.mjs` (offline, `npm test` workspace): single-flight,
  dead-refresh clear, api-key no-refresh — caught a real bug (retry guard skipped
  `/v1/auth/me`+`/verify`) before release.
- Console API catalog: added `GET /v1/templates/:name` + `GET /v1/executions/:id`
  (try-it now covers every documented route).
- Gateway `GATEWAY_VERIFY_APIKEY=true` + internal secret: upstream `/v1/keys/verify`
  call now carries `x-synapsedx-internal` (was missing → fail-closed 503 always);
  `verifyApiKeyUpstream` exported + unit-tested (header forwarding, invalid-key null,
  unreachable-IAM error).
- Rate limiting REMOVED from the gateway (ops decision to keep CI green): deleted
  both limiters + `ratelimit-redis.ts` + `TRUST_PROXY` + all `RATE_LIMIT_*`/`AUTH_*`
  config/compose/docs. The shared-store 429 bug was fixed first (separate keyspaces,
  live-verified) but the feature was then removed entirely. Brute-force protection
  for `/v1/auth/*` must now come from Ingress/WAF (see SECURITY.md). Restore by
  reverting this commit.
- `TRUST_PROXY` support (rate-limit sees real client IP behind TLS terminator;
  default false against IP-spoof); TLS profile sets `TRUST_PROXY=1` + `HSTS_ENABLED=true`
  on gateway; HSTS + `ssl_prefer_server_ciphers` at the TLS edge; console entrypoint escapes sed-special chars in runtime URL.
- IAM/workflow echo `x-request-id` on direct responses too (was gateway-only).
### Verified live (2026-10-08, memory backend, internal secret + VERIFY_APIKEY on)
- Gateway→IAM proxy: login, Bearer orgs/accounts, API-key create→use (upstream
  verify with internal header)→revoke all green; anonymous via gateway 401;
  **direct `:4001/v1/orgs` without internal secret 401 (bypass closed)**.
### Verified live (compose + Postgres backend, rebuilt images)
- 33-check PowerShell e2e green: full RBAC lifecycle on pg (incl. new 404/400
  paths, pepper-less hashes, FK-safe attach), refresh rotation single-use, key
  lifecycle, SA token, templates, negative/headers suite. Caught + fixed a real
  bug: malformed JSON bodies returned 500 `internal` (now 400 `invalid_json`
  in IAM + workflow, with unit tests).
### Fixed (opensource license)
- `tools/license-check.cjs`: zero-dependency copyleft gate (fails on
  GPL/AGPL/CPAL/EUPL, flags LGPL/MPL/EPL/CDDL/OSL for review) + SBOM export; wired into CI (with SBOM
  artifact), `make license-check`, and Python `pip-licenses --fail-on`. Tree verified
  clean (290 pkgs, no copyleft); `THIRD-PARTY.md` records the scan.
### Fixed (CI)
- CI Python job now installs `sdk-python[dev]` (pytest was missing → `pytest` failed);
  added prod-dep `npm audit --audit-level=critical` gate, copyleft gate + SBOM artifact,
  `pip-licenses` fail-on GPL, and `ruff check` + `ruff format --check` (SDK cleaned).
- `tests/e2e/api-check.sh`: negative/hardening checks (401 anonymous, 400 bad
  email/slug/oversized policy, security headers, no `x-powered-by`).
- `tests/e2e/sdk-check.js`: `listExecutions` tolerates absent n8n (CI subset has no
  engine — 502 `n8n_unreachable` means the path works, not that the SDK is broken;
  verified exit 0 both ways against a stub).
- `listExecutions` tolerance extended to n8n's own 401 `{"message":"unauthorized"}`
  (engine up but API key unprovisioned): skipped as engine-side, while OUR 401s
  (always carry an `"error"` key) still fail loudly — verified both ways by stub.
- New validation rejected explicit-`null` optionals (Python `displayName=None` →
  400): optional fields now `.nullish()` (null ≡ absent) + regression tests.
- Slug pattern relaxed `{2,64}` → `{1,64}` (single-char slugs like e2e's `"r"`/`"p"`
  are legitimate; charset restrictions unchanged) + regression test.
- Root `npm audit` (dropped version-fragile `--workspaces` flag).
### Fixed (security hardening — post-0.4.0 review)
- IAM reads are tenant-scoped like their writes: `GET /v1/orgs` only returns
  the caller's org; org/account/role/user reads answer `403`/`404` outside the
  caller's tenant; `GET /v1/audit` only shows rows targeting or triggered by
  the caller's org.
- Service-account token minting no longer widens scopes: an omitted `scopes`
  list delegates the caller's own scopes (possibly `[]`), and explicit scopes
  must be a subset of the caller's scopes unless it holds `*` — otherwise
  `403 scope_escalation`. The JS/Python/Go SDKs stop defaulting to `['*']` and
  omit the field instead.
- OIDC login can no longer auto-join an existing org: a new slug remains
  self-service, but joining an existing org requires an existing membership
  (`403 org_membership_required`); optional `OIDC_ALLOWED_ORGS` gates
  federation (`403 org_not_allowed`).
- Workflow credentials, executions and workflow instances are tenant-scoped
  end to end; IAM service-key wiring keeps gateway-authenticated internal
  calls working after the hardening.
- Code nodes run in a throwaway child process (no host `process`/`require`
  escape, hard timeout) and the SSRF guard additionally blocks IPv4-mapped
  IPv6, private-address DNS rebinding and internal redirect hops.

## [0.3.1] - 2026-10-12
### Fixed
- Console multi-domain: canonical `APP_URL` redirect (@ → cloud), CSP allow
  Google Fonts, Apache-2.0 headers on all source files.
- Prod edge: nginx + Certbot (LE) overlay `docker-compose.prod.yml`, all secrets
  via `.env` (`.notes/` local admin credentials, git-ignored).
- CI/CD: `ci.yml` (non-main + PR), `cd.yml` (main → dev channel publish),
  `release.yml` attaches open-format assets (tar.gz/whl/tgz + SHA256SUMS).

## [0.3.0] - 2026-10-07
### Changed (BREAKING)
- Standard monorepo restructure: `apps/` (console, gateway, iam-service,
  workflow-service — deployables with Dockerfiles, never published) vs `sdks/`
  (sdk-js, sdk-python, sdk-go) + `tools/cli` (distributables). npm workspaces:
  `apps/*`, `tools/*`, `sdks/sdk-js`. All CI paths, compose contexts, docs,
  SDK/CLI references updated accordingly.
- Repo moved into the `SynapseDX/` folder (dropped the nested `danax/` layer).
- Project renamed danax → SynapseDX: packages `@synapsedx/*`, `synapsedx-sdk`
  (PyPI), `synapsedx-sdk-go`, CLI `synapsedx` (`~/.synapsedx`), images
  `synapsedx/*`, K8s namespace `synapsedx`, key prefix `synapsedx_*`,
  OIDC `synapsedx-platform`, domain `synapsedx.local`, DB `synapsedx`.
### Added
- Console: public home `/` (header nav) separated from post-login console pages
  (sidebar nav); public `/api-docs`, `/docs`; Dashboard moved to `/dashboard`.

## [0.2.0] - 2026-10-06
### Added
- Console: AWS-style management UI (React 18 + Vite + Tailwind, BWD look:
  Poppins, `#4FACFE→#00F2FE` gradients, sidebar + FontAwesome) — Dashboard (ready),
  Organizations/Accounts/Users/Roles/Policies (JSON editor)/API Keys/Service
  Accounts/Workflows/Authorize simulator/Audit Log; email+org or API-key sign-in;
  runtime backend URL via `config.js` (`SYNAPSEDX_PUBLIC_BASE_URL`); compose service
  `:3000`, K8s Deployment/Service, Nginx SPA image `synapsedx/console`.
- `synapsedx` CLI, zero-dependency (Node 18+): login/use-key/logout, orgs/accounts/users,
  roles/policies/attach/assign, authz/sim (with `--context`), audit, keys
  create/revoke, sa create/token, workflows/templates, config; `--json` for scripts;
  `~/.synapsedx/config.json`; offline unit tests (standard exit codes).
- K8s: console Deployment/Service; release workflow additionally publishes `synapsedx-console`.
- Console (cont.): intro home page `/welcome`, interactive API Docs
  (try-it for every endpoint), in-app Console/SDK Docs.
### Changed (BREAKING)
- Project renamed OLP → synapsedx: packages `@synapsedx/*`, `synapsedx-sdk` (PyPI),
  `synapsedx-sdk-go`, CLI `synapsedx`, images `synapsedx/*`, K8s namespace `synapsedx`,
  key prefix `synapsedx_*`, OIDC `synapsedx-platform`, domain `synapsedx.local`.

## [0.1.0] - 2026-10-06
### Added
- Tier-1 PaaS MVP: gateway, IAM (AWS-style org/account/role/policy + tokens + OIDC config), core data (Postgres/Redis/S3), workflow-service over n8n (proxied control-plane + versioned templates + activate/execute, trigger→execution verified on real n8n).
- IAM extras: service accounts, API keys, refresh rotation + logout, `POST /v1/authorize` + dry-run simulator, list endpoints (users/roles/policies/SA).
- Gateway: root-mounted proxies with v3 `pathFilter` (no Express strip bugs), JWT/API-key auth, principal `x-synapsedx-*` propagation, `x-request-id` tracing, rate-limit (Redis-backed w/ fail-open, memory fallback), `/ready` aggregate, longest-prefix routing + unit tests.
- SDKs: `@synapsedx/sdk` (JS/TS), `synapsedx-sdk` (Python), `synapsedx-sdk-go` (minimal).
- Docker Compose topology (parametrized host ports, S3Mock + bucket init, Authentik on 19000/19443), service Dockerfiles + .dockerignore, K8s base manifests + secrets example, GitHub CI/release workflows.
- Docs: architecture, IAM model, API reference, quickstart (incl. scripted n8n bootstrap), object-storage, troubleshooting; OSS files: LICENSE (Apache-2.0), NOTICE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE.
- Tests: 50 node + 3 Python + Go unit green; live-verified: gateway proxy, IAM on memory + Postgres, n8n workflow create/list, S3 bucket ops, Authentik boot, JS/Python/Go SDKs, CLI full sweep, rate-limiting.

### Notes
- Default object store is Adobe S3Mock (Docker Hub `minio/minio` repo was removed); production may use MinIO (quay.io) or AWS S3 via `S3_ENDPOINT`.
- Known transitive advisory `braces` via `micromatch` (gateway) — accepted, see SECURITY.md.
