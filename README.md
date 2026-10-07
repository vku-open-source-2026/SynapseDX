# SynapseDX — Open Layer Platform (Tier-1 PaaS, open source)

Apache-2.0 open-source PaaS core: **API Gateway + IAM (AWS-style) + core data + n8n workflows + SDKs**.

![ci](https://github.com/synapsedx/synapsedx/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![sdk-js](https://img.shields.io/badge/sdk-JS%2FTS-green)
![sdk-py](https://img.shields.io/badge/sdk-Python-green)

> **Tier 1 = PaaS**: single entry point (gateway), access management (IAM), core data cluster, workflows. No lock-in: Authentik/Keycloak and n8n run as external engines via OIDC/REST.

## Open-source compliance
- **Permissive license**: `LICENSE` Apache-2.0 for the platform and all SDKs; `NOTICE` acknowledges third-party components.
- **Public development**: monorepo, Conventional Commits, PR template, CI (`ci.yml`) + release (`release.yml`), `CHANGELOG.md`.
- **Open documentation**: `docs/` (architecture, iam-model, api, quickstart, object-storage, troubleshooting) + this `README.md`.
- **Open contributions**: `CONTRIBUTING.md` (DCO sign-off), `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, `ROADMAP.md`.
- **Reproducible builds**: per-service `Dockerfile`, pinned images in `docker-compose.yml`, Kustomize in `infra/k8s`, `.env.example`.
- **No foreign-license forks**: n8n/Authentik are consumed as external containers, called via API/OIDC — synapsedx code remains pure Apache-2.0.

## Architecture (see `docs/architecture.md`)
```
Client → Gateway :8080 ─┬─► IAM :4001 (Org/Account/Role/Policy + token + OIDC Authentik/Keycloak)
                         └─► Workflow :4002 ─► n8n :5678
                         Postgres :5432 / Redis :6379 / S3 (S3Mock) :9090
```

## Run in 3 commands
```bash
cp .env.example .env        # then replace the *_change_me_* secrets
docker compose up --build -d
curl localhost:8080/health && curl localhost:4001/health && curl localhost:4002/health
```
Details: `docs/quickstart.md`. API: `docs/api.md`. Authorization model: `docs/iam-model.md`. Table of contents: `docs/README.md`.

## Repo layout
```
apps/console               AWS-style management UI (React+Vite+Tailwind)
apps/gateway               API gateway (proxy, JWT/API-key, principal x-synapsedx-*, rate-limit, /metrics)
apps/iam-service           AWS-style IAM + token/SA + authorize/simulator + OIDC (Authentik/Keycloak)
apps/workflow-service      n8n control-plane (proxy + templates)
sdks/sdk-js                @synapsedx/sdk (TypeScript)
sdks/sdk-python            synapsedx-sdk (Python)
sdks/sdk-go                synapsedx-sdk-go (Go, minimal)
tools/cli                  Zero-dependency CLI `synapsedx` (Node 18+)
infra/postgres/init.sql    Core schema (orgs/accounts/users/roles/policies/keys/...)
infra/k8s/base             Kustomize for K8s
examples/quickstart        End-to-end demo script
examples/n8n-templates     Sample workflow JSON
tests/e2e                  Smoke tests (sh/ps1) + SDK live check
docs                       architecture/iam-model/api/quickstart/object-storage/troubleshooting
```

## Quick SDK examples
```ts
// JS/TS
import { SynapseDXClient } from '@synapsedx/sdk';
const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
```
```python
# Python
from synapsedx_sdk import SynapseDXClient
c = SynapseDXClient("http://localhost:8080")
login = c.login("demo@acme.local"); c.token = login["accessToken"]
print(c.list_orgs())
```
```go
// Go
c := synapsedx.New("http://localhost:8080")
out, _ := c.Login("demo@acme.local")
```

## Access: Console UI & CLI
- **Console** (`http://localhost:3000` after `docker compose up -d console`):
  login `demo@acme.local` / org `acme` → manage Org/Account/User/Role/Policy/Key,
  authorize simulator, workflows, audit. Details: `docs/console.md`.
- **CLI** (`tools/cli`, zero-dependency): `node tools/cli/bin/synapsedx.js login ...`
  — see `tools/cli/README.md`.

## IdP configuration (Access Management)
- Default is **Authentik** (internal `authentik-server:9000`, external `http://localhost:19000`), see `infra/authentik/README.md`.
- Prefer **Keycloak**? Just change `OIDC_ISSUER=https://<keycloak>/realms/<realm>` + client id/secret — IAM stays the same (federated OIDC, shadow user + internal authorization).

## Common commands
| Command | Description |
|---|---|
| `make bootstrap` | copy .env + npm install |
| `make build` / `make test` | build/test entire monorepo |
| `make compose-up` / `make compose-down` | start/stop platform |
| `bash tests/e2e/smoke.sh` | smoke test gateway+iam+workflow |
| `bash tests/e2e/api-check.sh` | full API e2e (23 checks, requires jq) |
| `make sdk-check` | live SDK check JS + Python (requires running gateway) |

## Contributing / Security / License
- Contributing: `CONTRIBUTING.md`. Code of conduct: `CODE_OF_CONDUCT.md`. Governance: `GOVERNANCE.md`. Roadmap: `ROADMAP.md`.
- Security: `SECURITY.md` (do not open public issues for vulnerabilities).
- License: Apache-2.0 (`LICENSE`), third-party: (`NOTICE`).
