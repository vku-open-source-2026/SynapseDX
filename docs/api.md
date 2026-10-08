# API reference (qua Gateway :8080, hoặc trực tiếp service)

Base: `http://localhost:8080` (gateway) — mọi route `/v1/*` yêu cầu `Authorization: Bearer <JWT>` hoặc `X-API-Key`, trừ `/v1/auth/*`.
Gọi **trực tiếp** `:4001`/`:4002` (bypass gateway) cần thêm `x-synapsedx-internal: <SYNAPSEDX_INTERNAL_SECRET>`
khi secret đã cấu hình (production), ngược lại 401 — xem `SECURITY.md`.

## Principal propagation (gateway → upstream)
Gateway **xóa** mọi header `x-synapsedx-*` do client gửi (chống spoof) rồi **ghi lại từ
principal đã verify**: `x-synapsedx-kind: user|apikey`, `x-synapsedx-user: <sub>`,
`x-synapsedx-org`, `x-synapsedx-account`, `x-synapsedx-scopes`, cộng
`x-synapsedx-internal` (service-to-service credential khi đã cấu hình).
Upstream tin dùng trực tiếp, không cần re-verify JWT.

## Input validation (400 khi sai)
- `email`: RFC email, ≤320 ký tự, tự lowercase/trim. `slug` (org/account/policy/role):
  `^[a-z0-9-]{1,64}$`. `displayName`: 2–200 ký tự.
- Policy `document`: `Statement[]` 1–100 entries, `Effect` Allow|Deny, mỗi pattern
  Action/Resource ≤512 ký tự, `Condition` ≤8KB (chống stored-ReDoS/DoS). Dry-run giới
  hạn 20 documents/lần.
- attach/assign trả 404 khi role/policy/user không tồn tại (thay vì 500).
- `scopes`: 1–100 strings ≤200 ký tự; key `name` 1–100 ký tự; `expiresInSeconds`
  1–315360000; `action` ≤512, `resource` ≤2048 ký tự.

## Auth
- `POST /v1/auth/login {email, orgSlug}` → `{accessToken, refreshToken, user}`
- `POST /v1/auth/refresh {refreshToken}` → `{accessToken, refreshToken}` (xoay vòng: token cũ bị thu hồi)
- `POST /v1/auth/logout {refreshToken}` → `{ok}`
- `POST /v1/auth/logout-all {refreshToken}` → `{ok, revoked}` (thu hồi mọi session của chính mình)
- `GET /v1/auth/verify` (Bearer hoặc X-API-Key) → `{valid, ...}`
- `GET /v1/auth/me` (Bearer) → `{user, kind}`
- `GET /v1/auth/oidc/config` → `{issuer, clientId, ...}`
- `GET /v1/auth/oidc/start?org=acme` → `{authorizeUrl}`
- `POST /v1/auth/oidc/callback {email, sub, displayName, orgSlug}` → token set
  (chế độ **demo**: tin email caller gửi — dev-only; production set
  `IAM_ALLOW_OIDC_DEMO_CALLBACK=false`, khi đó yêu cầu `code` IdP thật)

## Orgs / Accounts
- `GET /v1/orgs` → `[{id, slug, display_name}]`
- `POST /v1/orgs {slug, displayName}` → org
- `GET /v1/orgs/:orgId/accounts`
- `POST /v1/orgs/:orgId/accounts {slug, displayName}`
- `GET /v1/orgs/:orgId/users` → users trong org
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
- `POST /v1/authorize {userId, action, resource, context?}` → `{allowed, matchedBy}` (context hợp nhất với user/org/email từ DB)
- `POST /v1/authorize/dry-run {documents[], action, resource, context?}` → `{allowed}` (simulator, không cần user)
- `GET /v1/audit?limit=50&actor=<id>` → audit log authorize decisions (mới nhất trước, limit kẹp 1..200)

## Keys
- `POST /v1/accounts/:accountId/keys {name, scopes, expiresInSeconds?}` → `{apiKey (hiện 1 lần), id, prefix}`
- `POST /v1/keys/verify {apiKey}` → `{valid, account_id, scopes}`
- `DELETE /v1/keys/:id` → thu hồi key

## Service accounts (machine identity)
- `POST /v1/accounts/:accountId/service-accounts {slug, description}` → service account
- `GET /v1/accounts/:accountId/service-accounts` → list
- `POST /v1/service-accounts/:id/token {scopes?}` → `{accessToken (kind=service-account), expiresIn}`

## Workflows (n8n)
- `GET /v1/templates` / `GET /v1/templates/:name`
- `GET /v1/workflows` (proxy n8n)
- `GET /v1/workflows/:id` (proxy n8n)
- `POST /v1/workflows/:id/activate` / `POST /v1/workflows/:id/deactivate` (proxy n8n)
- `POST /v1/workflows {name, template} | {name, definition}`
- `POST /v1/workflows/:id/execute {input}`
- `GET /v1/executions` (chỉ forward query allowlist: `limit, offset, workflowId, status, includeData`) / `GET /v1/executions/:id`

## Health / Metrics
- `GET /health` (mỗi service + gateway)
- `GET /ready` (gateway: aggregate iam + workflow, 503 khi degraded)
- `GET /metrics` (gateway, Prometheus)

## Tracing
- Gateway tự gán `x-request-id` (giữ lại nếu client đã gửi), trả về trong
  response và forward tới upstream.
