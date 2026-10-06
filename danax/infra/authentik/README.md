# Authentik — IdP mặc định (có thể thay bằng Keycloak)

Compose đã dựng `authentik-server:9000` + `authentik-worker` chung Postgres/Redis.

## Bootstrap lần đầu
1. Đăng nhập `http://localhost:19000` bằng `akadmin` (xem mật khẩu bên dưới),
   rồi **đổi mật khẩu ngay** (user menu → Change password).
2. Tạo Provider (OAuth2/OIDC):
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client ID: `olp-platform` (khớp `OIDC_CLIENT_ID`)
   - Redirect URI: `http://localhost:4001/v1/auth/oidc/callback` (khớp `OIDC_REDIRECT_URI`)
4. Tạo Application `olp`, gắn provider, lấy slug → `OIDC_ISSUER=http://localhost:19000/application/o/olp/` cho browser, nhưng trong mạng docker IAM dùng `OIDC_ISSUER=http://authentik-server:9000/application/o/olp/`.
5. Điền `OIDC_CLIENT_SECRET` vào `.env`, `docker compose up -d iam`.

> Ghi chú deploy: image Authentik không in password bootstrap ra log, nên
> password `akadmin` được đặt trực tiếp qua DB lúc dựng (Django PBKDF2):
> `akadmin / OlpAdmin123!` — đổi ngay sau khi vào. Đặt lại khi cần bằng UPDATE
> bảng `authentik_core_user` hoặc flow recovery của Authentik.

## Đã provision sẵn trên deployment này (không cần làm lại)
- Provider OAuth2/OIDC `olp` (`client_id=olp-platform`, implicit-consent flow,
  redirect `http://localhost:4001/v1/auth/oidc/callback`) + Application `olp`.
- Discovery: `http://localhost:19000/application/o/olp/.well-known/openid-configuration`
- API token bootstrap tạm đã thu hồi sau khi provision (xóa khỏi DB, key cũ 403).
- `N8N_SECURE_COOKIE=false` trong compose cho dev http (cookie `Secure` làm rớt
  session/API automation qua http; production sau TLS đặt `true`).

## Dùng Keycloak thay thế
1. Dựng Keycloak (ngoài compose hoặc thêm service).
2. Tạo realm (vd `olp`), client `olp-platform` (standard flow, redirect như trên).
3. Đổi `.env`: `OIDC_ISSUER=https://<host>/realms/olp`, `OIDC_CLIENT_ID/SECRET` tương ứng.
4. Không đổi code IAM — `GET /v1/auth/oidc/config` sẽ phản ánh issuer mới.
