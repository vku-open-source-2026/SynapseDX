# Roadmap

## v0.1 (this release — Tier-1 PaaS MVP) ✅
- [x] API Gateway (proxy, JWT/API-key, rate-limit, Prometheus)
- [x] IAM: Organization/Account/User/Role/Policy (AWS-style) + `POST /v1/authorize`
- [x] Token: JWT + refresh + API key + OIDC config for Authentik/Keycloak
- [x] Core data: Postgres + Redis + MinIO via compose
- [x] Workflow: n8n proxied control-plane + 3 templates
- [x] SDKs: JS/TS + Python + Go (minimal) under Apache-2.0
- [x] Dockerfiles, compose, K8s base, CI, docs

## v0.2 (next)
- [ ] OIDC full code exchange via `openid-client` + JWKS verification at gateway
- [ ] Policy simulator + audit log table
- [ ] S3Bucket abstraction API (presigned URLs via MinIO)
- [ ] n8n credential auto-provisioning + execution webhooks → OLP events
- [ ] e2e with real Postgres (testcontainers) + load test gateway
- [ ] Helm chart + production hardening guide

## v0.3+
- Tier-2 ideas (out of scope for PaaS core): function runtime, managed DB provisioning, marketplace.
