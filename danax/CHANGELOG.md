# Changelog

All notable changes to this project will be documented in this file.
Format based on Keep a Changelog; versioning follows SemVer.

## [0.2.0] - 2026-10-06
### Added
- Console: AWS-style management UI (React 18 + Vite + Tailwind, BWD look:
  Poppins, gradient `#4FACFE→#00F2FE`, sidebar + FontAwesome) — Dashboard (ready),
  Organizations/Accounts/Users/Roles/Policies (JSON editor)/API Keys/Service
  Accounts/Workflows/Authorize simulator/Audit Log; login email+org hoặc API key;
  runtime backend URL qua `config.js` (`SYNAPSEDX_PUBLIC_BASE_URL`); compose service
  `:3000`, K8s Deployment/Service, Nginx SPA image `synapsedx/console`.
- CLI `synapsedx` zero-dependency (Node 18+): login/use-key/logout, orgs/accounts/users,
  roles/policies/attach/assign, authz/sim (kèm `--context`), audit, keys
  create/revoke, sa create/token, workflows/templates, config; `--json` cho script;
  config `~/.synapsedx/config.json`; unit tests offline (exit-code chuẩn).
- K8s: console Deployment/Service; release workflow publish thêm `synapsedx-console`.
- Console (tiếp): trang chủ giới thiệu `/welcome`, API Docs tương tác
  (try-it mọi endpoint), Docs Console/SDK trong app.
### Changed (BREAKING)
- Đổi tên dự án OLP → synapsedx: packages `@synapsedx/*`, `synapsedx-sdk` (PyPI),
  `synapsedx-sdk-go`, CLI `synapsedx`, images `synapsedx/*`, K8s namespace `synapsedx`,
  key prefix `synapsedx_*`, OIDC `synapsedx-platform`, domain `synapsedx.local`.

## [0.1.0] - 2026-10-06
### Added
- Tier-1 PaaS MVP: gateway, IAM (AWS-style org/account/role/policy + tokens + OIDC config), core data (Postgres/Redis/S3), workflow-service over n8n (proxied control-plane + versioned templates + activate/execute, trigger→execution verified on real n8n).
- IAM extras: service accounts, API keys, refresh rotation + logout, `POST /v1/authorize` + dry-run simulator, list endpoints (users/roles/policies/SA).
- Gateway: root-mounted proxies with v3 `pathFilter` (no Express strip bugs), JWT/API-key auth, principal `x-synapsedx-*` propagation, `x-request-id` tracing, rate-limit (Redis-backed w/ fail-open, memory fallback), `/ready` aggregate, longest-prefix routing + unit tests.
- SDKs: `@synapsedx/sdk` (JS/TS), `synapsedx-sdk` (Python), `synapsedx-sdk-go` (minimal).
- Docker Compose topology (parametrized host ports, S3Mock + bucket init, Authentik on 19000/19443), service Dockerfiles + .dockerignore, K8s base manifests + secrets example, GitHub CI/release workflows.
- Docs: architecture, IAM model, API reference, quickstart (incl. scripted n8n bootstrap), object-storage, troubleshooting; OSS files: LICENSE (Apache-2.0), NOTICE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE.
- Tests: 50 node + 3 Python + Go unit green; live-verified: gateway proxy, IAM on memory + Postgres, n8n workflow create/list, S3 bucket ops, Authentik boot, JS/Python/Go SDKs, CLI full sweep, rate-limiting.

### Notes
- Default object store is Adobe S3Mock (Docker Hub `minio/minio` repo was removed); production may use MinIO (quay.io) or AWS S3 via `S3_ENDPOINT`.
- Known transitive advisory `braces` via `micromatch` (gateway) — accepted, see SECURITY.md.
