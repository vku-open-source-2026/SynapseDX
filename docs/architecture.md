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
              │ rate-limit + metrics│    │                     │
              └────────────┬────────┘    └─────────┬───────────┘
                           │              ┌────────▼───────────┐
                           │              │ AI svc (:4003)     │
                           │              │ testing assistant  │
                           │              │ (LLM, server-side) │
                           │              └────────┬───────────┘
                           │                     │ REST (OpenRouter)
                    ┌───────▼───────┐      ┌──────▼──────┐
                    │ Postgres/Redis│      │  Postgres     │
                    │ S3Mock (S3)   │      │ workflows +    │
                    └───────────────┘      │ executions)      │
                                           └─────────────┘
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
- **Core data cluster**: Postgres 16 (source of truth), Redis (cache/rate-limit/session),
  S3Mock (S3-compatible object storage, bucket `synapsedx-core`; swap to MinIO/real S3
  in production via `S3_ENDPOINT`).
- **Workflow**: local built-in engine (Apache-2.0, no external dependency); `workflow-service` owns
  workflows + executions in Postgres: DAG runner (webhook/cron/manual/http/code/set/if/noOp),
  sandboxed code, public webhooks, cron scheduler, definition editor.
  Known residual: workflows live in a global namespace — any authenticated
  principal can manage any workflow; the legacy `workflows` registry table
  exists for future account binding, currently unused.
- **AI assistant**: `ai-service` answers testing questions on the Console API Docs
  (decision model picks the endpoint, LLM fills the try-it form; key server-side only,
  per-principal rate limit). Guidance-only — not a public API, not in the catalog.

## Technical decisions

- Node 20 + TypeScript for all services for easy contributions; `pg` driver, no ORM,
  so the SQL stays transparent.
- Gateway uses `http-proxy-middleware`: light auth at the edge + deep verification at
  IAM (`/v1/auth/verify`).
- All secrets via env; nothing hardcoded. Full compose healthchecks.
- Thin SDKs: fetch/requests/net-http, no heavy dependencies.
