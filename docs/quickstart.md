# Quickstart

## 1. Yêu cầu
Docker 24+, Docker Compose v2, 4GB RAM trống. Không cần Node/Python để chạy platform (chỉ cần để dev SDK).

## 2. Chạy
```bash
cp .env.example .env
# đổi các secret *_change_me_* trong .env
docker compose up --build -d
docker compose ps
curl localhost:8080/health      # gateway
curl localhost:4001/health      # iam
curl localhost:4002/health      # workflow
```

## 3. Luồng đầu tiên (dev login → org → key → workflow)
```bash
# login
TOK=$(curl -s -XPOST localhost:8080/v1/auth/login -H'Content-Type: application/json' -d'{"email":"demo@acme.local","orgSlug":"acme"}' | tee /tmp/login.json | jq -r .accessToken)
echo $TOK
curl -s localhost:8080/v1/orgs -H"Authorization: Bearer $TOK" | jq
# templates workflow
curl -s localhost:8080/v1/templates -H"Authorization: Bearer $TOK" | jq
```

## 4. Authentik (IdP mặc định)
- Mở `http://localhost:9000` (user/pass bootstrap trong log `authentik-server`), tạo Provider `olp` + Application, lấy `OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET` điền vào `.env`, restart `iam`.
- Muốn dùng Keycloak thay thế: dựng Keycloak, tạo realm+client, đổi `OIDC_ISSUER` thành `https://<keycloak>/realms/<realm>` — IAM không đổi code.

## 5. N8N
- Mở `http://localhost:5678`, tạo owner account, vào Settings → API → tạo API key → điền `N8N_API_KEY` vào `.env`, restart `workflow`.
- Tạo workflow từ template: `POST /v1/workflows {"template":"webhook-to-log","name":"demo"}`.

## 6. MinIO
- Console `http://localhost:9001`, S3 endpoint `http://localhost:9000`, bucket `olp-core` (tạo lần đầu qua console hoặc `mc`).

## 7. Dừng
```bash
docker compose down        # giữ data
docker compose down -v     # xóa sạch data
```
