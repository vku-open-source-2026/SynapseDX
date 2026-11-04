# SynapseDX — Tier 2

SynapseDX is the reusable capability layer between SynapseOne (Tier 1) and the
Tier-3 products (SynapseCity, SynapseCitySOS). It exposes generic
organization/open-data capabilities and uses SynapseOne for all persistence,
identity verification and messaging.

```text
apps/gateway             public HTTPS API boundary (container :8080, host :8082)
apps/capabilities-service reusable capability backend (container :8082)
apps/console              static console shell (container :80, optional cloud. host)
sdks/capabilities-js      @synapsedx/capabilities client SDK
infra/                    public-edge snippets and deployment material
```

The backend imports `@synapseone/sdk` and does not use raw HTTP to SynapseOne;
it has no database, queue, cache or identity store of its own. Tier 3 calls the
gateway at `https://synapsedx.sbs`.

> **Temporary SDK build.** The public `@synapseone/sdk@0.7.0` release predates
> `StorageService`, `NotificationsService` and the typed health/identity
> lifecycle. Until `0.8.x` is published, the service depends on a byte-for-byte
> build of the Tier-1 SDK source committed as
> `vendor/synapseone-sdk-0.8.0-dev.0.tgz` (`file:` dependency). The Dockerfile
> copies `vendor/`; replace the dependency with `^0.8.0` and delete the tarball
> when the registry release exists. See `THIRD-PARTY.md` and
> `docs/RELEASE.md`.

> **Ports:** `8082` is the host publish port. Inside the compose network the
> gateway listens on `8080` and is reachable as `synapsedx-gateway:8080`; the
> capabilities service listens on `8082` and is not published.

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

- Tier-2 API/service: versioned in `CHANGELOG.md`.
- SDK `@synapsedx/capabilities@0.3.0`: packaging is release-ready
  (LICENSE/NOTICE, no test artifacts, `engines.node >= 20`), but it is **not
  yet published** to npm because no `NPM_TOKEN` is available. Tier-3 currently
  uses a `file:` dependency; the local `npm pack`/consumer-install checks pass.
  Operator publish steps are in [`docs/RELEASE.md`](docs/RELEASE.md). See issue
  #14 for the remaining registry publication and Tier-3 adoption steps.
- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution
  in `NOTICE`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseDX/issues).
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md).
