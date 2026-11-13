<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/console/public/brand/logo-lockup-dark.png">
    <img src="apps/console/public/brand/logo-lockup-light.png" width="420" alt="SynapseDX">
  </picture>
</p>

# SynapseDX — Tier 2

![CI](https://github.com/vku-open-source-2026/SynapseDX/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/vku-open-source-2026/SynapseDX/actions/workflows/release-images.yml/badge.svg)

SynapseDX is the reusable capability layer between SynapseOne (Tier 1) and the
Tier-3 products (SynapseCity, SynapseCitySOS). It exposes generic
organization/open-data capabilities and uses SynapseOne for all persistence,
identity verification and messaging.

```text
apps/gateway             public HTTPS API boundary (container :8080, host :8082)
apps/capabilities-service reusable capability backend (container :8082)
apps/console              React console (Vite + TanStack Router + Tailwind, container :80, optional cloud. host)
sdks/capabilities-js      @synapsedx/capabilities client SDK
infra/                    public-edge snippets and deployment material
```

The backend imports `@synapseone/sdk` and does not use raw HTTP to SynapseOne;
it has no database, queue, cache or identity store of its own. Tier 3 calls the
gateway at `https://synapsedx.sbs`.

> **Registry SDK.** `@synapseone/sdk@^0.8.0` is published on npm and includes
> SynapseOCS, storage, notifications and the typed identity/health lifecycle.
> The service and Docker build install it directly from the registry; there is
> no vendored SDK tarball.

> **Ports:** `8082` is the host publish port. Inside the compose network the
> gateway listens on `8080` and is reachable as `synapsedx-gateway:8080`; the
> capabilities service listens on `8082` and is not published.

## Self-host

Three public GHCR images are published for every release (Apache-2.0, no
registry login required):

- `ghcr.io/vku-open-source-2026/synapsedx/capabilities`
- `ghcr.io/vku-open-source-2026/synapsedx/gateway`
- `ghcr.io/vku-open-source-2026/synapsedx/console`

> If `docker pull` returns `unauthorized`, the GHCR packages have not been
> switched to public yet. An organization admin must add a `GHCR_PAT` secret
> (package admin) and run the `packages-public` workflow in the SynapseOne
> repository once.

Tier 2 always uses a live Tier-1 SynapseOne API. For the public demo that is
`https://api.synapseone.space`; for a private stack point `SYNAPSEONE_BASE_URL`
at your own SynapseOne gateway and issue a scoped `SYNAPSEONE_API_KEY` there.

### 1. Run the published images (recommended)

```bash
git clone https://github.com/vku-open-source-2026/SynapseDX.git
cd SynapseDX
cp .env.example .env        # set SYNAPSEONE_BASE_URL + SYNAPSEONE_API_KEY
export SYNAPSEDX_VERSION=v0.6.1   # or latest

docker compose pull
docker compose up -d --no-build
curl http://127.0.0.1:8082/health
```

The gateway is bound to loopback by default; terminate TLS with your own edge
(see `infra/`) and keep the capabilities service private.

### 2. Build from source

Requirements: Node.js 20+, Docker Engine 24+ and Compose v2.24+.

```bash
git clone https://github.com/vku-open-source-2026/SynapseDX.git
cd SynapseDX
cp .env.example .env        # set SYNAPSEONE_BASE_URL + SYNAPSEONE_API_KEY
npm ci
npm run build
npm test
docker compose build
docker compose up -d --no-build
```

`docker compose up -d --build` combines the last two steps. The Compose images
are the published GHCR names, so a local build and a registry pull produce the
same stack.

## Authentication and tenancy

A caller must present a Tier-1-verifiable credential:

```http
Authorization: Bearer <tier1 access token>
# or
X-API-Key: <tier1 api key>
```

Tier-2 verifies it with `GET /v1/auth/verify` using only the caller credential.
The process `SYNAPSEONE_API_KEY` is used for Tier-2's own data access and is
**never** a fallback for an anonymous caller. Public reads are an explicit
allow-list: only `public: true` + `status: published` datasets and their
entities are anonymous.

Private dataset metadata and records are scoped to the tenant (Tier-1
account/org/subject) that created them. Datasets written before tenancy was
recorded remain reachable by authenticated callers and are stamped on the next
write. Writes need a credential with a write-capable scope; a read-only API key
gets `403 insufficient_scope`.

Each Tier-3 product must use its **own account-scoped Tier-1 key**. A
credential carrying `*` (platform admin) or the shared service account is an
administrator identity by design and is not product-isolated; do not hand it to
a Tier-3 product as its caller credential.

`SYNAPSEDX_AUTH_MODE=optional` exists only for local tests and is rejected in
production.

## Capabilities

| Capability | Status | Notes |
| --- | --- | --- |
| datasets / records / publication | available | SynapseBase + SynapseLDS + Queue/Stream |
| events | available | at-least-once queue + non-destructive stream feed with cursor |
| identity/session | available | register, password login/change/reset, email verification, sessions, refresh/logout, OIDC and delegated exchange via Tier-1 IAM |
| AI/inference | available | chat, embeddings, decision, route via Tier-1 Inference |
| jobs | available | Tier-1 cron workflows plus a Tier-3 runner lease contract; see [`docs/RUNNER.md`](docs/RUNNER.md) |
| audit / usage | available | Tier-2 mutation audit + Tier-1 IAM usage projection |
| files | available | binary upload/download, metadata, checksum, quota, presigned URLs via Tier-1 storage |
| notifications | available | templates, send, status, cancel, preferences via Tier-1 notifications |
| warehouse | available | Tier-1 DuckDB OLAP datasets, read-only SQL, batch/stream ETL, saved reports and published snapshots |
| geo | provider-configured | provider-neutral adapter (generic REST or VietMap preset); configure `SYNAPSEDX_GEOCODER_*` |

See [`docs/API.md`](docs/API.md) for the full route, error-code, pagination and
lifecycle reference.

## Dataset lifecycle

```text
draft --publish--> published --revoke/unpublish--> revoked
  ^                    |                              |
  |                    +--publish (idempotent)        |
  +-------------------------publish------------------+
```

- Only a `public` dataset can be published.
- `revoke` and `PATCH {public:false}` restrict every exported LDS attribute,
  delete the datasource and clear `ldsDatasourceId`; a direct Tier-1 LDS read
  then fails.
- `publish` from `revoked` re-creates the datasource and re-ingests records.
- `PATCH {public:true}` on a previously published dataset republishes it.
- Users may still update metadata in place with `PATCH /v1/capabilities/datasets/:id`
  (license, description, visibility, owner, schema version, retention).

Per-record publication is a tri-state on record create/update: `publish: true`
publishes, `publish: false` withholds and withdraws an existing projection, and
omitted inherits the dataset default.

## Writes and concurrency

- Send `Idempotency-Key` to make a write retry-safe; the stored response is
  replayed for the same key/body (Tier-1 Faststore, 24 h default).
- Send `If-Match: "<version>"` (or `ifVersion` in the body) on PATCH/DELETE to
  get `409 version_conflict` instead of a silent lost update.
- Capability events are delivered at-least-once and include `eventId`,
  `correlationId` and `schemaVersion`. If the queue is down the write still
  succeeds (`x-event-status: pending`) and the event is retried from the
  dataset outbox via `POST /v1/capabilities/events/outbox/flush?datasetId=...`.

## Management console

`cloud.synapsedx.sbs` serves the Tier-2 control plane for administrators,
operators, moderators and managers. The console is a React SPA (Vite +
TanStack Router + Tailwind, same stack as the City/SOS consoles) backed only
by the public capabilities API:

- public catalog landing for anonymous visitors, and sign in with the Tier-1
  IAM account (email/password); the session lives in `localStorage` and is
  revoked through the identity capability;
- overview metrics, dataset create/edit/publish/revoke/delete, record CRUD and
  bulk import, review queue, approvals (HITL), 10 business modules, team
  account/roles, event feed, audit/usage and session settings under `/admin`;
- roles are derived server-side: `admin`, `operator`, `moderator`, `manager`
  and `viewer`; the browser cannot choose a role;
- the production image serves the static build through nginx with the
  City/SOS design system and a strict self-only CSP.

The review lane is additive: `submit-review` → `approve`/`reject` records a
decision, while publication remains a separate operator action. See
[`docs/API.md`](docs/API.md) and
[`docs/DX_OS_TIER_MODEL_2026-11-04.md`](docs/DX_OS_TIER_MODEL_2026-11-04.md).

## DX-OS 2026

The OLP 2026 exam asks for a three-tier DX-OS: headless Tier-1 platform,
reusable H-P-D-I capabilities in Tier 2, and domain apps in Tier 3. The tier
boundary, feature allocation matrix, HITL contract and OLP evidence checklist
are documented in
[`docs/DX_OS_TIER_MODEL_2026-11-04.md`](docs/DX_OS_TIER_MODEL_2026-11-04.md).

## Commands

```bash
cp .env.example .env
npm install
npm run build
npm test
npm run build:sdk
npm pack --dry-run --workspace=@synapsedx/capabilities
docker compose config
docker compose up -d --build
docker run --rm synapsedx-console nginx -t
```

`npm test` runs the capabilities-service contract suite against an in-memory
Tier-1 fake, the gateway proxy suite and the SDK suite. No test needs network
access or a production credential.

## Release status

- Tier-2 API/service: versioned in `CHANGELOG.md`; current release `v0.6.1`.
- Public container images:
  `ghcr.io/vku-open-source-2026/synapsedx/{capabilities,gateway,console}`.
- SDK `@synapsedx/capabilities@0.7.0`: release tarball is attached to
  <https://github.com/vku-open-source-2026/SynapseDX/releases/tag/v0.6.0> and
  mirrored through the same Tier-2 files capability into Tier-1 SynapseOCS:
  <https://synapsedx.sbs/v1/capabilities/public/files/synapsedx-capabilities-0.6.0/content>
  (`SHA-256 e036f511390cd3e6a1d772bd818ca4f7ed1c2b18360dceac71a7411d3b75f676`).
  npm registry publication still requires `NPM_TOKEN`; the GitHub/OCS tarball
  is the reproducible release artifact until that is available.
- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution
  in `NOTICE`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseDX/issues).
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md).

## Brand

Logo, icon and social-preview assets live in [`apps/console/public/brand`](apps/console/public/brand). The console serves the favicon, web app manifest and icons from `apps/console/public`.

To set the GitHub repository social preview, upload [`apps/console/public/brand/social-preview.png`](apps/console/public/brand/social-preview.png) in **Settings → Social preview**.
