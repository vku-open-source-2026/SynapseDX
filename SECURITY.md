# Security Policy

## Supported versions
| Version | Supported |
|---|---|
| 0.1.x (main) | ✅ |

## Reporting a vulnerability
- **Do not** open a public GitHub issue.
- Email the maintainers (see `GOVERNANCE.md`) with: affected version, reproduction steps, impact.
- Expect acknowledgement within 3 business days; we aim to ship a fix + advisory within 30 days for critical issues.

## Hardening notes
- Change every `*_change_me_*` secret in `.env` before exposing anything.
- Gateway rate-limits by default (300 req/min); tighten in `docker-compose.yml` for public deployments.
- JWT uses HS256 with `IAM_JWT_SECRET` (≥32 chars). Rotate by restarting `iam` + `gateway` together.
- n8n/Authentik are external engines — track their own CVEs and pin images in `docker-compose.yml`.

## Known transitive findings (accepted, tracked)
- `braces` (GHSA-vfj7-8cjw-p6xm, via `micromatch` ← `http-proxy-middleware` in gateway):
  no non-breaking fix upstream yet. Route patterns come from operator-controlled
  `routes.yaml`, not from request input, so the nested-pattern ReDoS is not
  remotely triggerable through the gateway. Re-evaluate on each
  `http-proxy-middleware` minor release (`npm audit` in CI surfaces it).
