# Authentik — IdP mặc định (có thể thay bằng Keycloak)

Compose đã dựng `authentik-server:9000` + `authentik-worker` chung Postgres/Redis.

## Bootstrap lần đầu
1. `docker compose logs authentik-server | grep -i "initial\|admin\|password"` — lấy bootstrap credentials (Authentik in ra lần đầu).
2. Mở `http://localhost:9000`, đăng nhập admin.
3. Tạo Provider (OAuth2/OIDC):
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client ID: `olp-platform` (khớp `OIDC_CLIENT_ID`)
   - Redirect URI: `http://localhost:4001/v1/auth/oidc/callback` (khớp `OIDC_REDIRECT_URI`)
4. Tạo Application `olp`, gắn provider, lấy slug → `OIDC_ISSUER=http://localhost:9000/application/o/olp/`.
5. Điền `OIDC_CLIENT_SECRET` vào `.env`, `docker compose up -d iam`.

## Dùng Keycloak thay thế
1. Dựng Keycloak (ngoài compose hoặc thêm service).
2. Tạo realm (vd `olp`), client `olp-platform` (standard flow, redirect như trên).
3. Đổi `.env`: `OIDC_ISSUER=https://<host>/realms/olp`, `OIDC_CLIENT_ID/SECRET` tương ứng.
4. Không đổi code IAM — `GET /v1/auth/oidc/config` sẽ phản ánh issuer mới.
