# Architecture — SynapseDX Tier-1 PaaS

```
                    ┌─────────────┐   OIDC    ┌──────────────┐
                    │  Authentik  │◄─────────►│   Keycloak   │  (pick one, outside the cluster)
                    │  (default)  │   (alt)   │  (compatible)│
                    └──────┬──────┘           └──────────────┘
                           │ sub/email (verified ID token)
                    ┌──────▼──────────────────────────────────┐
                    │ IAM service (:4001)                     │
                    │ Org→Account→User→Role→Policy (AWS-style)│
                    │ token: JWT + refresh + API key + SA     │
                    │ Postgres (orgs/accounts/... tables)     │
                    └──────┬──────────────────────┬───────────┘
                           │ verify                │ authorize()
              ┌────────────▼────────┐    ┌─────────▼───────────┐
              │ Gateway (:8080)     │    │ Workflow svc (:4002) │
              │ proxy + JWT/API key │───►│ local engine + tmpl │
              │ rate-limit + metrics│    │ + SynapseLDS blocks │
              └────────────┬────────┘    └───┬─────────────┬───┘
                           │                 │             │
                           │          ┌──────▼─────┐  ┌────▼──────┐
                           │          │ AI svc     │  │ LDS svc   │
                           │          │ (:4003)    │  │ (:4004)   │
                           │          │ testing    │  │ NGSI-LD   │
                           │          │ assistant  │  │ exports   │
                           │          └──────┬─────┘  └────┬──────┘
                           │                 │ LLM         │ licensed
                           │                 │ (OpenRouter)│ JSON-LD
                    ┌───────▼───────┐      ┌──▼─────────┐ ┌─▼──────────┐
                    │ Postgres/Redis│      │  Postgres  │ │  Postgres  │
                    │ S3Mock (S3)   │      │ workflows+ │ │ lds_*      │
                    └───────────────┘      │ executions │ │ tables     │
                                           └────────────┘ └────────────┘
```

Data services (same gateway, same tenant model):

```
 Gateway ──┬──▶ Base      :4005  documents + object↔data mapping ──▶ Postgres
           ├──▶ Faststore :4006  cache / KV / data structures    ──▶ Redis
           └──▶ Queue     :4007  at-least-once messaging         ──▶ Redis
```

## Tier 1 = PaaS

- **API Gateway**: the single entry point — authentication (JWT/API key), stripping +
  re-stamping `x-synapsedx-*` headers from the verified principal (anti-spoofing),
  rate limiting (Redis when `REDIS_URL` is set, fail-open), routing via `routes.yaml`,
  Prometheus metrics.
- **Access Management (IAM)**: the AWS model — Organization (like AWS Organizations),
  Account (like AWS Accounts), User/Role/JSON Policy (like IAM policies),
  `POST /v1/authorize` evaluates Allow/Deny. Authentik/Keycloak are only federated
  IdPs over OIDC (real Authorization Code flow with JWKS-verified ID tokens); IAM keeps
  the shadow user plus all authorization data.
- **Tokens**: short-lived JWT (Bearer), rotating opaque refresh tokens, long-lived
  `synapsedx_...` API keys (hash + prefix), service accounts for workloads.
- **Core data cluster**: Postgres 16 (source of truth), Redis (cache/rate-limit/session,
  and the Faststore/Queue backends), S3Mock (S3-compatible object storage, bucket
  `synapsedx-core`; swap to MinIO/real S3 in production via `S3_ENDPOINT`).
- **Workflow**: local built-in engine (Apache-2.0, no external dependency); `workflow-service` owns
  workflows + executions in Postgres: DAG runner (webhook/cron/manual/http/code/set/if/noOp),
  sandboxed code, public webhooks, cron scheduler, definition editor.
  Known residual: workflows live in a global namespace — any authenticated
  principal can manage any workflow; the legacy `workflows` registry table
  exists for future account binding, currently unused.
- **AI assistant**: `ai-service` answers testing questions on the Console API Docs
  (decision model picks the endpoint, LLM fills the try-it form; key server-side only,
  per-principal rate limit). Guidance-only — not a public API, not in the catalog.
- **Linked data (SynapseLDS)**: `lds-service` publishes licensed open data as NGSI-LD.
  Records land split into `_core` (private: tenant, internal id, source id, actor,
  version) + `entity` (`id`/`type`) + `attributes`; the export projector is a
  **structural allowlist** that never reads `_core`, so platform metadata cannot leak —
  even as the schema evolves. The attribute registry is default-deny (unregistered
  fields are stored but never exported) with per-field `public|restricted|internal`
  visibility resolved at read time, reserved names rejected at registration and
  quarantined at ingest, and tenant binding enforced with 404s. Every export carries
  the user-picked license (`X-LDS-License` + `Link rel="license"`). Workflows publish
  into it via `synapsedx.api → lds.publish-record` (`webhook-to-lds` template).
- **SynapseBase**: `base-service` is the self-managed document database — collections
  with a logical object↔data mapping, server-side validation, filters/ordering/cursors,
  optimistic concurrency (`ifVersion`/`If-Match`), atomic increments, batch writes and
  a change feed. Postgres is the source of truth; an in-memory backend keeps local
  development dependency-free. Collections are bound to an org (optionally an account)
  and resolved inside the caller's scope.
- **Synapse Faststore**: `faststore-service` exposes Redis as a tenant-scoped data
  API — strings with TTLs, atomic counters, hashes, lists, sets, sorted sets, scans,
  bulk operations and token-owned distributed locks. One Redis deployment can back it
  alongside the queue; keys are namespaced `synapsedx:faststore:v1:<tenant>:`.
- **SynapseQueue**: `queue-service` provides at-least-once messaging — delayed and
  deduplicated publishing, visibility-timeout leases with receipts, ack/nack/heartbeat,
  retry budgets, dead letters and replay. Redis sorted sets + Lua make consume/ack/nack
  atomic; an in-memory backend is used for dev/tests. Delivery is at-least-once by
  design, so consumers are expected to be idempotent.

## Technical decisions

- Node 20 + TypeScript for all services for easy contributions; `pg` driver, no ORM,
  so the SQL stays transparent.
- Gateway uses `http-proxy-middleware`: light auth at the edge + deep verification at
  IAM (`/v1/auth/verify`).
- All secrets via env; nothing hardcoded. Full compose healthchecks.
- Thin SDKs: fetch/requests/net-http, no heavy dependencies.
