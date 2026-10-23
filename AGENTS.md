# AGENTS.md — SynapseDX

Agent memory for this repo. Load only the note you need; the deep notes are split
by concern to keep context small.

## What this is

SynapseDX v0.6.0 — Apache-2.0 "Tier-1 PaaS": one API gateway, AWS-style IAM,
Postgres/Redis data plane (S3 is provisioned but not exposed yet), built-in
workflow engine, NGSI-LD linked data (SynapseLDS), document DB (SynapseBase),
Redis cache (Synapse Faststore), and at-least-once queue (SynapseQueue).
Clients: React Console, TypeScript/Python/Go SDKs, zero-dependency CLI.
Authentik/Keycloak are optional external OIDC IdPs.

## Reading map (do not read the whole repo/docs)

| Need | Read |
|---|---|
| System design, auth, tenancy, data flow, known gaps | `docs/agents/architecture.md` |
| Service endpoints, files, env vars, invariants | `docs/agents/services.md` |
| Build/test, migrations, change checklists, CI/conventions | `docs/agents/development.md` |
| Human documentation index | `docs/README.md` |
| Full API reference | `docs/api.md` |

Skip: `node_modules/`, `apps/*/dist/`, `.pytest_cache/`, `.ruff_cache/`,
`apps/tunnel-service/dist/` (stale build output, no source), and `.notes/`
(local credentials — never print, copy, or commit).

## Stack

- Node 20 + TypeScript + Express for all platform services. `pg` for SQL; Drizzle
  is used only for schema definitions and migrations. Platform-service tests run
  as `node --test` on compiled JS.
- React 18 + Vite + Tailwind Console (plain JSX, not TypeScript).
- Python 3.11 FastAPI inference service (local embeddings/decision model +
  OpenRouter-compatible LLM proxy).
- Postgres 16 (pgvector image), Redis 7, S3Mock (S3-compatible) in Compose.
- Every stateful service has an in-memory fallback for dev/tests; production
  boot fails if the real backend or internal secret is missing.

## Services and ports

| Path | Service | Port | Backend |
|---|---|---|---|
| `apps/gateway` | API gateway / single entry point | 8080 | proxies upstreams |
| `apps/iam-service` | Org/Account/User/Role/Policy, tokens, OIDC, audit, usage | 4001 | Postgres / memory |
| `apps/workflow-service` | DAG engine, templates, triggers, executions, credentials | 4002 | Postgres / memory |
| `apps/ai-service` | Console API-docs assistant (guidance-only) | 4003 | OpenRouter |
| `apps/lds-service` | SynapseLDS NGSI-LD datasources + licensed exports | 4004 | Postgres / memory |
| `apps/base-service` | SynapseBase document DB + mapping + vector search | 4005 | Postgres / memory |
| `apps/faststore-service` | Synapse Faststore cache/KV/data structures/locks | 4006 | Redis / memory |
| `apps/queue-service` | SynapseQueue messaging, leases, retries, DLQ | 4007 | Redis / memory |
| `apps/inference-service` | Python FastAPI LLM proxy + embeddings + decision | 4008 | local models / OpenRouter |
| `apps/console` | Admin UI | 3000 (nginx :80) | calls gateway |
| `sdks/sdk-js`, `sdks/sdk-python`, `sdks/sdk-go` | Client SDKs | — | — |
| `tools/cli` | `synapsedx` CLI (zero deps, Node 18+) | — | — |

Infra: Postgres 5432, Redis 6379, S3 9090, Prometheus 9091. In production only
the gateway (and TLS edge) is public; service ports stay internal.

## Request path

```
Console / CLI / SDK
        │ Bearer JWT or X-API-Key
        ▼
Gateway :8080 ── route match from apps/gateway/routes.yaml
        │ verify JWT locally (IAM_JWT_SECRET) or API key via IAM
        │ strip client x-synapsedx-* → re-stamp verified principal
        ▼
IAM / Workflow / LDS / Base / Faststore / Queue / AI / Inference
        │ derive tenant from stamped org/account/user
        ▼
Postgres · Redis · S3 (provisioned)
```

## Non-negotiable invariants

1. **Gateway is the only public API in production.** Internal services reject
   direct traffic when `SYNAPSEDX_INTERNAL_SECRET` is set (required in prod).
2. **Never trust client-supplied `x-synapsedx-*` headers.** The gateway deletes
   them and re-stamps from the verified principal. IAM only trusts stamped
   tenant headers when the internal secret is configured; otherwise it verifies
   the credential itself.
3. **Tenant scope is org-first**: `org:<id>` > `account:<id>` > `user:<sub>`.
   Cross-tenant reads return 404/403; do not leak existence.
4. **Production is fail-closed**: weak/missing JWT secret, missing internal
   secret, or missing `DATABASE_URL`/Redis for stateful services must abort boot.
5. **LDS `core` metadata (`_core` in projector comments) is never serialized.**
   The NGSI-LD projector is a structural allowlist over `entity` + registered
   `attributes` only.
6. **Queue delivery is at-least-once.** Consumers must be idempotent; use dedupe
   keys and ack/nack receipts.
7. **Do not buffer the gateway body.** No global `express.json()` in the gateway;
   it proxies raw streams.
8. **Dependencies must stay permissive** (MIT/ISC/Apache-2.0/BSD). The copyleft
   gate (`make license-check`) fails on GPL/AGPL/LGPL.
9. **New public paths need a gateway route** in `apps/gateway/routes.yaml`,
   otherwise the gateway returns 404 before the upstream sees the request.
10. **Keep versions in sync** at `0.6.0` across packages, Compose images, and SDKs.

## Commands

```bash
make bootstrap                 # copy .env.example → .env, install workspaces
make build                     # tsc/build all workspaces (needed before tests)
make test                      # node --test on compiled dist/*.test.js
make license-check             # copyleft gate + SBOM
make compose-up                # full platform (docker compose)
make compose-down
make e2e                       # smoke + API e2e (needs a clean stack)

npm run dev --workspace=apps/iam-service
npm run dev --workspace=apps/gateway
npm run test --workspace=apps/base-service
npm run db:generate --workspace=apps/base-service   # Drizzle migration
```

E2E helpers: `bash tests/e2e/api-check.sh`, `node tests/e2e/services-check.js`,
`node tests/e2e/sdk-check.js`, `python tests/e2e/sdk-check.py`,
`node tests/e2e/inference-check.js`. Set `SYNAPSEDX_BASE_URL` when not using
`http://localhost:8080`. Inference unit tests: `npm run test:inference`.

## Gotchas

- **Build before test.** Service tests execute `dist/*.test.js`; a stale/missing
  `dist` makes `make test` fail or test old code.
- **Unit tests use in-memory backends.** `DATABASE_URL` is normally unset, so
  Postgres branches are exercised only by the Compose e2e stack.
- **E2E scripts create fixed slugs** (`e2e`, `sdkacc`, `pyfull`); they are not
  rerunnable against a dirty database.
- **Workflow node types are n8n-compatible** (`n8n-nodes-base.*`) plus
  `synapsedx.*` nodes and `synapsedx.api` operations across IAM, Workflow,
  LDS, Base, Faststore, Queue and Inference. Preserve aliases when touching
  the engine.
- **Docs can lag code.** `docs/architecture.md` still calls workflows a global
  namespace and `docs/configuration.md` mentions Redis gateway rate limiting;
  the code is tenant-scoped and uses an in-memory edge limiter. Prefer source.
- **Code comments are mixed Vietnamese/English.** Match the surrounding file;
  user-facing docs and new agent notes are English.
- **Never revert unrelated working-tree changes.** This repo is often edited
  across services; keep diffs scoped.

## Where the truth lives

- Routing: `apps/gateway/routes.yaml` + `apps/gateway/src/index.ts`.
- Auth/token model: `apps/iam-service/src/{tokens,policy,oidc,index}.ts`.
- Schema/migrations: `apps/*/src/schema.ts` + `apps/*/drizzle/`.
- Service behavior: `apps/*/src/index.ts` and its `*.test.ts`.
- Deployment: `docker-compose*.yml`, `infra/prod/`, `infra/k8s/base/all.yaml`,
  `infra/monitoring/prometheus/`.
