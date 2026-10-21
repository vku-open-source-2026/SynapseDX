# Troubleshooting

## 502 from nginx right after recreating `console`/`gateway`

nginx resolves `upstream` hostnames once at (re)load and caches the container IP.
Recreating a container changes its IP → `connect() failed (111: Connection refused)`
in `docker logs synapsedx-nginx-1`. Fix without downtime:

```bash
docker exec synapsedx-nginx-1 nginx -s reload
```

Rule of thumb for prod: always deploy with both files
(`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build …`)
and reload nginx afterwards whenever `console` or `gateway` was recreated.

## Chatbot answers 502 `llm_error` / `endpoint_not_found`

- `LLM returned no content` / `did not return valid JSON`: free-tier reasoning
  models intermittently return empty/truncated replies — the service retries
  `AI_RETRIES` times (default 2) then tries a different-provider fallback model
  (`AI_LLM_FALLBACK_MODEL`); persistent failures mean the providers are having a
  bad spell, try alternative models.
- `User not found` 401 from OpenRouter: the key is a provisioning key — use a normal
  API key for `AI_API_KEY`.
- `endpoint_not_found` for how-to questions is by design: the agent answers with
  `guidance` text instead of a try-it form (no single endpoint fits).

## Blank white page after navigating in the Console

A render error used to unmount the whole app. Current builds wrap all routes in an
`ErrorBoundary`: you get a recovery card (Reload / Dashboard) plus a `[console]
render failed` log line with the component stack — paste both when reporting.

## Port already in use (EADDRINUSE / Bind for ... failed)

Dev machines often already run something (e.g. a web server on `:8080`, Postgres on
`:5432`). SynapseDX never hardcodes host ports — change them via env in `.env`:

| Env | Default | Service |
|---|---|---|
| `GATEWAY_HOST_PORT` | 8080 | gateway |
| `IAM_HOST_PORT` | 4001 | iam |
| `WORKFLOW_HOST_PORT` | 4002 | workflow |
| `AUTHENTIK_HTTP_PORT` / `AUTHENTIK_HTTPS_PORT` | 19000 / 19443 | authentik |

```bash
GATEWAY_HOST_PORT=18080 docker compose up --build -d
```

**In-container** ports (4001/4002/8080/...) stay fixed — services call each other by
docker service name (`http://iam:4001`), never via host ports.

## Windows: curl.exe with single-quoted JSON

Windows `curl.exe` doesn't understand bash single quotes. Wrong:
`curl -d '{"email":"a@a"}'` → sends the literal `'` → IAM reports
`SyntaxError ... position 1`.
Right (PowerShell): use `Invoke-RestMethod`, or escape the double quotes:
`curl.exe -d "{\"email\":\"a@a\"}"`. See `examples/quickstart/demo.ps1` and `tests/e2e/smoke.ps1`.

## Gateway returns 404 `No gateway route matched` for a declared route

Check the prefix exists in `apps/gateway/routes.yaml` (gateway matches longest-prefix,
see `docs/api.md`).
If you hack on the gateway: **don't** `app.use(path, proxy)` + reassign `req.url` —
Express keeps `slashAdded/removed` bookkeeping and hand-assigning produces garbage URLs
for exact paths. Use http-proxy-middleware v3 `pathFilter` + mount at root (see
`apps/gateway/src/index.ts`).

## IAM reports `db=memory` but you want Postgres

`DATABASE_URL` never reached the container. In compose, `DATABASE_URL` points at
`postgres:5432` (service name). When running IAM outside docker (local dev), set:
`DATABASE_URL=postgres://synapsedx:<pw>@localhost:<HOST_PORT>/synapsedx`.

## Authentik won't start

`authentik-postgres-init` must finish first (creates the `authentik` user/db). Check:
`docker compose logs authentik-postgres-init authentik-server`. On first boot the
bootstrap admin password is in the `authentik-server` log. A recurring cause is a
password mismatch: the init container creates/updates the DB user from
`AUTHENTIK_POSTGRESQL__PASSWORD`, so all three places (init, server, worker) must read
the same `.env` value, then restart the server/worker.

## Backup / restore Postgres (core data cluster)

```bash
docker compose exec postgres pg_dump -U synapsedx synapsedx > synapsedx-$(date +%F).sql
cat synapsedx-2026-10-06.sql | docker compose exec -T postgres psql -U synapsedx -d synapsedx
```

## Workflow execute returns 500 `ok:false`

A node failed — the response `error` names the node (`Code: ...`, `httpRequest: ...`).
Fetch `GET /v1/executions/:id?includeData=true` for per-node input/output, or use
`POST /v1/workflows/test-run` to try a definition without saving.

## 401 `Missing or invalid internal credential` on direct service calls

Once `SYNAPSEDX_INTERNAL_SECRET` is configured, every service only accepts
gateway traffic (`x-synapsedx-internal` header). Call services directly with that
header, or go through gateway `:8080`. Verify every service shares the **same**
secret value.

## 401 `unauthorized` with a non-expired token

Gateway and IAM **must share** `IAM_JWT_SECRET` (K8s: both Deployments mount
`iam-jwt-secret`). A mismatch fails every Bearer verification. In `NODE_ENV=production`
services refuse to boot on weak/default secrets — read the startup log.

## 502 `bad_gateway` / 504 on workflows and executions

Upstream workflow-service is down: instant JSON 502 (plus a
`[gateway] proxy ... failed` log); past `PROXY_TIMEOUT_MS` it becomes 504. Check
`docker compose ps workflow` and the gateway `/ready`.

## 400 `invalid_body` / `invalid_slug` / `invalid_document`

Validation rules (see `docs/api.md`): RFC email ≤320 chars; slug `^[a-z0-9-]{1,64}$`;
policy document `Statement[]` 1–100, patterns ≤512 chars. Older hand-built CLI/SDK paths
may send bad slugs — use a current SDK/CLI (all ids are `encodeURIComponent`'d).

## OIDC callback errors

| Error | Meaning | Fix |
|---|---|---|
| `oidc_state_required` | `code` sent without the signed `state` | always send both from `/v1/auth/oidc/start` |
| `oidc_bad_state` / `oidc_state_expired` | tampered or >10-minute-old state | restart sign-in from `/login` |
| `oidc_discovery_failed` / `oidc_unreachable` | IAM can't reach `OIDC_ISSUER` | check the issuer URL **from inside** the docker network (`authentik-server:9000`, not `localhost`) |
| `oidc_issuer_mismatch` | discovery doc issuer ≠ configured issuer | trailing-slash/realm typo in `OIDC_ISSUER` |
| `oidc_no_email` | IdP released no email claim | add `email` to the client scope/mapping |
| `oidc_not_configured` | `OIDC_CLIENT_SECRET` empty | fill it in `.env`, restart `iam` |
