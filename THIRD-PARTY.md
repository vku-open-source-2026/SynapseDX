# Third-party components

SynapseOne itself is Apache-2.0 (see `LICENSE`, `NOTICE`). This file inventories the
significant third-party components it integrates with or bundles, with their licenses
and how they are consumed. It is informational — the authoritative license is always
the upstream project's own `LICENSE` file.

## External engines / services (not bundled, talked to over HTTP — never derived works)

| Component | License | Consumed as | Notes |
|---|---|---|---|
| Workflow engine | SynapseOne's own code (Apache-2.0, `apps/workflow-service/src/engine.ts`) | Built-in, no external image | Former n8n integration removed in 0.4.0 for license + usability reasons (SUL barred end-user-editable workflows). No SUL/AGPL engine remains in the default stack. |
| Authentik (`ghcr.io/goauthentik/server`) | MIT | Container image + OIDC | Optional external IdP (default). |
| Keycloak | Apache-2.0 | OIDC (alternative IdP) | Supported as alternative upstream IdP; no image pinned in compose. |
| PostgreSQL (`postgres:16-alpine`) | PostgreSQL Licence (permissive) | Container image + `pg` driver (MIT) | System of record for IAM. |
| Redis (`redis:7-alpine`) | RSALv2/SSPL depending on distribution | Container image + `ioredis` (MIT) | Rate-limit store + Authentik cache. Check your Redis distribution's license. |
| Adobe S3Mock (`adobe/s3mock`) | Apache-2.0 | Container image (local/dev object storage) | Default S3-compatible backend for local/dev; production may point at MinIO/AWS S3 instead. |
| Prometheus (`prom/prometheus`) | Apache-2.0 | Container image + scrape API | Metrics store for `infra/monitoring` (scrapes gateway/PG/Redis). |
| postgres-exporter (`prometheuscommunity/postgres-exporter`) | Apache-2.0 | Container image | PG metrics for Prometheus. |
| redis-exporter (`oliver006/redis_exporter`) | MIT | Container image | Redis metrics for Prometheus. |
| nginx (`nginx:alpine`, prod edge) | BSD-2-Clause-like | Container image | TLS terminator in `infra/prod`. |
| certbot (`certbot/certbot`) | Apache-2.0 | Container image (one-shot) | LE certificates in `infra/prod`. |
| AWS CLI (`amazon/aws-cli`, s3-init) | Apache-2.0 | Container image (one-shot) | Bucket auto-create for S3Mock. |
| MinIO (`quay.io/minio/minio`, optional prod S3 backend) | **AGPL-3.0** | Container image (optional, opt-in) | Only if you choose MinIO per `docs/object-storage.md`; it runs as a separate service over the network (never linked). AWS S3 avoids the question entirely. |

## Runtime dependencies (linked / installed from registries)

- Node.js services (`apps/*`, `tools/cli`, `sdks/sdk-js`): Express, jsonwebtoken,
  http-proxy-middleware, express-rate-limit, ioredis, js-yaml, cors, morgan,
  prom-client, zod, pg, dotenv — MIT/ISC/Apache-2.0/BSD. Exact resolved tree + licenses:
  each `package-lock.json` (run `npx license-checker --summary` per workspace for a report).
- Console (`apps/console`): React + Vite + Tailwind — MIT; FontAwesome icons
  (`@fortawesome/*` — MIT, except `free-solid-svg-icons` dual `CC-BY-4.0 AND MIT`:
  attribution is given here + in `NOTICE`).
- Python SDK (`sdks/sdk-python`): `requests` — Apache-2.0 (via `urllib3` MIT,
  `idna` BSD-3-Clause, `charset-normalizer` MIT, `certifi` **MPL-2.0** — file-level
  weak copyleft, used unmodified as a CA bundle; no disclosure duty beyond this notice).
- Go SDK (`sdks/sdk-go`): standard library only — BSD-3-Clause (Go itself).

## Verified scan (2026-10-13, `node tools/license-check.cjs`)

290 installed packages (incl. dev): MIT 258, Apache-2.0 9, ISC 15, BSD-3-Clause 4,
BSD-2-Clause 1, CC-BY-4.0 1 (+1 dual CC-BY-4.0 AND MIT), Python-2.0 1.
**Zero strong copyleft (no GPL/AGPL/CPAL/EUPL), zero weak copyleft, zero
source-available/ethical/NC licenses (no SSPL/RSAL/BUSL/SUL/Hippocratic/
Commons-Clause/Elastic/PolyForm/Prosperity) in the npm tree.**
Scope note: the gate scans the npm tree only. Python (`certifi` MPL-2.0, above),
Go (stdlib only) and container images (MinIO AGPL-3.0 if opted in, above) are
inventoried manually in this file.
CI re-verifies on every push (`license-check.cjs` + SBOM artifact, `pip-licenses
--fail-on` for Python, `npm audit --audit-level=critical`).

## License headers

Every source file owned by this repo carries an `Apache-2.0 / SynapseOne Contributors`
header. Generated artifacts (`dist/`, `*.egg-info/`, `.pytest_cache/`) are build output,
not source, and are not expected to carry headers (they are git-ignored where practical).
