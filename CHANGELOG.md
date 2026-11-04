# Changelog

All notable changes to SynapseDX are documented here. Entries follow the
Keep a Changelog format and version tags use Semantic Versioning.

## [Unreleased]

### Security

- Tier-2 callers are authenticated by verifying their Tier-1 bearer/API key
  with IAM. The process service key is no longer a fallback for anonymous
  requests; private dataset metadata/records are tenant-scoped and writes need
  a write-capable scope (issue #1).
- Dataset revoke/unpublish now restricts every exported LDS attribute, deletes
  the datasource and clears `ldsDatasourceId`, so the direct Tier-1 public
  entity route can no longer read revoked data (issue #2).
- `records.create/update` honour the per-record `publish` tri-state, so a
  withheld record (e.g. citizen PII) is never projected, promoted later or
  re-projected by a republish (issue #25).

### Added

- Per-dependency health/readiness (`/v1/capabilities/health|ready`) with status,
  latency and error codes; typed SDK `health()`/`ready()` (#30).
- Non-destructive capability event feed with cursor plus dataset outbox and
  `x-event-status: pending` on queue outages (#7, #6).
- Full identity/session capability over Tier-1 IAM: register, password
  login/change/forgot/reset, email verification, rotating refresh/logout,
  sessions, OIDC and delegated `/auth/exchange`, with organization and audience
  binding (#8).
- File capability over Tier-1 object storage: binary upload/download, metadata,
  SHA-256 checksums, tenant quotas, MIME/size limits, presigned URLs and upload
  completion (#9).
- Notification capability over Tier-1 notifications: reusable templates,
  send/status/cancel, per-tenant preferences/unsubscribe, idempotent fan-out
  and delivery receipts (#10).
- AI capability (chat/embeddings/decision/route/status) over Tier-1 inference
  (#11).
- Scheduled jobs with two executors: Tier-1 cron workflows and a Tier-3 runner
  lease contract (`lease`/heartbeat/complete), built-in `vndms.ingest`,
  `hazard.expire` and `report.generate` kinds, run-now, retry and dead-letter
  semantics (#26).
- Mutation audit and usage/audit projections (#18).
- Provider-neutral search/geocoding adapter with VietMap and generic REST
  presets, server-side key, normalized results and typed errors (#17).
- Typed SDK namespaces for auth/files/notifications/jobs-runner/geo plus binary
  upload/download (#8, #9, #10, #17, #26).
- Record delete/bulk/query, dataset delete, `retentionDays` and
  `purge-expired` (#29, #13).
- Idempotency keys and client-visible version preconditions (#6, #27).
- SDK delete/bulk/query/pagination/iterate/tenant/correlation/idempotency
  support and complete response/error types (#13).
- Contract tests for the capabilities service, gateway and SDK, plus CI
  workflow (#22).

### Changed

- Record IDs are preserved exactly and validated against the Tier-1 document-id
  grammar instead of being slugified (#3).
- Dataset lifecycle is an explicit state machine with idempotent publishes
  (#4).
- Dataset/record pagination uses Tier-1 Base queries with true totals,
  server-side filtering and no 500-document global scan (#5).
- Public entity responses propagate `Link rel="license"`, `X-LDS-License`,
  `X-LDS-Datasource`, `X-LDS-Total`, `X-LDS-Context`, `Cache-Control` and
  `X-Total-Count` (#12).
- Dataset license/schemaVersion/entityType are validated against the Tier-1 LDS
  catalog and semver rules (#23).
- CORS is a shared allow-list for City, SOS and the console origins with
  `Vary: Origin`, DELETE/PUT and idempotency/conditional headers (#16).
- Gateway streams raw bodies, forwards conditional/idempotency headers, applies
  an upstream timeout and uses the repository (not workspace parent) as the
  Docker build context (#21).
- Console nginx uses `#` comments, proxies `/health` and `/v1/capabilities` to
  the gateway, and escapes dataset metadata (XSS) (#15).
- Errors use a stable `{error:{code,message,requestId,details?}}` envelope;
  upstream paths are no longer exposed and unknown routes/methods return JSON
  (#19).

### Fixed

- Documentation now matches the implementation: dependency inventory, release
  status, ports, API reference and PATCH/publication semantics (#20).
- `@synapseone/sdk` temporarily resolves to the vendored Apache-2.0
  `0.8.0-dev.0` build because the registry `0.7.0` release predates the storage,
  notifications and typed identity/health APIs; replacement steps are in
  `docs/RELEASE.md` (#9, #10, #8).

## [0.1.0] - 2026-11-01

- Tagged the initial Tier-2 API surface and SDK source. The API was deployable
  as a source checkout; `@synapsedx/capabilities` was **not** published to npm
  and had no GitHub release. This entry is corrected from the earlier claim
  that the SDK was published.
- Added Apache-2.0 licensing and VKU.VIC attribution.

[Unreleased]: https://github.com/vku-open-source-2026/SynapseDX/compare/v0.1.0...HEAD
