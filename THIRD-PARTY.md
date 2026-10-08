# Third-party components

SynapseDX itself is Apache-2.0 (see `LICENSE`, `NOTICE`). This file inventories the
significant third-party components it integrates with or bundles, with their licenses
and how they are consumed. It is informational — the authoritative license is always
the upstream project's own `LICENSE` file.

## External engines / services (not bundled, talked to over HTTP — never derived works)

| Component | License | Consumed as | Notes |
|---|---|---|---|
| n8n (`n8nio/n8n`) | Sustainable Use License (proprietary, **not** OSI-approved) | Container image + REST API only | SynapseDX never bundles or modifies n8n. Using SynapseDX with n8n does not change n8n's license; check it yourself for commercial/self-host terms. |
| Authentik (`ghcr.io/goauthentik/server`) | MIT | Container image + OIDC | Optional external IdP (default). |
| Keycloak | Apache-2.0 | OIDC (alternative IdP) | Supported as alternative upstream IdP; no image pinned in compose. |
| PostgreSQL (`postgres:16-alpine`) | PostgreSQL Licence (permissive) | Container image + `pg` driver (MIT) | System of record for IAM. |
| Redis (`redis:7-alpine`) | RSALv2/SSPL depending on distribution | Container image + `ioredis` (MIT) | Rate-limit store + Authentik cache. Check your Redis distribution's license. |
| Adobe S3Mock (`adobe/s3mock`) | Apache-2.0 | Container image (local/dev object storage) | Default S3-compatible backend for local/dev; production may point at MinIO/AWS S3 instead. |

## Runtime dependencies (linked / installed from registries)

- Node.js services (`apps/*`, `tools/cli`, `sdks/sdk-js`): Express, jsonwebtoken,
  http-proxy-middleware, express-rate-limit, ioredis, js-yaml, cors, morgan,
  prom-client, zod, pg, dotenv — MIT/ISC/Apache-2.0/BSD. Exact resolved tree + licenses:
  each `package-lock.json` (run `npx license-checker --summary` per workspace for a report).
- Console (`apps/console`): React + Vite + Tailwind — MIT.
- Python SDK (`sdks/sdk-python`): `requests` — Apache-2.0.
- Go SDK (`sdks/sdk-go`): standard library only — BSD-3-Clause (Go itself).

## Verified scan (2026-10-08, `node tools/license-check.cjs`)

290 installed packages (incl. dev): MIT 258, Apache-2.0 9, ISC 15, BSD-3-Clause 4,
BSD-2-Clause 1, CC-BY-4.0 1 (+1 dual CC-BY-4.0 AND MIT), Python-2.0 1.
**Zero strong copyleft (no GPL/AGPL/CPAL/EUPL) and zero weak copyleft.**
CI re-verifies on every push (`license-check.cjs` + SBOM artifact, `pip-licenses
--fail-on` for Python, `npm audit --audit-level=critical`).

## License headers

Every source file owned by this repo carries an `Apache-2.0 / SynapseDX Contributors`
header. Generated artifacts (`dist/`, `*.egg-info/`, `.pytest_cache/`) are build output,
not source, and are not expected to carry headers (they are git-ignored where practical).
