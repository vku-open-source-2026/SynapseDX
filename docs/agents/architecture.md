# SynapseDX — Architecture Notes

Deep design notes for agents. Service-level API/file details live in
`docs/agents/services.md`; change workflows in `docs/agents/development.md`.
When these notes disagree with code, **code wins** (see "Known gaps" at the end).

## 1. System topology

```
Browser / CLI / SDK
        │ HTTPS + Bearer JWT | X-API-Key
        ▼
┌───────────────────────────────┐
│ Gateway :8080                 │  routing, authn, principal stamping,
│ routes.yaml + edge hardening  │  request-id, usage telemetry, /ready, /metrics
└───┬────┬────┬────┬────┬────┬──┘
    │    │    │    │    │    │
  IAM  Workflow LDS  Base Faststore Queue   AI :4003 / Inference :4008
 :4001  :4002  :4004 :4005  :4006   :4007
    │      │      │      │                 │
    └──────┴──────┴──────┴─── Postgres 16 ─┘
                  Redis 7 (Faststore + Queue)
                  S3-compatible (provisioned; no service API yet)
```

- Console is a static React SPA served by nginx (`:3000` in Compose, `:80`
  inside). It calls the gateway using a runtime `config.js` base URL.
- In production only the gateway (behind nginx/TLS) is exposed. Internal
  services must not publish host ports; each rejects direct `/v1/*` calls
  without `x-synapsedx-internal` when the secret is configured (IAM keeps
  `/v1/auth/*` reachable for login/OIDC).
- Inference (`:4008`, Python) is proxied by the gateway for `/v1/inference`.
  It is not part of IAM/tenancy: it is a model runtime with internal-secret
  gating only.

## 2. Component responsibilities

| Component | Owns | Does not own |
|---|---|---|
| Gateway | path routing, JWT/API-key verification, principal headers, request-id, CORS/security headers, per-IP edge limits, usage events, `/ready` | business authorization, request bodies |
| IAM | org/account/user/role/policy CRUD, token issuance, API keys, service accounts, OIDC, `authorize`, audit, usage ingestion/query | resource-level data |
| Workflow | workflow definitions, DAG execution, triggers, executions, encrypted credentials | global authz (uses IAM nodes when needed) |
| LDS | datasources, attribute registry, records, NGSI-LD exports, license headers | tenant identity (from gateway headers) |
| Base | collections, mappings, documents, queries, vector search, change feed | authn |
| Faststore | Redis data structures, TTLs, counters, locks | durability beyond Redis |
| Queue | queue configs, publish/consume leases, retries, DLQ | exactly-once delivery |
| AI | Console API-docs assistant; picks an endpoint + fills a try-it form | public API, authorization decisions |
| Inference | OpenAI-compatible chat proxy, embeddings, Decision-2.0 routing | tenant data |
| Console | admin UX, OIDC callback page, workflow graph editor | server-side enforcement |

## 3. Authentication and principal propagation

### Credentials

| Kind | Shape / TTL | Notes |
|---|---|---|
| Access JWT | HS256, `iss=synapsedx-iam`, `sub/org/account/scopes/kind`, default 1 h | Shared `IAM_JWT_SECRET` with gateway; weak/default secret aborts boot in prod |
| Refresh token | opaque `synapsedx_rt_...`, default 30 d, stored as hash | Single-use atomic rotation (`consumeAndRevokeRefresh`); reuse/race fails closed |
| API key | `synapsedx_` + random, prefix stored, hash at rest | Optional `IAM_API_KEY_PEPPER` (HMAC); legacy plain SHA-256 still verifies |
| Service-account JWT | `kind=service-account`, account-bound, scopes | No org claim; cannot use the org fallback |

### Gateway auth modes (`routes.yaml`)

- `none` — public route. A valid Bearer is still honored opportunistically (so
  LDS can serve a richer same-tenant view); invalid/absent stays anonymous.
- `jwt` — local HS256 verification only; 401 on failure.
- `apikey` — `X-API-Key`; verification via IAM `POST /v1/keys/verify`
  (fail-closed 503 when IAM is down). `GATEWAY_VERIFY_APIKEY=false` is dev-only
  and forbidden in production.
- `either` — JWT first, then API key.

After auth, the gateway **deletes every inbound `x-synapsedx-*` header** and
re-stamps:

```
x-synapsedx-user / -org / -account / -scopes / -kind
x-synapsedx-internal   (shared service secret, when configured)
x-synapsedx-anon: 1    (public route with no principal)
```

Downstream services treat these as trusted only because direct access is blocked
by the internal secret. When the secret is set, IAM still requires the caller's
Bearer/API key on resource routes (the internal header alone is accepted only
for `/v1/keys/verify` and `/v1/usage/ingest`); the gateway forwards the original
credential. In dev (no secret), IAM deliberately ignores stamped tenant headers
and re-verifies the presented credential; other services derive tenant from
headers and are dev/test-only in that mode.

### OIDC

- Authorization Code flow in IAM: discovery + JWKS ID-token verification
  (`RS256/384/512`, `ES256/384`), HMAC-signed short-TTL `state` for
  CSRF/replay protection, console `/oidc/callback` page. No PKCE/nonce today.
- IAM stores a shadow user keyed by `(org, email)` and optional `external_sub`.
- Existing org requires an existing membership (`org_membership_required`);
  a brand-new slug is self-service unless `OIDC_ALLOWED_ORGS` restricts it.
- `IAM_ALLOW_DEV_LOGIN` and `IAM_ALLOW_OIDC_DEMO_CALLBACK` must be `false` in
  production (passwordless mint / impersonation).

### Authorization

- AWS-style JSON policies: explicit `Deny` wins, then `Allow`, default deny.
- Action strings like `workflow:Execute`; resources like
  `arn:synapsedx:<org>:<account>:<service>:<id>` or `*`.
- `*` wildcard matcher keeps `:` literal, so `workflow:*` does not match
  `workflowEvil:x`; conditions support `StringEquals` / `StringLike`
  (`IfExists` variants). Policy docs are validated and size-capped on write.
- `/v1/authorize` evaluates policies for a `userId` and audits the decision;
  server injects `user/org/email` into the condition context (caller cannot
  override). `/v1/authorize/dry-run` evaluates inline documents without a user.
- IAM resource APIs use tenant membership checks (`canActForOrg` /
  `canActForAccount`) with a same-org fallback for bootstrap logins; machine
  tokens are account-bound and get no org fallback.

## 4. Tenancy model

```
Organization (slug)
  └── Account (slug, belongs to one org)
        ├── Users (org-scoped, unique email per org)
        ├── Roles (account-scoped)
        │     └── Policies (account-scoped JSON documents)
        ├── API keys (account-scoped, optional user)
        └── Service accounts (account-scoped)
```

Data services derive a tenant key from stamped headers:

```
if principal.org      -> "org:<org>"
else if principal.account -> "account:<account>"
else                     -> "user:<sub>"
```

- **Platform callers** (no principal, no anon marker) must pass
  `x-synapsedx-tenant` or `?tenant=` for Faststore/Queue; Base accepts
  `?orgId=`/`?accountId=`; LDS gets full read.
- **Anonymous callers** (public route, `x-synapsedx-anon: 1`) are rejected by
  Base, Faststore, Queue and LDS management routes. LDS permits only public
  NGSI-LD export/license reads.
- **Base collections** are org-bound, optionally account-bound. Visibility:
  same org (org-bound), same account (account-bound), or platform only for
  legacy global collections. Collection lookup includes scope, so same-named
  collections in different tenants are distinct.
- **Workflow rows** carry `org_id`, `account_id`, `run_as`, `owner_sub`.
  Access = account match OR org match; create/update cannot bind outside the
  caller's org. Anonymous direct calls keep a dev/test global view.
- **LDS** datasources are org/account-bound; cross-tenant access returns 404
  rather than 403 to avoid existence leaks. Anonymous export is public-only.
- **Faststore/Queue** keys are namespaced by tenant, so one Redis can serve all
  tenants without key collisions.

## 5. Data plane

### Postgres

One database (`synapsedx`), one Postgres instance; each service owns its tables
and migrations. `infra/postgres/init.sql` only installs extensions and creates
the `drizzle` schema; services create tables at startup.

| Service | Tables | Migration journal |
|---|---|---|
| IAM | `organizations`, `accounts`, `users`, `roles`, `policies`, `role_policies`, `user_roles`, `api_keys`, `service_accounts`, `refresh_tokens`, `workflows` (legacy), `usage_events`, `audit_log` | `__drizzle_migrations_iam` |
| Workflow | `synapsedx_workflows`, `synapsedx_executions`, `synapsedx_credentials` | `__drizzle_migrations_workflow` |
| LDS | `lds_datasources`, `lds_attributes`, `lds_records` | `__drizzle_migrations_lds` |
| Base | `synapsedx_base_collections`, `synapsedx_base_documents`, `synapsedx_base_vectors` | `__drizzle_migrations_base` |

Migrations run on startup under a per-service PostgreSQL advisory lock. Never
edit an applied migration; add a new one.

### Redis

- Faststore keys: `synapsedx:faststore:v1:<tenant>:...`; locks use
  `...:__lock__:<name>` and token-owned release/extend.
- Queue keys: `synapsedx:queue:v1:<tenant>:...`; sorted sets + hashes + Lua make
  consume/ack/nack atomic. One Redis can back both services.
- Gateway does **not** currently use Redis (edge limiting is in-memory).

### Object storage

S3/S3Mock is provisioned and the bucket is created by `s3-init`, but no service
code exposes object storage yet (roadmap: presigned bucket API). Do not assume
an S3 client exists.

### Memory fallbacks

Every stateful service falls back to an in-memory store when its backend env is
missing. This is for unit tests/dev only; production boot rejects missing
`DATABASE_URL` (IAM, Workflow, LDS, Base) and missing Redis URL (Faststore,
Queue) to avoid split-brain behavior.

## 6. Gateway routing details

`apps/gateway/routes.yaml` is data-driven; `${VAR:default}` is expanded from env.
Rules are checked by specificity (longer literal prefix wins):

- static path matches exact or `path/...` (not `/v1/organizations` for `/v1/orgs`);
- `*` matches exactly one non-empty segment;
- trailing `/*` matches any remainder including none.

Each route has `auth` and optional `timeoutMs` (1–300 s). The proxy does not
rewrite paths and does not parse bodies. Per-route proxies are mutually
exclusive (`pathFilter`), so wildcard public rules cannot be swallowed by a
shorter authenticated prefix. Upstream failure returns 502; timeout returns 504.

Operational endpoints: `/health`, `/ready` (aggregate probes, 503 when any
upstream is down, rate-limited), `/metrics` (Prometheus). `x-request-id` is
sanitized and propagated; usage telemetry is batched to IAM unless
`USAGE_TELEMETRY=false`.

## 7. Request flows

**Login (dev):** `POST /v1/auth/login {email, orgSlug?}` → user/org lookup or
creation → access JWT + refresh token. The Console stores both and rotates the
refresh token single-flight on 401.

**Authenticated API call:** gateway verifies → stamps headers → service derives
tenant → queries its backend → response. No service calls IAM per request except
API-key verification at the gateway.

**Workflow run:** trigger (manual/webhook/cron) → engine resolves `run_as` /
trigger principal → executes DAG → integration nodes call services through the
gateway/HTTP with the principal headers (or internal secret for platform nodes)
→ execution + node runs persisted.

**LDS public export:** anonymous gateway route → LDS marks caller `anon` →
projector emits only registered `public` attributes in NGSI-LD shape + license
headers; `_core` is never read.

## 8. Trust boundaries and security invariants

1. Edge verifies identity; services enforce tenancy. Never add a service route
   that trusts a tenant id from the body without checking the caller's scope.
2. `x-synapsedx-internal` is compared with `timingSafeEqual`; it is a shared
   secret, not a user credential.
3. Public routes must be explicit in `routes.yaml`; everything else defaults to
   authenticated.
4. Return `404` for cross-tenant resources where existence matters; `403` for
   actions inside a known resource that the caller may not perform.
5. Cap input sizes (documents 256 KB default, queue payload 256 KB, workflow
   definition 200 KB, policy patterns/statements) and validate depth/prototype
   keys.
6. LDS: reserved attribute names rejected at registration; unregistered fields
   default-deny at export; visibility is resolved at read time.
7. In production, workflow code runs in a separate Node process with an empty
   env, Node permission model, `vm` null-prototype context, and no string
   codegen (dev ts-node fallback is in-process and untrusted-user-unsafe).
8. Model output is untrusted: the AI assistant validates endpoints/params
   against its catalog and fails closed.

## 9. Known gaps / stale docs (verify in code before relying)

- `docs/architecture.md` says workflows live in a global namespace. Code now
  stores and filters `org_id`/`account_id` (`canAccessWorkflow`,
  `tenantBinding`). Treat the doc as historical.
- `docs/configuration.md` claims Redis-backed gateway rate limiting. The current
  gateway uses an in-memory per-IP limiter; no Redis client is imported there.
- API-key **scopes** are stored and returned by IAM, but the gateway does not
  enforce them yet (roadmap). Do not assume scope-based restrictions.
- S3 is provisioned but has no service API yet.
- `apps/tunnel-service/` contains only stale `dist/` artifacts and no source or
  package manifest; it is not part of the workspace.
- `/ready` probes IAM, Workflow, AI, LDS, Base, Faststore, Queue, but not
  Inference.
- The AI service is guidance-only and intentionally absent from the public API
  catalog used for authorization decisions.
