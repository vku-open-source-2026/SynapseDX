# API reference (via Gateway :8080, or services directly)

Base: `http://localhost:8080` (gateway) — every `/v1/*` route needs
`Authorization: Bearer <JWT>` or `X-API-Key`, except `/v1/auth/*`.
Calling `:4001`/`:4002` **directly** (bypassing the gateway) additionally requires
`x-synapsedx-internal: <SYNAPSEDX_INTERNAL_SECRET>` once the secret is configured
(production), otherwise 401 — see `SECURITY.md`.

## Principal propagation (gateway → upstream)

The gateway **strips** every client-sent `x-synapsedx-*` header (anti-spoofing), then
**re-stamps** them from the verified principal: `x-synapsedx-kind: user|apikey`,
`x-synapsedx-user: <sub>`, `x-synapsedx-org`, `x-synapsedx-account`,
`x-synapsedx-scopes`, plus `x-synapsedx-internal` (service-to-service credential when
configured). Upstreams trust these directly without re-verifying the JWT.

## Input validation (400 on bad input)

- `email`: RFC email, ≤320 chars, auto lowercased/trimmed. `slug` (org/account/policy/role):
  `^[a-z0-9-]{1,64}$`. `displayName`: 2–200 chars.
- Policy `document`: `Statement[]` with 1–100 entries, `Effect` Allow|Deny, each
  Action/Resource pattern ≤512 chars, `Condition` ≤8KB (stored-ReDoS/DoS guard). Dry-run
  limited to 20 documents per call.
- attach/assign return 404 when the role/policy/user doesn't exist (instead of 500).
- `scopes`: 1–100 strings ≤200 chars; key `name` 1–100 chars; `expiresInSeconds`
  1–315360000; `action` ≤512, `resource` ≤2048 chars.

## Auth

- `POST /v1/auth/login {email, orgSlug}` → `{accessToken, refreshToken, user}`
  (dev sign-in; disable in production with `IAM_ALLOW_DEV_LOGIN=false`)
- `POST /v1/auth/refresh {refreshToken}` → `{accessToken, refreshToken}` (rotation: the old token is revoked)
- `POST /v1/auth/logout {refreshToken}` → `{ok}`
- `POST /v1/auth/logout-all {refreshToken}` → `{ok, revoked}` (revokes all of your own sessions)
- `GET /v1/auth/verify` (Bearer or X-API-Key) → `{valid, ...}`
- `GET /v1/auth/me` (Bearer) → `{user, kind}`
- `GET /v1/auth/oidc/config` → `{issuer, clientId, redirectUri, codeExchange, ...}`
- `GET /v1/auth/oidc/start?org=acme` → `{authorizeUrl, state}` (state is HMAC-signed, 10-minute expiry)
- `POST /v1/auth/oidc/callback {code, state}` → token set (**real** Authorization Code
  exchange: the code is redeemed at the IdP, the ID token is signature-verified against
  the IdP JWKS — asymmetric algs only, issuer + audience checked — then a shadow user
  is upserted from the verified `email`/`sub` claims)
- `POST /v1/auth/oidc/callback {email, orgSlug}` → token set (**demo** mode: trusts the
  caller-supplied email — dev only; set `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` in
  production, which then requires a real IdP `code`)

## Orgs / Accounts

- `GET /v1/orgs` → `[{id, slug, display_name}]`
- `POST /v1/orgs {slug, displayName}` → org
- `GET /v1/orgs/:orgId/accounts`
- `POST /v1/orgs/:orgId/accounts {slug, displayName}`
- `GET /v1/orgs/:orgId/users` → users in the org
- `POST /v1/orgs/:orgId/users {email, displayName}`

## Roles / Policies / Authorize

- `POST /v1/accounts/:accountId/roles {slug, description}`
- `GET /v1/accounts/:accountId/roles`
- `DELETE /v1/roles/:roleId`
- `POST /v1/accounts/:accountId/policies {slug, description, document}`
- `GET /v1/accounts/:accountId/policies`
- `DELETE /v1/policies/:policyId`
- `POST /v1/roles/:roleId/attach {policyId}`
- `POST /v1/users/:userId/assign {roleId}`
- `GET /v1/users/:userId/policies`
- `POST /v1/authorize {userId, action, resource, context?}` → `{allowed, matchedBy}` (context is merged with DB-backed user/org/email; unknown userId → `200 {allowed:false}` by contract, not 404)
- `POST /v1/roles/:roleId/attach {policyId}` (policy must live in the role's account — `403 cross_account` otherwise);
- `DELETE /v1/roles/:roleId/policies/:policyId` → detach (idempotent `{ok:true}`);
- `GET /v1/roles/:roleId/policies` → attached policies;
- `POST /v1/users/:userId/assign {roleId}` (role's account must be in the user's org — `403 cross_org` otherwise);
- `DELETE /v1/users/:userId/roles/:roleId` → unassign (idempotent);
- `GET /v1/users/:userId/roles` → assigned roles
- Tenant isolation on every write: creating/attaching/assigning/deleting roles,
  policies, keys, service accounts, accounts and users requires caller membership
  in the target tenant (role-based, or same-org fallback; service-account tokens stay
  strictly account-bound) — otherwise `403 forbidden`. Reads stay open; org creation
  stays open (bootstrap).
- `POST /v1/authorize/dry-run {documents[], action, resource, context?}` → `{allowed}` (simulator, no user needed)
- `GET /v1/audit?limit=50&actor=<id>&allowed=true|false` → authorize-decision audit log (newest first, limit clamped 1..200)

## Keys

- `POST /v1/accounts/:accountId/keys {name, scopes, expiresInSeconds?}` → `{apiKey (shown once), id, prefix}`
- `GET /v1/accounts/:accountId/keys` → key metadata list (id/name/prefix/scopes/expiry/revoked — never secret values)
- `POST /v1/keys/verify {apiKey}` → `{valid, account_id, scopes}`
- `DELETE /v1/keys/:id` → revokes the key

## Service accounts (machine identity)

- `POST /v1/accounts/:accountId/service-accounts {slug, description}` → service account
- `GET /v1/accounts/:accountId/service-accounts` → list
- `POST /v1/service-accounts/:id/token {scopes?}` → `{accessToken (kind=service-account), expiresIn}`

## Credentials (PROPOSED contract — backend in progress, do not rely on yet)

Account-scoped secrets for workflow nodes. Secrets are encrypted at rest and
NEVER returned: create/rotate accept a `secret` once; list/get return metadata
only (`{id, name, type, accountId, expiresAt, version}`). `type` is one of
`bearer|basic|apiKey|oauth2`.

- `POST /v1/accounts/:accountId/credentials {name, type, secret, expiresAt?}` → metadata (201)
- `GET /v1/accounts/:accountId/credentials` → `[metadata]`
- `GET /v1/credentials/:id` → metadata
- `DELETE /v1/credentials/:id` → `{ok}`
- `POST /v1/credentials/:id/rotate {secret}` → metadata (bumps `version`)

## Workflows (local built-in engine)

- `GET /v1/templates` / `GET /v1/templates/:name`
- `GET /v1/workflows` (list: `[{id,name,active,nodes,connections,settings,orgId?,accountId?,owner?,runAs?,revision,createdAt,updatedAt}]`;
  gateway-authenticated callers see their org slice + legacy-global rows; `?orgId=` / `?accountId=` filter exactly)
- `GET /v1/workflows/:id` (tenant-bound rows 404 outside their org)
- `DELETE /v1/workflows/:id`
- `POST /v1/workflows/:id/activate` / `POST /v1/workflows/:id/deactivate`
  (activate re-validates the stored definition and returns `409 webhook_path_conflict`
  when another active workflow already serves the same webhook path)
- `POST /v1/workflows {name, template} | {name, definition, settings?, orgId?, accountId?, runAs?}`
  (template webhook paths are auto-suffixed `-2, -3, …` so double-creates never collide;
  explicit org/account must stay inside the caller's own org, else `403 cross_tenant`;
  every create stamps `owner` from the caller)
- `PUT /v1/workflows/:id {name?, definition?, settings?, orgId?, accountId?, runAs?}` (structural/SSRF/size/cycle-validated, ≤200KB, ≤50 nodes, every node needs a 1..128 char `name`; every update bumps `revision`)
- `POST /v1/workflows/:id/execute {input}` (manual run — works for ANY trigger type, active or not; the body IS the input; returns `{ok, output, executionId, status}`; `500 {ok:false, error}` when a node fails; records the caller principal + `actor: "workflow:<id> principal:<sub>"`)
- `POST /v1/workflows/test-run {definition, input, workflowId?}` (try a definition without saving; validates + executes in the sandbox; persisted as a `triggered_by=test` execution — pass `workflowId` to attach it to that workflow's history; returns `{ok, output, nodeRuns, executionId}`)
- `GET /v1/executions` (`limit,offset,workflowId,status,triggeredBy,includeData`; `limit/offset` 0..9999, `offset=0` = first page; `triggeredBy` is `manual|webhook|cron|test`; secret-looking keys in payloads are masked to `***`; always returns the envelope `{data: [...]}` — SDKs/Console/CLI unwrap `.data` and also accept a bare array) / `GET /v1/executions/:id` (`?includeData=true` for per-node input/output; also carries `principal` + `actor`)
- `GET/POST/DELETE /v1/credentials[?accountId=]` (account-scoped secrets, AES-256-GCM at rest via `SYNAPSEDX_CREDENTIAL_KEY`; list/create return metadata only, never secrets; duplicate names per account are `409`)
- Public inbound webhooks: `ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares that `path` (also proxied at the gateway as `/webhook`, auth none — per-workflow auth below still applies):
  ```bash
  curl -X POST http://localhost:4002/webhook/transform \
    -H 'Content-Type: application/json' \
    -d '{"value":21}'
  # → {ok, output, executionId}
  ```
  Per-workflow hardening from the webhook node's params: `auth` (`none` |
  `secret-header` | `hmac-sha256` over the raw body | `jwt` HS256 with exp/nbf +
  optional iss/aud — all referencing a `credentialId`, optional custom `header`),
  `rateLimit: {rpm}` (default 600, `429` over budget), `idempotency: {header, ttlSeconds}`
  (`409 duplicate_delivery` on replay). Failures surface as `401 unauthorized`,
  `409`, `429` and feed `/metrics`.
- `GET /metrics` (Prometheus: `synapsedx_workflow_runs_total{triggered_by,status}`,
  `synapsedx_workflow_webhook_rejected_total{reason}`)

Calling SynapseDX from a workflow: the SSRF guard blocks first-party hosts by
default. Operators who need it set `SYNAPSEDX_SELF_BASE_URLS` (comma-separated
exact origins, e.g. `"http://gateway:8080,http://iam:4001"`). Calls to those
origins bypass the block AND forward the run principal as `x-synapsedx-*`
headers so downstream services can authorize. Redirects are followed manually
with every hop re-checked (max 5).

Node types: `webhook` (trigger, `parameters.path/httpMethod`), `cron` (trigger, `rule.interval` or `cronExpression`), `manualTrigger`, `httpRequest` (`url/method/headers/body`, SSRF-blocked, 15s timeout), `code` (sandboxed JS, `parameters.code`, 5s timeout, `$input/$json/input/$now` + `console` capture), `set` (`values/assignments`, supports `={{ $json.x }}` templating), `if` (`condition` JS or `value1/operation/value2` or n8n `conditions[]`; `main[0]`=true, `main[1]`=false), `noOp` (passthrough). Unknown types pass data through but are recorded as `skipped` (visible in `nodeRuns`), not silent success.

| Node | Key `parameters` | Notes |
| --- | --- | --- |
| `webhook` | `path` (1..128, `[A-Za-z0-9_./-]`, no `..`), `httpMethod` (`GET\|POST\|PUT\|PATCH\|DELETE\|HEAD`, default `POST`), `auth` (`{mode: none\|secret-header\|hmac-sha256\|jwt, header?, credentialId?}`), `rateLimit: {rpm}` (default 600), `idempotency: {header, ttlSeconds}` | `ANY /webhook/:path` routes to the ACTIVE workflow with that path; activating with a taken path is `409`; auth/rate/idempotency enforced per node config |
| `cron` | `rule.interval[]` (`{field: seconds\|minutes\|hours\|days, <field>Interval: N}`), or `cronExpression` (`"*/N * * * *"`, `"M H * * *"` wall-clock, `@hourly`, `@daily`), or `intervalMs`, plus optional `timezone` (wall-clock only) | Minimum 10s — faster schedules and other cron formats are rejected at save/activate; the editor shows the next run |
| `manualTrigger` | — | Run from Console/CLI with any JSON input |
| `httpRequest` | `url` (public `http(s)` or allowlisted self origin), `method`, `headers` (object), `body`/`jsonBody` (sent only when configured — the input is NOT auto-forwarded), `auth: {credentialId, header?}` (secret resolved server-side), `retry: {attempts 1–5, delayMs}`, `timeoutMs` (1–30s) | Redirects followed manually, max 5 hops, every hop re-checked against the SSRF blocklist; default 15s timeout; ≤200KB body, ≤500KB response |
| `code` | `code` (JS, ≤50KB, default 5s timeout), `timeoutMs` (1–15s), `retry` | `$input`/`$json`/`input` in scope, `$now` ISO time, `console.*` captured; bare expressions get an implicit `return (…)`; result `_logs` key is yours — console output then lands in `_consoleLogs` |
| `set` | `values` (object), `assignments` (`[{name, value}]`), legacy `values.assignments`/`fields` | Values support `={{ $json.x }}` / `{{ … }}` / `=expr` templating against the incoming item; merged over the input |
| `if` | `condition` (JS), or `value1` + `operation` + `value2` (`equals|notEquals|contains|notContains|startsWith|endsWith|larger|largerEqual|smaller|smallerEqual|isEmpty|isNotEmpty`), or n8n `conditions[]` | Output branch 0 = true, 1 = false; an unwired side stops the run there (the editor warns) |
| `noOp` | — | Passthrough log point |

Any node accepts `disabled: true` (skipped at run time, data flows through —
a disabled `if` takes its true branch) and `httpRequest`/`code` accept
`retry`/`timeoutMs`. Workflow `settings.onError: "continue"` absorbs node
failures into `partialErrors` instead of failing the run. Every workflow
update bumps `revision`. Export/import via the Console (portable
`{name, nodes, connections, settings}` JSON) or the raw API payloads.

Execution semantics: non-`if` nodes fan out to every branch; a diamond (`A→B, A→C, B→D, C→D`) runs `D` once per incoming edge with that edge's data. With several terminal nodes the final `output` is keyed by terminal node name (`{Left: …, Right: …}`); with one terminal it is that node's output directly. Per-node `nodeRuns[]` carry `status` (`success|error|skipped`), `input`, `output`, `error`, `durationMs`, `attempts?`.

## Health / Metrics

- `GET /health` (each service + gateway)
- `GET /ready` (gateway: aggregates iam + workflow + ai, 503 when degraded)
- `GET /metrics` (gateway, Prometheus)

## Tracing

- The gateway assigns `x-request-id` (keeps a client-sent one), returns it in the
  response and forwards it upstream.
