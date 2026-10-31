# SynapseOne — the open PaaS for your infrastructure

[![CI](https://github.com/vku-open-source-2026/SynapseOne/actions/workflows/ci.yml/badge.svg)](https://github.com/vku-open-source-2026/SynapseOne/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vku-open-source-2026/SynapseOne)](https://github.com/vku-open-source-2026/SynapseOne/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![npm SDK](https://img.shields.io/npm/v/@synapseone/sdk)](https://www.npmjs.com/package/@synapseone/sdk)
[![npm CLI](https://img.shields.io/npm/v/@synapseone/cli)](https://www.npmjs.com/package/@synapseone/cli)
[![PyPI SDK](https://img.shields.io/pypi/v/synapseone-sdk)](https://pypi.org/project/synapseone-sdk/)

**SynapseOne is an open-source Tier-1 PaaS (Apache-2.0): one API gateway, AWS-style access
management, a core data cluster (documents, cache and queue), and native workflows —
operated through a web Console, SDKs in three languages, and a zero-dependency CLI.**

No lock-in: Authentik/Keycloak runs as an optional external IdP over
standard OIDC. Everything else is SynapseOne code, pure Apache-2.0.

- 🌐 **Live demo:** [synapseone.space](https://synapseone.space) · Console: [cloud.synapseone.space](https://cloud.synapseone.space) · API: `https://api.synapseone.space/health`
- 📦 **Install:** `npm i @synapseone/sdk` · `pip install synapseone-sdk` · `npx @synapseone/cli` · Go SDK via the monorepo (see below)
- 🚀 **Self-host:** `docker compose up -d --build` (details below)

## Why SynapseOne

| Capability | What you get |
|---|---|
| **API Gateway** | Single entry point: JWT/API-key auth, principal propagation (`x-synapseone-*`), edge rate limiting, tracing, aggregate `/ready`, Prometheus `/metrics` |
| **AWS-style IAM** | Organization → Account → User → Role → JSON Policy (Allow/Deny + Condition), `authorize` API + dry-run simulator + audit log, tenant isolation on every write (role-based, same-org fallback) |
| **Flexible identity** | Short-lived JWT, atomic rotating refresh tokens, API keys, service accounts, and real OIDC Authorization Code flow (Authentik/Keycloak) with shadow users |
| **Core data** | Postgres (source of truth) + Redis + S3-compatible object storage, versioned schema, idempotent seed |
| **SynapseBase** | Self-managed document database: collections, object↔data mapping with validation, filters/cursors, optimistic concurrency, atomic counters, batches and a change feed (`/v1/base`) |
| **Synapse Faststore** | Redis-backed cache/KV and data structures: TTL strings, counters, hashes, lists, sets, sorted sets, scans, batches and distributed locks (`/v1/faststore`) |
| **SynapseQueue** | At-least-once messaging: delayed/deduplicated publishing, visibility-timeout leases, ack/nack/heartbeat, retries, dead letters and replay (`/v1/queue`) |
| **Workflows** | Built-in workflow engine (Apache-2.0): DAG runner, versioned templates, activate/deactivate/execute (real webhook & cron triggers), sandboxed code execution, execution history, visual graph editor |
| **Linked Data (SynapseLDS)** | Licence-picked NGSI-LD datasources: structural-allowlist projection (`_core` never serialized), per-attribute visibility (public/restricted/internal), default-deny schema registry, workflow publish node (`lds.publish-record`) |
| **AI assistant** | Chatbot on the API Docs page: decision model picks the endpoint, LLM pre-fills the try-it form (server-side key, guidance-only, never public) |
| **Clients** | TypeScript, Python and Go SDKs with full API parity, zero-dependency CLI, admin Console |

## Try it in 30 seconds

No install needed — point the clients at the live demo:

```bash
# CLI, straight from the registry (Node 18+)
npx -y @synapseone/cli@latest --base https://api.synapseone.space login --email demo@acme.local
npx -y @synapseone/cli@latest --base https://api.synapseone.space orgs
```

```python
# Python SDK
pip install synapseone-sdk
```

```python
from synapseone_sdk import SynapseOneClient
c = SynapseOneClient("https://api.synapseone.space")
login = c.iam.login("demo@acme.local")
c.set_api_key("<your-key>")  # create one in the Console: cloud.synapseone.space → Keys
print(c.iam.list_orgs())
```

Or open the [Console](https://cloud.synapseone.space) and sign in with an API key.

## Install

```bash
# JavaScript / TypeScript
npm install @synapseone/sdk

# Python (3.9+)
pip install synapseone-sdk

# Go (1.22+) — the SDK lives in this monorepo (sdks/sdk-go); wire it with a
# replace directive (a standalone module repo is planned — the monorepo path
# contains uppercase letters, which Go module paths forbid):
#   go mod edit -replace github.com/synapseone/synapseone-sdk-go=<checkout>/sdks/sdk-go

# CLI — one-line installer (Node 18+, no clone needed)
curl -fsSL https://synapseone.space/install.sh | sh
# ..or run without installing anything:
npx -y @synapseone/cli@latest --help
```

```ts
// TypeScript
import { SynapseOneClient } from '@synapseone/sdk';
const c = new SynapseOneClient({ baseUrl: 'https://api.synapseone.space' });
const { accessToken } = await c.iam.login('demo@acme.local');
c.setToken(accessToken);
await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');

await c.faststore.set('cache:demo', { ok: true }, { ttlSeconds: 300 });
await c.queue.publish('emails', { to: 'demo@acme.local' });
```

All clients cover the full API (`docs/api.md`): auth/refresh/logout, orgs/accounts/users,
roles/policies/attach/assign, authorize + dry-run, audit, API keys, service accounts,
workflows/templates/executions, LDS, Base, Faststore and Queue. The SDKs are split
per service namespace (`c.iam`, `c.workflow`, `c.lds`, `c.base`, `c.faststore`,
`c.queue`); legacy flat methods still work with a deprecation warning.

## Self-host

```bash
cp .env.example .env   # then replace every *_change_me_* secret
docker compose up -d --build
curl localhost:8080/health && curl localhost:4001/health && curl localhost:4002/health
curl localhost:4005/health && curl localhost:4006/health && curl localhost:4007/health
open http://localhost:3000   # sign in: demo@acme.local / org acme
```

Production (TLS, edge rate limiting, hardened secrets): `docker-compose.prod.yml` +
`infra/prod/` (nginx + Let's Encrypt via Certbot). Full checklist: `docs/production.md`.

| Layer | Endpoint (local) | Notes |
|---|---|---|
| Console | `http://localhost:3000` | Admin UI (React + Vite) |
| Gateway | `http://localhost:8080` | The only public API in production |
| IAM | `http://localhost:4001` | Internal (behind gateway in prod) |
| Workflow | `http://localhost:4002` | Internal (behind gateway in prod) |
| LDS | `http://localhost:4004` | Internal — SynapseLDS NGSI-LD datasources (behind gateway in prod) |
| Base | `http://localhost:4005` | Internal — SynapseBase documents + mapping (behind gateway in prod) |
| Faststore | `http://localhost:4006` | Internal — cache/KV/data structures (behind gateway in prod) |
| Queue | `http://localhost:4007` | Internal — SynapseQueue messaging (behind gateway in prod) |

## Architecture

```
Client → Gateway :8080 ─┬─► IAM :4001       (Org/Account/Role/Policy + tokens + OIDC)
                         ├─► Workflow :4002  (built-in Apache-2.0 engine)
                         ├─► LDS :4004       (licensed NGSI-LD exports)
                         ├─► Base :4005      (documents + object↔data mapping)
                         ├─► Faststore :4006 (cache/KV/data structures)
                         └─► Queue :4007     (at-least-once messaging)
                         Postgres :5432 / Redis :6379 / S3-compatible :9090
```

Authentik (or Keycloak) acts purely as a federated IdP over OIDC; IAM keeps the shadow
user and all authorization. Details: `docs/architecture.md`, `docs/iam-model.md`.

## Repository layout

```
apps/console               Admin UI (React + Vite + Tailwind)
apps/gateway               API gateway (proxy, JWT/API-key, principal headers, /metrics)
apps/iam-service           IAM + tokens + authorize/simulator + real OIDC code flow
apps/workflow-service      Workflow engine (local built-in DAG runner, sandboxed code, triggers)
apps/lds-service           SynapseLDS — NGSI-LD datasources, registry, licensed exports
apps/base-service          SynapseBase — documents, mapping, queries, change feed
apps/faststore-service     Synapse Faststore — cache/KV, data structures, locks
apps/queue-service         SynapseQueue — publish/consume, leases, retries, DLQ
sdks/sdk-js                @synapseone/sdk (TypeScript, zero runtime deps)
sdks/sdk-python            synapseone-sdk (Python, requests only)
sdks/sdk-go                synapseone-sdk-go (Go, stdlib only)
tools/cli                  synapseone CLI (zero deps, Node 18+) + install.sh
infra/prod                 Production edge: nginx + Certbot overlay
infra/monitoring           Prometheus (scrape gateway/PG/Redis + alert rules)
infra/k8s/base             Kustomize manifests for Kubernetes
infra/postgres/init.sql    Database bootstrap (extensions + journal schema; services own migrations)
examples/quickstart        End-to-end demo script
tests/e2e                  Smoke tests + live SDK checks
docs                       Start at docs/README.md
```

## Documentation

| Guide | Content |
|---|---|
| `docs/quickstart.md` | Run in 3 commands, your first flow |
| `docs/api.md` | Complete API reference |
| `docs/synapsebase.md` | SynapseBase — documents, object↔data mapping, queries, changes |
| `docs/faststore.md` | Synapse Faststore — cache/KV, data structures, locks |
| `docs/queue.md` | SynapseQueue — publish, consume, leases, retries, dead letters |
| `docs/iam-model.md` | Authorization model with examples |
| `docs/configuration.md` | Every environment variable |
| `docs/production.md` | Production checklist (secrets, TLS, edge) |
| `docs/console.md` | Operating the Console |
| `docs/object-storage.md` | S3-compatible storage backends |
| `docs/troubleshooting.md` | Common failures and fixes |

## Common commands

| Command | Description |
|---|---|
| `make bootstrap` | Copy `.env` + install all workspaces |
| `make build` / `make test` | Build / test the entire monorepo |
| `make compose-up` / `make compose-down` | Start / stop the platform |
| `bash tests/e2e/api-check.sh` | Full API e2e (requires `jq`) |
| `make sdk-check` | Live SDK check, JS + Python (needs a running gateway) |

## Contributing · Security · License

- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md) · Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) · Governance: [`GOVERNANCE.md`](GOVERNANCE.md) · Roadmap: [`ROADMAP.md`](ROADMAP.md) · Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- Security: please **do not** open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
- License: Apache-2.0 ([`LICENSE`](LICENSE)), third-party notices: [`NOTICE`](NOTICE), [`THIRD-PARTY.md`](THIRD-PARTY.md).
