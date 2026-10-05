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
- Lần đầu pull hơi lâu (n8n, authentik). Muốn nhẹ: `docker compose up -d --build
  postgres redis s3 s3-init iam workflow gateway` (n8n vẫn tự lên theo
  `depends_on` của `workflow`; authentik thì không — chỉ lên khi gọi tên).
- Host port bận? Đổi `GATEWAY_HOST_PORT` (+ `*_HOST_PORT`) trong `.env` — xem `docs/troubleshooting.md`.
- Windows: dùng `examples/quickstart/demo.ps1` (tương đương `demo.sh`).

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
- Mở `http://localhost:19000` (host port `AUTHENTIK_HTTP_PORT`; user/pass bootstrap trong log `authentik-server`), tạo Provider `olp` + Application, lấy `OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET` điền vào `.env`, restart `iam`.
- Muốn dùng Keycloak thay thế: dựng Keycloak, tạo realm+client, đổi `OIDC_ISSUER` thành `https://<keycloak>/realms/<realm>` — IAM không đổi code.

## 5. N8N
- Mở `http://localhost:5678`, tạo owner account, vào Settings → API → tạo API key → điền `N8N_API_KEY` vào `.env`, restart `workflow`.
- Tạo workflow từ template: `POST /v1/workflows {"template":"webhook-to-log","name":"demo"}`.
- Script headless (đã kiểm chứng với n8n 1.66):
  ```bash
  curl -XPOST localhost:5678/rest/owner/setup -H'Content-Type: application/json' \
    -d'{"email":"owner@acme.local","firstName":"OLP","lastName":"Owner","password":"<STR0NG>"}'
  # login (cookie) rồi tạo API key:
  curl -c jar -XPOST localhost:5678/rest/login -H'Content-Type: application/json' \
    -d'{"email":"owner@acme.local","password":"<STR0NG>"}'
  curl -b jar -XPOST localhost:5678/rest/api-keys -H'Content-Type: application/json' \
    -d'{"label":"olp"}'   # → data.apiKey
  ```
  Lưu ý: n8n đặt cookie `Secure` nên flow cookie chỉ chạy trên http khi
  `N8N_SECURE_COOKIE=false` (local dev); sau TLS-terminating proxy giữ mặc định.
  Flow API key (`X-N8N-API-KEY`, cách `workflow-service` gọi n8n) không cần cookie.

## 6. Object storage (S3)
- S3 endpoint `http://localhost:9090` (S3Mock, S3-compatible), bucket `olp-core` tự tạo bởi service `s3-init`.
- Kiểm tra: `aws --endpoint-url http://localhost:9090 s3 ls` (access key trong `.env`: `S3_ACCESS_KEY/S3_SECRET_KEY`).
- Production: đổi sang MinIO (`quay.io/minio/minio`) hoặc AWS S3 bằng cách thay service `s3` + `S3_ENDPOINT` — SDK/API không đổi vì đều nói S3.

## 7. Dừng
```bash
docker compose down        # giữ data
docker compose down -v     # xóa sạch data
```
