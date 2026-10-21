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
- [ ] Optional: pin federation with `OIDC_ALLOWED_ORGS` (comma-separated slugs).
      Without it a new slug is self-service; joining an **existing** org always
      requires a membership (invited via `POST /v1/orgs/:orgId/users`).
- [ ] K8s secrets via SealedSecrets/External Secrets — **never** commit filled-in files
      (see `infra/k8s/base/secrets.example.yaml`).

## 2. Network & TLS

- [ ] Gateway is the single entry point (Ingress + TLS); IAM/workflow/LDS/base/
      faststore/queue/postgres/redis are not internet-exposed (ClusterIP / internal
      compose network).
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
- [ ] Database schema is managed by Drizzle migrations in `apps/*/drizzle/`.
      Services apply their own migrations at startup under a per-service
      advisory lock and migration journal (`drizzle.__drizzle_migrations_*`).
      `infra/postgres/init.sql` is bootstrap-only (extensions + the migration
      journal schema); table/index DDL and the demo seed live in migrations.
      Back up the database before the
      first deploy of a schema-changing release, and review generated SQL.
- [ ] Migration journals are service-specific because all services share one
      database. Do not point multiple services at the same journal, and do not
      edit migrations that have already been applied.
- [ ] The service DB role can create/alter tables, indexes and the `drizzle`
      schema (startup migrations need DDL rights), or migrations are pre-applied
      once with a privileged role before the service rollout.

## 4. Operations

- [ ] `restart: unless-stopped` is already set for every long-lived compose service;
      K8s has liveness/readiness (see `infra/k8s/base/all.yaml`). Alert when `/ready` → 503.
- [ ] Pin image digests for releases (`synapsedx/*:0.1.0` → digest), never `latest` for external engines.
- [ ] Centralized logs (default json-file driver; move to Loki/ELK when needed) + keep `x-request-id`.
- [ ] `audit_log` Postgres retention under heavy authorize traffic: set
      `AUDIT_RETENTION_DAYS` (e.g. `180`) — the IAM service purges hourly by
      itself (see `docs/configuration.md`). External cron `DELETE` only needed
      for custom windows.
- [ ] Monitoring: confirm Prometheus scrapes gateway/PG/Redis (`/targets` all up)
      and the `GatewayDown`/`PostgresDown`/`RedisDown` alerts are visible
      (see `docs/monitoring.md`). The Prometheus port stays internal in prod
      (port-forward only).
- [ ] Periodic `npm audit`; track advisories recorded in `SECURITY.md`.

## 5. Upgrades

- [ ] Read `CHANGELOG.md` + `ROADMAP.md` before moving to a new tag; run
      `tests/e2e/api-check.sh` after every upgrade.
