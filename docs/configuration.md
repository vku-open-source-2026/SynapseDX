# Configuration (env reference)

Copy `.env.example` → `.env` and replace every `*_change_me_*` value. Which service
reads which key (audited from source):

## Gateway (`apps/gateway`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` (fallback `GATEWAY_PORT`) | 8080 | listen port (inside the container) |
| `IAM_SERVICE_URL` | `http://iam:4001` | IAM upstream |
| `WORKFLOW_SERVICE_URL` | `http://workflow:4002` | workflow upstream |
| `IAM_JWT_SECRET` | — | **must match** IAM, used to verify Bearer tokens |
| `GATEWAY_ROUTES_PATH` | `./routes.yaml` | routing table |
| `GATEWAY_VERIFY_APIKEY` | `false` | `true` → centralized `X-API-Key` verification via IAM (fail-closed 503 when IAM is down); `false` → edge presence check, upstream verifies |
| `PROXY_TIMEOUT_MS` | 30000 | upstream timeout (504 when exceeded) |
| `CORS_ORIGIN` | (allow all) | `a.com,b.com` → only those origins (production) |
| `SYNAPSEDX_INTERNAL_SECRET` | — (dev) | gateway → iam/workflow credential (`x-synapsedx-internal` header); **identical** on all 3 services in production |
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
| `IAM_ALLOW_DEV_LOGIN` | `true` | `false` disables `POST /v1/auth/login` in production (SSO + API keys only) |
| `IAM_ALLOW_OIDC_DEMO_CALLBACK` | `true` | demo callback trusts the caller-supplied email (impersonation possible) — production **must** be `false` (then a real IdP `code` is required) |
| `SYNAPSEDX_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapsedx-internal` header on every `/v1/*` (except `/v1/auth/*`) — blocks direct `:4001` bypass |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |
| `OIDC_PROVIDER` | `authentik` | IdP display name (`authentik`\|`keycloak`) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | see `.env.example` | federated OIDC (Authentik/Keycloak). For SPA login, point `OIDC_REDIRECT_URI` at the Console's `/oidc/callback` page (e.g. `https://cloud.example.com/oidc/callback`) |

## Workflow (`apps/workflow-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4002 | listen port |
| `N8N_BASE_URL` | `http://n8n:5678` | n8n engine |
| `N8N_API_KEY` | — | n8n API key (Settings → API) |
| `IAM_SERVICE_URL` | — | reserved for cross-verification |
| `SYNAPSEDX_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapsedx-internal` header on every `/v1/*` — blocks direct `:4002` bypass |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |

## Console (`apps/console`, runtime via `config.js`)

| Key | Default | Meaning |
|---|---|---|
| `SYNAPSEDX_PUBLIC_BASE_URL` | `http://localhost:8080` | gateway URL the **browser** calls (must be browser-reachable, not a docker hostname) |
| `CONSOLE_APP_URL` | `http://localhost:3000` | canonical app host; the landing domain redirects sign-in here in multi-domain deploys |

## Core data / external engines

Postgres (`POSTGRES_*`), n8n (`N8N_ENCRYPTION_KEY`, `N8N_HOST_PORT`, `N8N_HOST/PORT/PROTOCOL`),
Authentik (`AUTHENTIK_*`, host ports `AUTHENTIK_HTTP_PORT=19000`),
S3 (`S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY`, `S3_HOST_PORT=9090`).
