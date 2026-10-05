# Roadmap

## v0.1 (this release — Tier-1 PaaS MVP) ✅
- [x] API Gateway (proxy, JWT/API-key, rate-limit, Prometheus)
- [x] IAM extras: service accounts, API keys, refresh rotation, `POST /v1/authorize` + dry-run simulator
- [x] Token: JWT + refresh + API key + OIDC config for Authentik/Keycloak
- [x] Core data: Postgres + Redis + S3 (S3Mock) via compose
- [x] Workflow: n8n proxied control-plane + 3 templates
- [x] SDKs: JS/TS + Python + Go (minimal) under Apache-2.0
- [x] Dockerfiles, compose, K8s base, CI, docs

## v0.2 (next)
- [ ] OIDC full code exchange via `openid-client` + JWKS verification at gateway
- [ ] Enforce API-key scopes at gateway (central) + audit retention job
- [ ] License check in CI (forbid GPL in dependency tree) + SBOM release artifact
- [ ] S3Bucket abstraction API (presigned URLs, đổi backend MinIO/S3 thật qua env)
- [ ] n8n credential auto-provisioning + execution webhooks → OLP events
- [ ] e2e with real Postgres (testcontainers) + load test gateway
- [ ] Helm chart + production hardening guide

## v0.3+
- Tier-2 ideas (out of scope for PaaS core): function runtime, managed DB provisioning, marketplace.
