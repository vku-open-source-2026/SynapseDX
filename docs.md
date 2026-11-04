# SynapseDX deployment and contracts

SynapseDX is a public HTTPS Tier-2 service. Put `apps/gateway` behind the
`synapsedx.sbs` TLS edge and proxy public paths to host port `8082` (the
gateway listens on `8080` inside the compose network). The gateway forwards to
`apps/capabilities-service`; the frontend is `apps/console` on the optional
`cloud.synapsedx.sbs` host.

The public API reference, auth model and error codes are in
[`docs/API.md`](API.md).

## Configuration

The capabilities process needs a scoped SynapseOne credential
(`SYNAPSEONE_API_KEY` or `SYNAPSEONE_TOKEN`) for its own data access:

- Base: collections/documents/query for capability metadata and records;
- LDS: datasources, attributes, ingest and public exports;
- Queue/Stream: capability events;
- IAM: credential verification, identity lifecycle/OIDC/exchange, audit/usage projection;
- Workflow: scheduled workflow jobs and executions;
- Inference: AI capability;
- Faststore: idempotency keys and runner job leases;
- Storage: binary file objects, presigned URLs and quota;
- Notifications: delivery outbox, retries and provider relays.

The key is server-side only. It is **not** a caller credential and is never a
fallback for anonymous requests. Callers authenticate with their own Tier-1
bearer token or API key, verified through IAM.

`SYNAPSEONE_BASE_URL` defaults to `https://api.synapseone.space`. Localhost and
private addresses are rejected unless `ALLOW_LOCAL_DEPENDENCIES=true`, which is
only for tests. `SYNAPSEDX_AUTH_MODE=optional` requires the same test override.

## Domain contract

| Operation | Tier-2 route | Tier-1 SDK operation |
| --- | --- | --- |
| dataset metadata | `/v1/capabilities/datasets` | `client.base.*` |
| records/query | `/v1/capabilities/datasets/:id/records` | `client.base.*` |
| public projection | `/v1/capabilities/datasets/:id/entities` | `client.lds.*` |
| capability event | emitted inside writes | `client.queue.publish()` + `client.stream.publish()` |
| identity | `/v1/capabilities/auth/*` | `client.iam.*` (lifecycle/OIDC/`exchangeToken`) |
| jobs (workflow) | `/v1/capabilities/jobs` (`executor:"workflow"`) | `client.workflow.*` |
| jobs (runner) | `/v1/capabilities/jobs` (`executor:"runner"`) | Base + Faststore lease |
| AI | `/v1/capabilities/ai/*` | `client.inference.*` |
| audit/usage | `/v1/capabilities/audit`, `/usage` | `client.iam.*` + Base audit collection |
| idempotency | `Idempotency-Key` header | `client.faststore.*` |
| files | `/v1/capabilities/files` | `client.storage.*` |
| notifications | `/v1/capabilities/notifications` | `client.notifications.*` |
| geocoding | `/v1/capabilities/geo/*` | operator provider (server-side key) |

`@synapseone/sdk` is a runtime dependency of `apps/capabilities-service`. The
service contains no direct `fetch` to SynapseOne and no private service URL.
Geocoding deliberately calls only the operator-configured provider, never a
Tier-1 service. While 0.8.x is unpublished, the dependency is the vendored
build described in `README.md`/`docs/RELEASE.md`.

## Persistence and retention

There is no Tier-2 database. Capability documents live in Tier-1 Base
collections: `synapsedx_capability_datasets`, `synapsedx_capability_records`,
`synapsedx_capability_jobs`, `synapsedx_capability_job_runs`,
`synapsedx_capability_files`, `synapsedx_capability_notification_templates`,
`synapsedx_capability_notification_refs`,
`synapsedx_capability_notification_preferences` and
`synapsedx_capability_audit`. Events use the `synapsedx-capability-events`
queue and stream topic. File bytes live in Tier-1 object storage; notification
delivery state lives in Tier-1 notifications.

Tier-1 storage/notifications are called with the Tier-2 service credential.
Their own tenant is therefore the platform tenant; Tier-2 enforces product
isolation through the file metadata/tenant key prefix and the notification
reference/preference indexes (a guessed id returns 404 for another tenant).

Records can be hard-deleted (`DELETE /records/:id`) and purged by policy:
set `retentionDays` on the dataset and either call
`POST /datasets/:id/records/purge-expired` or schedule a job that calls it.
Retention is a Tier-3 duty unless a dataset policy and runner are configured;
Tier-2 never silently soft-deletes.

## Operator actions

1. Provide a scoped SynapseOne credential with Base, LDS, Queue, Stream, IAM,
   Workflow, Inference and Faststore access for the selected tenant/account.
2. Provide TLS reverse-proxy routes for `synapsedx.sbs` to host port `8082` and
   optionally `cloud.synapsedx.sbs` to the console.
3. Configure `CORS_ORIGINS` with the exact Tier-3 browser origins.
4. Optionally configure a licensed geocoder (`SYNAPSEDX_GEOCODER_PROVIDER`,
   `SYNAPSEDX_GEOCODER_BASE_URL`, `SYNAPSEDX_GEOCODER_API_KEY`). `vietmap`
   selects the VietMap endpoints; `generic` uses the documented REST adapter.
   Without a provider the geo routes return a typed 503.
5. Provide registry access if `@synapsedx/capabilities` is published under the
   `@synapsedx` npm scope (the SDK is packaged but not yet published). The
   operator publish step is in [`docs/RELEASE.md`](docs/RELEASE.md).
6. Provision Tier-1 storage/notifications access on the service key and keep
   the file quota/MIME settings (`SYNAPSEDX_FILES_*`) aligned with the Tier-1
   deployment limits.
