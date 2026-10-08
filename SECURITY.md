# Security Policy

## Supported versions
| Version | Supported |
|---|---|
| 0.3.x | ✅ |
| < 0.3 | ❌ (upgrade) |

## Reporting a vulnerability
- **Do not** open a public GitHub issue.
- Use GitHub **Private vulnerability reporting** (Security tab → Report a vulnerability),
  or email the maintainers (see `MAINTAINERS`/`GOVERNANCE.md`) with: affected version,
  reproduction steps, impact.
- Expect acknowledgement within 3 business days; we aim to ship a fix + advisory within 30 days for critical issues.

## Production checklist (do this before exposing anything)
1. Change every `*_change_me_*` secret in `.env` (JWT, postgres, authentik, n8n, OIDC).
2. `IAM_JWT_SECRET`: random value ≥32 chars. Gateway and IAM **must share the same value**.
   The services refuse to boot in `NODE_ENV=production` with a default/weak secret.
3. `SYNAPSEDX_INTERNAL_SECRET`: random 32+ chars, **same value** on gateway + iam + workflow.
   With it set, IAM/workflow reject any traffic that did not come through the gateway
   (direct `:4001`/`:4002` access without the header → 401). Also stop publishing
   `IAM_HOST_PORT`/`WORKFLOW_HOST_PORT` to the host / internet — bind them to
   localhost or remove the `ports:` entries.
4. `IAM_ALLOW_DEV_LOGIN=false` (disables passwordless dev login; OIDC only).
5. `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` (the demo callback trusts caller-supplied
   email — anyone can impersonate anyone while it is on; dev-only).
6. `IAM_API_KEY_PEPPER`: random 32+ chars so API-key/refresh hashes at rest are
   HMAC-SHA256 instead of plain SHA-256. Keys created before the pepper was set
   keep working (verify tries peppered then legacy hash).
7. `CORS_ORIGIN=https://console.your-domain` (never `*` in production).
8. `HSTS_ENABLED=true` **only** behind TLS (see `docker-compose.tls.yml`).
9. Tighten `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` for public deployments.
   `/v1/auth/*` has its own stricter quota (default 60 req/min) against
   credential-stuffing.
10. Track CVEs of the external engines and pin images: Authentik, n8n, PostgreSQL,
    Redis (see `docker-compose.yml`). Rotate `N8N_API_KEY` and `N8N_ENCRYPTION_KEY`.
11. Console stores the session token in `localStorage` (XSS-readable by design for a
    static SPA). Mitigate with a strict CSP on your reverse proxy, keep dependencies
    patched, and use short `IAM_JWT_EXPIRES_IN` + refresh rotation (already atomic).

## Auth model (defense in depth)
- Gateway is the only public entrypoint: JWT (`Authorization: Bearer`) and/or
  `X-API-Key` on every route except `/v1/auth/*`, `/health`, `/ready`, `/metrics`.
- Gateway strips all client-sent `x-synapsedx-*` headers and re-emits them from the
  verified principal (spoof-proof propagation to upstreams).
- IAM and workflow additionally require `x-synapsedx-internal` (shared secret) on
  `/v1/*` when `SYNAPSEDX_INTERNAL_SECRET` is set — direct-to-service bypass is
  closed. Without the secret (dev), IAM falls back to verifying the caller's own
  Bearer/API key on every route.
- Refresh rotation is atomic (`consume+revoke` in one step): parallel replay of the
  same refresh token lets exactly one request win.
- API keys are shown **once** at creation and stored hashed; `keys verify` is an
  internal endpoint (gateway-authenticated).

## Hardening notes
- JWT uses HS256 with `IAM_JWT_SECRET` (≥32 chars). Rotate by restarting `iam` + `gateway` together.
- Baseline security headers are set by all services (`nosniff`, `DENY` framing,
  `no-referrer`, locked-down `Permissions-Policy`; HSTS opt-in via `HSTS_ENABLED`).
- Gateway request-ids are sanitized to token chars (no CRLF/header injection).
- Workflow `/v1/executions` only forwards an allowlisted query set to n8n
  (`limit, offset, workflowId, status, includeData`) — no raw query passthrough.
- Workflow definitions may contain HTTP nodes (inherent SSRF surface of any workflow
  engine): restrict who can create/execute workflows via RBAC, and run n8n
  egress-restricted in production (no cloud-metadata access).
- IAM validates `email` (RFC, ≤320 chars, lowercased) and `slug` (`^[a-z0-9-]{2,64}$`)
  with zod on login / OIDC-callback / org / account / user creation.
- n8n/Authentik are external engines — track their own CVEs and pin images in `docker-compose.yml`.

## Known transitive findings (accepted, tracked)
- `braces` (GHSA-vfj7-8cjw-p6xm, via `micromatch` ← `http-proxy-middleware` in gateway):
  no non-breaking fix upstream yet. Route patterns come from operator-controlled
  `routes.yaml`, not from request input, so the nested-pattern ReDoS is not
  remotely triggerable through the gateway. Re-evaluate on each
  `http-proxy-middleware` minor release (`npm audit` in CI surfaces it).
