# Roadmap

## v0.1 (this release — Tier-1 PaaS MVP) ✅
- [x] API Gateway: proxy (pathFilter, no strip bugs), JWT/API-key (+strict verify mode),
      principal `x-olp-*` propagation, `x-request-id`, rate-limit (Redis/Lua, fail-open),
      proxy timeout, CORS gating, `/ready` aggregate, Prometheus, graceful shutdown
- [x] IAM: Organization/Account/User/Role/Policy AWS-style + Conditions
      (StringEquals/StringLike/IfExists) + `POST /v1/authorize` + dry-run simulator + audit log
- [x] Token: JWT + refresh xoay vòng nguyên tử + logout/logout-all + API key
      (verify/revoke) + service account + OIDC config (Authentik/Keycloak) + dev-login kill-switch
- [x] Core data: Postgres (schema + seed) + Redis + S3 (S3Mock, bucket init) via compose
- [x] Workflow: n8n proxied control-plane + 3 versioned templates (webhookId-correct) +
      activate/deactivate/execute/get + trigger→execution verified on real n8n
- [x] SDKs: JS/TS + Python (full API parity) + Go (minimal), Apache-2.0, unit + live tested
- [x] Dockerfiles + .dockerignore, compose (parametrized ports, healthchecks, unified tags),
      K8s base (probes, secrets example), CI (build/test/docker/e2e incl. SDK smoke), 10+ docs

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
