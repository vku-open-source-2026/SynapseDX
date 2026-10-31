# Configuration (env reference)

Copy `.env.example` → `.env` and replace every `*_change_me_*` value. Which service
reads which key (audited from source):

## Gateway (`apps/gateway`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` (fallback `GATEWAY_PORT`) | 8080 | listen port (inside the container) |
| `IAM_SERVICE_URL` | `http://iam:4001` | IAM upstream |
| `WORKFLOW_SERVICE_URL` | `http://workflow:4002` | workflow upstream |
| `AI_SERVICE_URL` | `http://ai:4003` | AI assistant upstream |
| `LDS_SERVICE_URL` | `http://lds:4004` | SynapseLDS upstream |
| `BASE_SERVICE_URL` | `http://base:4005` | SynapseBase upstream |
| `FASTSTORE_SERVICE_URL` | `http://faststore:4006` | Synapse Faststore upstream |
| `QUEUE_SERVICE_URL` | `http://queue:4007` | SynapseQueue upstream |
| `IAM_JWT_SECRET` | — | **must match** IAM, used to verify Bearer tokens |
| `GATEWAY_ROUTES_PATH` | `./routes.yaml` | routing table |
| `GATEWAY_VERIFY_APIKEY` | `true` | `true` → centralized `X-API-Key` verification via IAM (fail-closed 503 when IAM is down); `false` → edge presence check, upstream verifies (dev-only, forbidden in production) |
| `PROXY_TIMEOUT_MS` | 30000 | upstream timeout (504 when exceeded) |
| `CORS_ORIGIN` | (allow all) | `a.com,b.com` → only those origins (production) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | gateway → service credential (`x-synapseone-internal` header); **identical** on every service in production |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |
| ~~`RATE_LIMIT_*` / `AUTH_RATE_LIMIT_*` / `TRUST_PROXY`~~ | — | removed from gateway (rate limiting lives at Ingress/WAF); restore by reverting the removal commit |
| `REDIS_URL` | — (memory) | `redis://...` → Redis-backed rate limiting (shared across replicas, fail-open when Redis is down) |
| `GATEWAY_HOST_PORT` | 8080 | host port (compose only) |

## IAM (`apps/iam-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4001 | listen port |
| `DATABASE_URL` | — (memory) | `postgres://...` → enables the Postgres backend |
| `REDIS_URL` | — | reserved (centralized session/ratelimit, v0.2) |
| `IAM_JWT_SECRET` | — | HS256 for access/service JWTs (≥32 random chars); boot fails in `NODE_ENV=production` when weak/default |
| `IAM_JWT_EXPIRES_IN` / `IAM_REFRESH_EXPIRES_IN` | 3600 / 2592000 (seconds) | token TTLs (clamped 60–86400 / 3600–315360000; garbage env falls back to default) |
| `IAM_API_KEY_PEPPER` | — (plain SHA-256) | HMAC pepper for API-key/refresh-token hashes at rest; keys created before the pepper still verify (legacy fallback) |
| `AUDIT_RETENTION_DAYS` | `0` (disabled) | hourly purge of `audit_log` rows older than N days (batched, clamped 1–3650); prod e.g. `180` |
| `IAM_ALLOW_DEV_LOGIN` | `true` | `false` disables `POST /v1/auth/login` in production (SSO + API keys only) |
| `IAM_ALLOW_OIDC_DEMO_CALLBACK` | `true` | demo callback trusts the caller-supplied email (impersonation possible) — production **must** be `false` (then a real IdP `code` is required) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` (except `/v1/auth/*`) — blocks direct `:4001` bypass |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |
| `OIDC_PROVIDER` | `authentik` | IdP display name (`authentik`\|`keycloak`) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | see `.env.example` | federated OIDC (Authentik/Keycloak). For SPA login, point `OIDC_REDIRECT_URI` at the Console's `/oidc/callback` page (e.g. `https://cloud.example.com/oidc/callback`) |
| `OIDC_ALLOWED_ORGS` | — (any slug) | comma-separated org **slugs** allowed through OIDC → `403 org_not_allowed` otherwise. A new slug is self-service (org is created on first login); joining an **existing** org always requires an existing membership (`403 org_membership_required`) |

## Workflow (`apps/workflow-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4002 | listen port |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend (`synapseone_workflows` + `synapseone_executions`); required in production |
| `WORKFLOW_CRON_TICK_MS` | 15000 | cron scheduler tick (ms, clamped ≥10000) |
| `WORKFLOW_TIMEOUT_MS` | 60000 | hard execution budget for workflows without `settings.timeoutMs` (clamped 1000–300000). AI templates set 300000 |
| `INFERENCE_TIMEOUT_MS` | 120000 | per-call budget for workflow → inference LLM requests (clamped 1000–300000) |
| `IAM_SERVICE_URL` | `http://iam:4001` | internal base URL for `synapseone.api` IAM nodes (users/roles/policies/audit/keys) |
| `SYNAPSEONE_IAM_API_KEY` | — | service API key sent as `X-API-Key` on `synapseone.api` IAM calls; IAM requires a real caller credential even with the internal secret. Create it on the workflow service account (`POST /v1/accounts/:accountId/keys`, scope `*`). Unset → IAM nodes fail with a clear configuration error |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4002` bypass (`/webhook/*` stays public) |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |

## AI agent (`apps/ai-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4003 | listen port |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible LLM provider (key stays server-side, never reaches the browser) |
| `AI_API_KEY` | — | provider key; unset → `/v1/ai/agent` answers `503 ai_not_configured` |
| `AI_DECISION_MODEL` / `AI_LLM_MODEL` | `inception/mercury-2.5` / `liquid/lfm-2.5-2.6b:free` | endpoint-picker model / call-generator model |
| `AI_TIMEOUT_MS` | 20000 | per-LLM-call timeout (clamped 1s–300s) |
| `AI_RETRIES` | 2 | extra attempts on empty/invalid/5xx LLM replies (clamped 0–3; 4xx fail fast) |
| `AI_LLM_FALLBACK_MODEL` | decision model | different-provider fallback for generate/guide after the primary exhausts retries; empty disables |
| `AI_RATE_LIMIT` | 30 | agent calls per principal per minute (clamped 1–1000; LLM calls cost money) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4003` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |

## Linked data — SynapseLDS (`apps/lds-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4004 | listen port (gateway route `/v1/lds`, auth `either`) |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend (`lds_datasources` + `lds_attributes` + `lds_records`); required in production |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4004` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |

Records are stored as `{_core, entity, attributes}`; the NGSI-LD projector only reads
`entity` + registry-approved `attributes` (structural allowlist), so `_core` (tenant,
internal id, source id, actor, any future field) can never be serialized. Unregistered
attributes default-deny; visibility is resolved at read time from the registry
(`public|restricted|internal`, restricted needs an in-org principal).

## Base — SynapseBase (`apps/base-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4005 | listen port (gateway route `/v1/base`, auth `either`) |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend; **required in production** (otherwise a per-process in-memory store) |
| `BASE_MAX_DOCUMENT_BYTES` | 262144 | max serialized document size, clamped 1024..4194304 |
| `BASE_QUERY_SCAN_LIMIT` | 10000 | max documents scanned per query, clamped 100..100000; larger collections return `413 collection_too_large` |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4005` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `BASE_SERVICE_HOST_PORT` | `127.0.0.1:4005` | compose host binding |

## Faststore — Synapse Faststore (`apps/faststore-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4006 | listen port (gateway route `/v1/faststore`, auth `either`) |
| `FASTSTORE_REDIS_URL` | falls back to `REDIS_URL` | `redis://...` → Redis backend; **required in production** |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4006` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `FASTSTORE_SERVICE_HOST_PORT` | `127.0.0.1:4006` | compose host binding |

## Queue — SynapseQueue (`apps/queue-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4007 | listen port (gateway route `/v1/queue`, auth `either`) |
| `QUEUE_REDIS_URL` | falls back to `REDIS_URL` | `redis://...` → Redis backend; **required in production** (an in-memory queue would split-brain across replicas) |
| `QUEUE_MAX_PAYLOAD_BYTES` | 262144 | max serialized message payload, clamped 1024..1048576 |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4007` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `QUEUE_SERVICE_HOST_PORT` | `127.0.0.1:4007` | compose host binding |

The three data services share the platform tenancy model: principal callers are
scoped to their org/account/user; platform callers must select a tenant with
`x-synapseone-tenant` (Faststore/Queue) or `?orgId`/`?accountId` (Base). The gateway
forwards `x-synapseone-tenant` and strips the other client-supplied identity headers.

## Console (`apps/console`, runtime via `config.js`)

| Key | Default | Meaning |
|---|---|---|
| `SYNAPSEONE_PUBLIC_BASE_URL` | `http://localhost:8080` | gateway URL the **browser** calls (must be browser-reachable, not a docker hostname) |
| `CONSOLE_APP_URL` | `http://localhost:3000` | canonical app host; the landing domain redirects sign-in here in multi-domain deploys |

## Core data / external engines

Postgres (`POSTGRES_*`; IAM, workflow, LDS and Base), Redis (`REDIS_URL`; gateway
rate limiting, Faststore and Queue), Authentik (`AUTHENTIK_*`, host ports
`AUTHENTIK_HTTP_PORT=19000`), S3 (`S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY`,
`S3_HOST_PORT=9090`).
