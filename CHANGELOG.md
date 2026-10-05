# Changelog

All notable changes to this project will be documented in this file.
Format based on Keep a Changelog; versioning follows SemVer.

## [0.1.0] - 2026-10-06
### Added
- Tier-1 PaaS MVP: gateway, IAM (AWS-style org/account/role/policy + tokens + OIDC config), core data (Postgres/Redis/S3), workflow-service over n8n + templates.
- IAM extras: service accounts (`/v1/service-accounts/:id/token`, JWT `kind=service-account`), API keys, refresh rotation, `POST /v1/authorize` (Deny-wins evaluation).
- Gateway: root-mounted proxies with v3 `pathFilter` (no Express strip bugs), JWT/API-key auth, rate-limit, Prometheus `/metrics`, longest-prefix routing + unit tests.
- SDKs: `@olp/sdk` (JS/TS), `olp-sdk` (Python), `olp-sdk-go` (minimal).
- Docker Compose topology (parametrized host ports, S3Mock + bucket init, Authentik on 19000/19443), service Dockerfiles + .dockerignore, K8s base manifests + secrets example, GitHub CI/release workflows.
- Docs: architecture, IAM model, API reference, quickstart (incl. scripted n8n bootstrap), object-storage, troubleshooting; OSS files: LICENSE (Apache-2.0), NOTICE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, GOVERNANCE.
- Tests: 21/21 unit green; live-verified: gateway proxy, IAM on memory + Postgres, n8n workflow create/list, S3 bucket ops, Authentik boot, JS/Python SDKs, rate-limiting.

### Notes
- Default object store is Adobe S3Mock (Docker Hub `minio/minio` repo was removed); production may use MinIO (quay.io) or AWS S3 via `S3_ENDPOINT`.
- Known transitive advisory `braces` via `micromatch` (gateway) — accepted, see SECURITY.md.
