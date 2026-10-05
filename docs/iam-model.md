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
- `Resource`: ARN-ish hoặc `*` (vd `arn:olp:acme:prod:workflow:etl-nightly`).
- Đánh giá: **Deny显式 thắng → Allow → mặc định Deny**.

## Token
| Loại | Định dạng | TTL mặc định | Lưu trữ |
|---|---|---|---|
| Access JWT | Bearer `eyJ...` (HS256) | 3600s | stateless, verify bằng `IAM_JWT_SECRET` |
| Refresh | `olp_rt_...` opaque | 30 ngày | SHA-256 hash trong `refresh_tokens` |
| API key | `olp_...` | tùy chọn/không hết hạn | SHA-256 hash trong `api_keys` + prefix index |

## OIDC (Authentik / Keycloak)
- `GET /v1/auth/oidc/config` — xem issuer/client.
- `GET /v1/auth/oidc/start` — dựng authorize URL.
- `POST /v1/auth/oidc/callback {email, sub, displayName, orgSlug}` — tạo shadow user + cấp token (production: exchange code bằng `openid-client` rồi lấy email từ id_token).
- Đổi sang Keycloak chỉ cần đổi `OIDC_ISSUER=https://keycloak/realms/<realm>` + client tương ứng — không đổi code.

## Ví dụ phân quyền end-to-end
```bash
ORG=$(curl -s localhost:4001/v1/orgs | jq -r '.[0].id')
ACC=$(curl -s localhost:4001/v1/orgs/$ORG/accounts | jq -r '.[0].id // empty')
# nếu chưa có account:
ACC=$(curl -s -XPOST localhost:4001/v1/orgs/$ORG/accounts -H'Content-Type: application/json' -d'{"slug":"prod","displayName":"Production"}' | jq -r .id)
ROLE=$(curl -s -XPOST localhost:4001/v1/accounts/$ACC/roles -H'Content-Type: application/json' -d'{"slug":"etl-runner"}' | jq -r .id)
POL=$(curl -s -XPOST localhost:4001/v1/accounts/$ACC/policies -H'Content-Type: application/json' -d'{"slug":"run-only","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}' | jq -r .id)
curl -XPOST localhost:4001/v1/roles/$ROLE/attach -H'Content-Type: application/json' -d"{\"policyId\":\"$POL\"}"
```
