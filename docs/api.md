# API reference (via Gateway :8080, or services directly)

Base: `http://localhost:8080` (gateway) — every `/v1/*` route needs
`Authorization: Bearer <JWT>` or `X-API-Key`, except `/v1/auth/*`.
Calling `:4001`/`:4002` **directly** (bypassing the gateway) additionally requires
`x-synapsedx-internal: <SYNAPSEDX_INTERNAL_SECRET>` once the secret is configured
(production), otherwise 401 — see `SECURITY.md`.

## Principal propagation (gateway → upstream)

The gateway **strips** every client-sent `x-synapsedx-*` header (anti-spoofing), then
**re-stamps** them from the verified principal: `x-synapsedx-kind: user|apikey`,
`x-synapsedx-user: <sub>`, `x-synapsedx-org`, `x-synapsedx-account`,
`x-synapsedx-scopes`, plus `x-synapsedx-internal` (service-to-service credential when
configured). Upstreams trust these directly without re-verifying the JWT.

## Input validation (400 on bad input)

- `email`: RFC email, ≤320 chars, auto lowercased/trimmed. `slug` (org/account/policy/role):
  `^[a-z0-9-]{1,64}$`. `displayName`: 2–200 chars.
- Policy `document`: `Statement[]` with 1–100 entries, `Effect` Allow|Deny, each
  Action/Resource pattern ≤512 chars, `Condition` ≤8KB (stored-ReDoS/DoS guard). Dry-run
  limited to 20 documents per call.
- attach/assign return 404 when the role/policy/user doesn't exist (instead of 500).
- `scopes`: 1–100 strings ≤200 chars; key `name` 1–100 chars; `expiresInSeconds`
  1–315360000; `action` ≤512, `resource` ≤2048 chars.

## Auth

- `POST /v1/auth/login {email, orgSlug}` → `{accessToken, refreshToken, user}`
  (dev sign-in; disable in production with `IAM_ALLOW_DEV_LOGIN=false`)
- `POST /v1/auth/refresh {refreshToken}` → `{accessToken, refreshToken}` (rotation: the old token is revoked)
- `POST /v1/auth/logout {refreshToken}` → `{ok}`
- `POST /v1/auth/logout-all {refreshToken}` → `{ok, revoked}` (revokes all of your own sessions)
- `GET /v1/auth/verify` (Bearer or X-API-Key) → `{valid, ...}`
- `GET /v1/auth/me` (Bearer) → `{user, kind}`
- `GET /v1/auth/oidc/config` → `{issuer, clientId, redirectUri, codeExchange, ...}`
- `GET /v1/auth/oidc/start?org=acme` → `{authorizeUrl, state}` (state is HMAC-signed, 10-minute expiry)
- `POST /v1/auth/oidc/callback {code, state}` → token set (**real** Authorization Code
  exchange: the code is redeemed at the IdP, the ID token is signature-verified against
  the IdP JWKS — asymmetric algs only, issuer + audience checked — then a shadow user
  is upserted from the verified `email`/`sub` claims)
- `POST /v1/auth/oidc/callback {email, orgSlug}` → token set (**demo** mode: trusts the
  caller-supplied email — dev only; set `IAM_ALLOW_OIDC_DEMO_CALLBACK=false` in
  production, which then requires a real IdP `code`)

## Orgs / Accounts

- `GET /v1/orgs` → `[{id, slug, display_name}]`
- `POST /v1/orgs {slug, displayName}` → org
- `GET /v1/orgs/:orgId/accounts`
- `POST /v1/orgs/:orgId/accounts {slug, displayName}`
- `GET /v1/orgs/:orgId/users` → users in the org
- `POST /v1/orgs/:orgId/users {email, displayName}`

## Roles / Policies / Authorize

- `POST /v1/accounts/:accountId/roles {slug, description}`
- `GET /v1/accounts/:accountId/roles`
- `DELETE /v1/roles/:roleId`
- `POST /v1/accounts/:accountId/policies {slug, description, document}`
- `GET /v1/accounts/:accountId/policies`
- `DELETE /v1/policies/:policyId`
- `POST /v1/roles/:roleId/attach {policyId}`
- `POST /v1/users/:userId/assign {roleId}`
- `GET /v1/users/:userId/policies`
- `POST /v1/authorize {userId, action, resource, context?}` → `{allowed, matchedBy}` (context is merged with DB-backed user/org/email)
- `POST /v1/authorize/dry-run {documents[], action, resource, context?}` → `{allowed}` (simulator, no user needed)
- `GET /v1/audit?limit=50&actor=<id>` → authorize-decision audit log (newest first, limit clamped 1..200)

## Keys

- `POST /v1/accounts/:accountId/keys {name, scopes, expiresInSeconds?}` → `{apiKey (shown once), id, prefix}`
- `POST /v1/keys/verify {apiKey}` → `{valid, account_id, scopes}`
- `DELETE /v1/keys/:id` → revokes the key

## Service accounts (machine identity)

- `POST /v1/accounts/:accountId/service-accounts {slug, description}` → service account
- `GET /v1/accounts/:accountId/service-accounts` → list
- `POST /v1/service-accounts/:id/token {scopes?}` → `{accessToken (kind=service-account), expiresIn}`

## Workflows (n8n)

- `GET /v1/templates` / `GET /v1/templates/:name`
- `GET /v1/workflows` (n8n proxy)
- `GET /v1/workflows/:id` (n8n proxy)
- `POST /v1/workflows/:id/activate` / `POST /v1/workflows/:id/deactivate` (n8n proxy)
- `POST /v1/workflows {name, template} | {name, definition}`
- `POST /v1/workflows/:id/execute {input}`
- `GET /v1/executions` (only an allowlist of query params is forwarded: `limit, offset, workflowId, status, includeData`) / `GET /v1/executions/:id`

## Health / Metrics

- `GET /health` (each service + gateway)
- `GET /ready` (gateway: aggregates iam + workflow, 503 when degraded)
- `GET /metrics` (gateway, Prometheus)

## Tracing

- The gateway assigns `x-request-id` (keeps a client-sent one), returns it in the
  response and forwards it upstream.
