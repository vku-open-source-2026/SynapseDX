# IAM model — AWS-style

## Phân cấp
```
Organization (slug duy nhất toàn cục, vd `acme`)
 └─ Account (slug duy nhất trong org, vd `prod`, `staging`)
     ├─ Role (vd `admin`, `viewer`, `etl-runner`)
     ├─ Policy (JSON AWS-style, gắn vào Role qua role_policies)
     ├─ User (thuộc Org, gán Role qua user_roles — có thể cross-account)
     ├─ ApiKey (thuộc Account, hash SHA-256, prefix tra cứu)
     └─ ServiceAccount (identity cho máy)
Toàn cục: audit_log ghi mọi authorize decision (xem `GET /v1/audit`).
```

## Policy JSON
```json
{
  "Version": "2026-01-01",
  "Statement": [
    { "Effect": "Allow", "Action": ["workflow:Execute", "workflow:Read"], "Resource": "*" },
    { "Effect": "Deny", "Action": ["iam:*", "org:Delete"], "Resource": "*" }
  ]
}
```
- `Action`: `service:Verb`, hỗ trợ `*` và `prefix:*` (vd `workflow:*`, `iam:*`).
- `Resource`: ARN-ish hoặc `*` (vd `arn:synapsedx:acme:prod:workflow:etl-nightly`).
- Đánh giá: **Deny tường minh thắng → Allow → mặc định Deny**.

## Condition (subset AWS)
Statement hỗ trợ `Condition` với `StringEquals`, `StringLike` (wildcard `*`) và
biến thể `...IfExists` (bỏ qua key vắng mặt). Toán tử lạ → conservative deny.
```json
{ "Effect": "Allow", "Action": ["data:Read"], "Resource": "*",
  "Condition": { "StringEquals": { "team": "etl" } } }
```
`POST /v1/authorize` nhận thêm `context` (vd `{"team":"etl"}`); server luôn ép
`user/org/email` từ DB nên caller không thể spoof các key này. Dry-run nhận
`context` trực tiếp.

## Token
| Loại | Định dạng | TTL mặc định | Lưu trữ |
|---|---|---|---|
| Access JWT | Bearer `eyJ...` (HS256) | 3600s | stateless, verify bằng `IAM_JWT_SECRET` |
| Refresh | `synapsedx_rt_...` opaque, **xoay vòng** | 30 ngày | HMAC-SHA256 hash (với `IAM_API_KEY_PEPPER`; legacy SHA-256 vẫn verify được) trong `refresh_tokens`; dùng 1 lần, logout thu hồi |
| API key | `synapsedx_...` | tùy chọn/không hết hạn | HMAC-SHA256 hash (pepper, fallback legacy) trong `api_keys` + prefix index, `DELETE /v1/keys/:id` để thu hồi |
| Service account | Bearer JWT `kind=service-account` | 3600s | stateless, mang `account` scope |

Lưu ý: access JWT stateless nên **không thu hồi lẻ** được — giữ TTL ngắn (1h) và
thu hồi ở tầng refresh (`/v1/auth/logout`, `/v1/auth/logout-all`). Cần thu hồi
tức thì: xoay `IAM_JWT_SECRET` (restart iam+gateway, mọi JWT cũ vô hiệu).

Lưu ý hiện tại: `scopes` của API key được lưu + trả về khi verify (`/v1/keys/verify`).
Gateway mặc định chỉ check presence ở edge (upstream verify chi tiết); bật
`GATEWAY_VERIFY_APIKEY=true` để gateway verify tập trung (kèm `x-synapsedx-account`,
`x-synapsedx-scopes` xuống upstream). Enforce scope theo từng route là mục v0.2
(xem `ROADMAP.md`).

## OIDC (Authentik / Keycloak)
- `GET /v1/auth/oidc/config` — xem issuer/client.
- `GET /v1/auth/oidc/start` — dựng authorize URL.
- `POST /v1/auth/oidc/callback {email, sub, displayName, orgSlug}` — tạo shadow user + cấp token (production: exchange code bằng `openid-client` rồi lấy email từ id_token).
- Đổi sang Keycloak chỉ cần đổi `OIDC_ISSUER=https://keycloak/realms/<realm>` + client tương ứng — không đổi code.

## Ví dụ phân quyền end-to-end (qua gateway — trực tiếp :4001 cần auth, xem SECURITY.md)
```bash
GW=localhost:8080
TOK=$(curl -s -XPOST $GW/v1/auth/login -H'Content-Type: application/json' -d'{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)
H="Authorization: Bearer $TOK"
ORG=$(curl -s $GW/v1/orgs -H"$H" | jq -r '.[0].id')
ACC=$(curl -s $GW/v1/orgs/$ORG/accounts -H"$H" | jq -r '.[0].id // empty')
# nếu chưa có account:
ACC=$(curl -s -XPOST $GW/v1/orgs/$ORG/accounts -H'Content-Type: application/json' -H"$H" -d'{"slug":"prod","displayName":"Production"}' | jq -r .id)
ROLE=$(curl -s -XPOST $GW/v1/accounts/$ACC/roles -H'Content-Type: application/json' -H"$H" -d'{"slug":"etl-runner"}' | jq -r .id)
POL=$(curl -s -XPOST $GW/v1/accounts/$ACC/policies -H'Content-Type: application/json' -H"$H" -d'{"slug":"run-only","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}' | jq -r .id)
curl -XPOST $GW/v1/roles/$ROLE/attach -H'Content-Type: application/json' -H"$H" -d"{\"policyId\":\"$POL\"}"
```
