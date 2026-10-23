# SynapseDX — Development Playbook

How to build, test, change, and ship this repo without breaking its invariants.
Architecture: `docs/agents/architecture.md`. Service map:
`docs/agents/services.md`.

## 1. Prerequisites

- Node 20 + npm (workspaces, `tsc`, `node --test`).
- Python 3.11 + pip (Python SDK + inference service; CI uses Ruff and pytest).
- Go 1.22 (Go SDK; CI runs `go vet` + `go test`).
- Docker + Compose (Postgres/Redis/S3 + e2e).
- Optional: `jq` for e2e scripts, `make` (Windows users call the underlying
  commands directly).

```bash
make bootstrap            # cp .env.example .env + npm install --workspaces
# replace every *_change_me_* secret in .env before exposing anything
```

## 2. Dev loop

```bash
# Infra only (or full stack)
docker compose up -d postgres redis s3 s3-init
npm run dev --workspace=apps/iam-service        # :4001
npm run dev --workspace=apps/workflow-service   # :4002
npm run dev --workspace=apps/gateway            # :8080
npm run dev --workspace=apps/base-service       # :4005
npm run dev --workspace=apps/faststore-service  # :4006
npm run dev --workspace=apps/queue-service      # :4007
npm run dev --workspace=apps/lds-service        # :4004
npm run dev --workspace=apps/ai-service         # :4003
cd apps/inference-service && uvicorn src.main:app --port 4008 --reload
cd apps/console && npm run dev                  # :3000, /api proxy → :8080
```

- Services bind host ports directly in dev; `SYNAPSEDX_INTERNAL_SECRET` is
  usually empty, so direct calls are allowed and IAM verifies credentials
  instead of trusting stamped headers. Set the same secret on gateway + every
  service (and `NODE_ENV=production`) to exercise the real trust path.
- With the secret set, direct calls to service `/v1/*` need
  `x-synapsedx-internal: <secret>`. IAM additionally requires the original
  Bearer/API key on resource routes; only `/v1/auth/*`, `/health`,
  `/v1/keys/verify` (internal-only) and `/v1/usage/ingest` are special.
- Gateway routes come from `apps/gateway/routes.yaml` relative to the process
  cwd, or `GATEWAY_ROUTES_PATH`. Restart the gateway after editing routes.

## 3. Build and test

```bash
make build     # all workspaces; required before node --test
make test      # npm run test --workspaces (compiled dist/*.test.js)
make lint      # currently mostly no-op; do not rely on it
make license-check
```

- **Build before test.** Each service's `test` script is
  `node --test dist/*.test.js`; `make test` alone fails on a clean checkout.
- Unit suites use in-memory backends. They do not exercise Postgres SQL,
  migrations, Redis Lua, or header trust in production mode.
- To exercise real backends and the full gateway path:

```bash
make compose-up
SYNAPSEDX_BASE_URL=http://localhost:8080 bash tests/e2e/api-check.sh
SYNAPSEDX_BASE_URL=http://localhost:8080 node tests/e2e/services-check.js
SYNAPSEDX_BASE_URL=http://localhost:8080 node tests/e2e/sdk-check.js
SYNAPSEDX_BASE_URL=http://localhost:8080 python tests/e2e/sdk-check.py
SYNAPSEDX_BASE_URL=http://localhost:8080 node tests/e2e/inference-check.js
```

- E2E creates fixed slugs (`e2e`, `sdkacc`, `pyfull`, `ci-workflow`); reset the
  DB (`docker compose down -v`) before rerunning.
- Python SDK: `pytest sdks/sdk-python -q`; inference:
  `npm run test:inference` (or `pytest apps/inference-service/tests`).
- Go SDK: `go vet ./... && go test ./...` in `sdks/sdk-go`.
- CI also runs `node tools/catalog-check.mjs`, which asserts the Console
  endpoint list, AI catalog, and `docs/api.md` stay in sync. Update all three
  when adding a public endpoint.

## 4. Database schema and migrations

Each Postgres-backed service owns its schema and journal:

| Service | Schema | Journal | Advisory lock key |
|---|---|---|---|
| IAM | `apps/iam-service/src/schema.ts` | `__drizzle_migrations_iam` | `synapsedx_iam_migrations` |
| Workflow | `apps/workflow-service/src/schema.ts` | `__drizzle_migrations_workflow` | `synapsedx_workflow_migrations` |
| LDS | `apps/lds-service/src/schema.ts` | `__drizzle_migrations_lds` | `synapsedx_lds_migrations` |
| Base | `apps/base-service/src/schema.ts` | `__drizzle_migrations_base` | `synapsedx_base_migrations` |

Workflow:

1. Edit `src/schema.ts` (tables/indexes are the source of truth).
2. Generate with Node 20:
   `npm run db:generate --workspace=apps/<service>`.
3. Review the SQL in `apps/<service>/drizzle/`; keep it safe for fresh *and*
   existing databases (`IF NOT EXISTS`, conditional constraints).
4. Commit the SQL + `drizzle/meta` journal/snapshot.
5. Never edit an applied migration; add a new one.

`infra/postgres/init.sql` only installs extensions (`pgcrypto`, `vector`, …)
and creates the `drizzle` schema. Tables and the demo `acme` seed are created
by service migrations/startup; do not put business tables in `init.sql`.

## 5. Change checklists

### Add or change an HTTP endpoint

1. Implement in the owning service with principal/tenant checks and input caps.
2. Add a unit test next to the service (`*.test.ts`, compiled before running).
3. Add/confirm the gateway route prefix in `apps/gateway/routes.yaml`
   (`auth`, optional `timeoutMs`). Without it: gateway 404.
4. Update SDKs (`sdks/sdk-js`, `sdk-python`, `sdk-go`) and `tools/cli` if
   user-facing.
5. Update `docs/api.md` and the relevant service doc.
6. Update `apps/console/src/lib/endpoints.js` and/or
   `apps/ai-service/src/catalog.ts`; then `node tools/catalog-check.mjs`.
7. Run build + service tests; run e2e for auth/tenancy-sensitive changes.

### Add a service

1. Copy the Express service pattern: `package.json` with `build/dev/start/test`,
   `tsconfig.json`, `src/index.ts` exporting `createApp()`, `Dockerfile`
   (Node 20 alpine, non-root), optional Drizzle schema/journal.
2. Add it to the root workspaces automatically via `apps/*`.
3. Add Compose service + healthcheck + network; add `*_SERVICE_URL` to gateway.
4. Add `routes.yaml` rules with explicit auth modes.
5. Wire internal-secret checks, tenant resolution, security headers, `/health`,
   `/metrics` where appropriate.
6. Add SDK namespaces + CLI + Console page + docs + AI catalog entry.
7. Add CI coverage (build/test, compose if stateful, e2e if critical).

### Touch auth, tenancy, or gateway headers

- Re-read `docs/agents/architecture.md` §3–§4 and the IAM scoping tests
  (`apps/iam-service/src/scoping.test.ts`).
- Preserve: header stripping/re-stamping, `x-synapsedx-anon`, internal-secret
  timing-safe check, `TRUST_STAMPED` only with the secret, 404 for cross-tenant
  existence leaks, 403 for known-resource denials.
- Run `apps/iam-service` and `apps/gateway` tests plus the Compose e2e suite.
- Do not add API-key scope enforcement piecemeal; it is a cross-cutting roadmap
  item.

### Add a workflow node or integration

- Engine aliases live in `apps/workflow-service/src/engine.ts`; keep existing
  n8n names working.
- Validate required params in both `validateDefinition` and execution paths.
- Route service calls through the gateway/base URLs with the run principal
  headers, or the internal secret for platform calls.
- Add engine tests; templates in `src/index.ts` are trusted built-ins (no
  definition validation) but still need correct wiring.
- Update the Console node palette (`WorkflowEditor.jsx` / `workflow-graph.js`)
  if the node is user-visible.

### Change the Console

- Plain JSX, React Router, no TypeScript. `src/lib/api.js` is the only HTTP
  layer; use `authStore` for token/refresh handling.
- Runtime API base URL: `public/config.js` (`window.SYNAPSEDX_CONFIG.BASE_URL`)
  in production; `VITE_SYNAPSEDX_BASE_URL` in dev; default
  `http://localhost:8080`.
- Tests: `npm run test --workspace=apps/console` (node:test + SSR smoke).

## 6. Conventions

- **Language/framework:** Node 20 + TypeScript + Express; keep services
  dependency-light. `pg` for queries; Drizzle for schema/migrations only.
- **App shape:** export `createApp()` for tests; listen only under
  `if (require.main === module)`; handle SIGTERM/SIGINT gracefully where
  applicable.
- **Errors:** JSON `{ "error": "code", "message": "human text" }`; use 400 for
  validation, 401 unauthenticated, 403 known-resource denial, 404 missing or
  cross-tenant, 409 conflict/version, 413 size, 429 rate limit, 502 upstream,
  503 dependency unavailable.
- **Validation:** clamp env numbers; cap body sizes, array lengths, string
  lengths, nesting depth; reject `__proto__`/`constructor`/`prototype`.
- **Secrets:** env only. Compare with `crypto.timingSafeEqual`; hash tokens/API
  keys at rest; never log authorization/API-key/password/secret headers.
- **Headers:** do not trust inbound `x-synapsedx-*`; only the gateway stamps
  them. `x-request-id` is sanitized.
- **Copyright:** new source files start with the Apache-2.0 header used across
  the repo (`Copyright 2026 SynapseDX Contributors`).
- **Comments:** existing code mixes Vietnamese and English; match the file.
  Public docs and these agent notes are English.
- **Commits:** Conventional Commits (`feat(iam): …`, `fix(gateway): …`,
  `docs: …`, `chore: …`). Keep PRs scoped; behavior changes need tests.
- **Dependencies:** permissive licenses only (MIT/ISC/Apache-2.0/BSD). CI fails
  on GPL/AGPL/LGPL; update `sbom.json` via `node tools/license-check.cjs --sbom
  sbom.json` when dependencies change.

## 7. CI and release

`.github/workflows/ci.yml` (all branches except `main`, plus PRs and reusable
gate):
- build/test all workspaces, catalog drift check, `npm audit` (critical only),
  license gate + SBOM, Go vet/test, Python pytest + Ruff + pip-licenses,
  `docker compose config`;
- Docker build job;
- Compose e2e: core stack, `/ready`, auth smoke, `api-check.sh`, Python/JS SDK
  checks, services check, workflow showcase.

`.github/workflows/cd.yml` gates `main` and publishes dev channel;
`release.yml` publishes npm SDK/CLI, PyPI SDK, Go tag/release artifacts.
Version bumps touch every `package.json`, Compose image tags, SDK versions, and
`CHANGELOG.md`.

## 8. Debugging pointers

| Symptom | Check |
|---|---|
| Gateway 404 | route missing/typo in `routes.yaml`; restart gateway |
| 401 on internal call | missing/wrong `x-synapsedx-internal`; secret mismatch |
| 403 cross-tenant | expected; verify stamped org/account and service scope |
| 409 on Base write | `ifVersion`/`If-Match` stale; re-read then retry |
| 413 Base query | `BASE_QUERY_SCAN_LIMIT` exceeded; narrow filter/index |
| Workflow webhook 401 | per-workflow auth mode/header/credential |
| Workflow 500 on code node | sandbox timeout/permission error; check execution node run |
| Queue duplicates | at-least-once; add dedupe key / idempotent handler |
| Redis errors but service runs | memory fallback active (dev); production boot should fail |
| Console blank/config | `public/config.js` base URL / nginx entrypoint substitution |

More human-facing fixes: `docs/troubleshooting.md`, `docs/production.md`,
`docs/monitoring.md`, `infra/k8s/README.md`.
