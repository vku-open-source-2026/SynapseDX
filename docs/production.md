# Production checklist (Tier-1 PaaS)

Use when taking SynapseDX off your laptop. Every item already has a mechanism — just switch it on.

## 1. Secrets & auth

- [ ] Replace **every** `*_change_me_*` in `.env` (`IAM_JWT_SECRET` ≥ 32 random chars,
      identical on gateway + IAM; production boot fails on defaults).
- [ ] Same `SYNAPSEDX_INTERNAL_SECRET` on gateway + iam + workflow, then remove the
      `ports:` of IAM/workflow from host/internet (gateway only is public).
- [ ] `IAM_ALLOW_DEV_LOGIN=false` (SSO + API keys only).
- [ ] `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` (the demo callback accepts any caller-supplied email).
- [ ] Random `IAM_API_KEY_PEPPER` (HMAC for at-rest key hashes).
- [ ] `GATEWAY_VERIFY_APIKEY=true` when clients use API keys (centralized verification, fail-closed).
- [ ] Authentik/Keycloak behind TLS; `OIDC_ISSUER` uses the correct internal https URL.
- [ ] Point `OIDC_REDIRECT_URI` at the Console `/oidc/callback` page so the real
      Authorization Code flow completes in the browser.
- [ ] K8s secrets via SealedSecrets/External Secrets — **never** commit filled-in files
      (see `infra/k8s/base/secrets.example.yaml`).

## 2. Network & TLS

- [ ] Gateway is the single entry point (Ingress + TLS); IAM/workflow/n8n/postgres/redis
      are not internet-exposed (ClusterIP / internal compose network).
- [ ] Lock down the gateway CORS to the real frontend origins (MVP default is wide open).
- [ ] Rate limiting at the outer layer (Ingress NGINX `limit_req`, Cloudflare/AWS WAF):
      the gateway's built-in limiter was removed — outer rate limiting is mandatory, especially
      `/v1/auth/*` (brute-force login/refresh). Never expose IAM/workflow directly.
- [ ] `PROXY_TIMEOUT_MS` per upstream SLA (default 30s).
- [ ] `HSTS_ENABLED=true` once TLS exists; `CORS_ORIGIN` set to the real frontend origins.

## 3. Data

- [ ] Postgres: durable volume + periodic backups (`pg_dump`, see `docs/troubleshooting.md`).
- [ ] Object storage: S3Mock → MinIO/real S3 (`docs/object-storage.md`).
- [ ] Redis AOF already on in compose; on K8s use a redis chart with persistence.
- [ ] Pre-existing DB: `init.sql` only runs on first init — manually apply new
      `CREATE INDEX IF NOT EXISTS idx_*` from `infra/postgres/init.sql`
      (idempotent, safe to re-run) so list/DELETE CASCADE paths don't seq-scan.

## 4. Operations

- [ ] `restart: unless-stopped` is already set for every long-lived compose service;
      K8s has liveness/readiness (see `infra/k8s/base/all.yaml`). Alert when `/ready` → 503.
- [ ] Pin image digests for releases (`synapsedx/*:0.1.0` → digest), never `latest` for external engines.
- [ ] Centralized logs (default json-file driver; move to Loki/ELK when needed) + keep `x-request-id`.
- [ ] `audit_log` Postgres retention (cron `DELETE ... WHERE created_at < now() - interval`)
      under heavy authorize traffic.
- [ ] Monitoring: confirm Prometheus scrapes gateway/PG/Redis (`/targets` all up)
      and the `GatewayDown`/`PostgresDown`/`RedisDown` alerts are visible
      (see `docs/monitoring.md`). The Prometheus port stays internal in prod
      (port-forward only).
- [ ] Periodic `npm audit`; track advisories recorded in `SECURITY.md`.

## 5. Upgrades

- [ ] Read `CHANGELOG.md` + `ROADMAP.md` before moving to a new tag; run
      `tests/e2e/api-check.sh` after every upgrade.
