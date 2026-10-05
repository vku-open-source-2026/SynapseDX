# API reference (qua Gateway :8080, hoặc trực tiếp service)

Base: `http://localhost:8080` (gateway) — mọi route `/v1/*` yêu cầu `Authorization: Bearer <JWT>` hoặc `X-API-Key`, trừ `/v1/auth/*`.

## Principal propagation (gateway → upstream)
Gateway **xóa** mọi header `x-olp-*` do client gửi (chống spoof) rồi **ghi lại từ
principal đã verify**: `x-olp-kind: user|apikey`, `x-olp-user: <sub>`,
`x-olp-org`, `x-olp-account`, `x-olp-scopes`. Upstream tin dùng trực tiếp,
không cần re-verify JWT.

## Auth
- `POST /v1/auth/login {email, orgSlug}` → `{accessToken, refreshToken, user}`
- `POST /v1/auth/refresh {refreshToken}` → `{accessToken}`
- `GET /v1/auth/verify` (Bearer hoặc X-API-Key) → `{valid, ...}`
- `GET /v1/auth/oidc/config` → `{issuer, clientId, ...}`
- `GET /v1/auth/oidc/start?org=acme` → `{authorizeUrl}`
- `POST /v1/auth/oidc/callback {email, sub, displayName, orgSlug}` → token set

## Orgs / Accounts
- `GET /v1/orgs` → `[{id, slug, display_name}]`
- `POST /v1/orgs {slug, displayName}` → org
- `GET /v1/orgs/:orgId/accounts`
- `POST /v1/orgs/:orgId/accounts {slug, displayName}`

## Roles / Policies / Authorize
- `POST /v1/accounts/:accountId/roles {slug, description}`
- `POST /v1/accounts/:accountId/policies {slug, description, document}`
- `POST /v1/roles/:roleId/attach {policyId}`
- `POST /v1/users/:userId/assign {roleId}`
- `GET /v1/users/:userId/policies`
- `POST /v1/authorize {userId, action, resource}` → `{allowed, matchedBy}`
- `POST /v1/orgs/:orgId/users {email, displayName}`

## Keys
- `POST /v1/accounts/:accountId/keys {name, scopes, expiresInSeconds?}` → `{apiKey (hiện 1 lần), id, prefix}`
- `POST /v1/keys/verify {apiKey}` → `{valid, account_id, scopes}`

## Service accounts (machine identity)
- `POST /v1/accounts/:accountId/service-accounts {slug, description}` → service account
- `GET /v1/accounts/:accountId/service-accounts` → list
- `POST /v1/service-accounts/:id/token {scopes?}` → `{accessToken (kind=service-account), expiresIn}`

## Workflows (n8n)
- `GET /v1/templates` / `GET /v1/templates/:name`
- `GET /v1/workflows` (proxy n8n)
- `POST /v1/workflows {name, template} | {name, definition}`
- `POST /v1/workflows/:id/execute {input}`
- `GET /v1/executions`

## Health / Metrics
- `GET /health` (mỗi service + gateway)
- `GET /metrics` (gateway, Prometheus)
