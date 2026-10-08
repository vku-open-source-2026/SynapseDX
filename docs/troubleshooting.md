# Troubleshooting

## Port đã có tiến trình khác dùng (EADDRINUSE / Bind for ... failed)
Máy dev thường đã chạy sẵn service (ví dụ một web chiếm `:8080`, Postgres chiếm `:5432`).
synapsedx không gán cứng host port — đổi qua env trong `.env`:

| Env | Mặc định | Dịch vụ |
|---|---|---|
| `GATEWAY_HOST_PORT` | 8080 | gateway |
| `IAM_HOST_PORT` | 4001 | iam |
| `WORKFLOW_HOST_PORT` | 4002 | workflow |
| `N8N_HOST_PORT` | 5678 | n8n |
| `AUTHENTIK_HTTP_PORT` / `AUTHENTIK_HTTPS_PORT` | 19000 / 19443 | authentik |

```bash
GATEWAY_HOST_PORT=18080 docker compose up --build -d
```
Port **nội bộ** container (4001/4002/8080/...) giữ nguyên — các service gọi nhau qua tên service docker (`http://iam:4001`), không qua host port.

## Windows: curl.exe với JSON single-quote
`curl.exe` trên Windows không hiểu nháy đơn như bash. Sai:
`curl -d '{"email":"a@a"}'` → gửi kèm cả dấu `'` → IAM báo `SyntaxError ... position 1`.
Đúng (PowerShell): dùng `Invoke-RestMethod`, hoặc escape nháy kép:
`curl.exe -d "{\"email\":\"a@a\"}"`. Xem `examples/quickstart/demo.ps1` và `tests/e2e/smoke.ps1`.

## Gateway trả 404 `No gateway route matched` cho route đã khai báo
Kiểm tra `apps/gateway/routes.yaml` có prefix đó không (gateway match theo longest-prefix, xem `docs/api.md`).
Nếu tự sửa gateway: **không** `app.use(path, proxy)` + gán lại `req.url` — Express giữ bookkeeping `slashAdded/removed`, gán tay sẽ làm URL thành rác với exact-path. Dùng `pathFilter` của http-proxy-middleware v3 + mount ở root (xem code `apps/gateway/src/index.ts`).

## IAM báo `db=memory` trong khi muốn Postgres
`DATABASE_URL` chưa tới được container. Trong compose, `DATABASE_URL` trỏ `postgres:5432` (tên service). Khi chạy IAM ngoài docker (dev local), set:
`DATABASE_URL=postgres://synapsedx:<pw>@localhost:<HOST_PORT>/synapsedx`.

## Authentik không lên
`authentik-postgres-init` phải chạy xong trước (tạo user/db `authentik`). Xem log:
`docker compose logs authentik-postgres-init authentik-server`. Lần đầu lấy bootstrap admin password trong log `authentik-server`.

## Backup / restore Postgres (cụm dữ liệu lõi)
```bash
docker compose exec postgres pg_dump -U synapsedx synapsedx > synapsedx-$(date +%F).sql
cat synapsedx-2026-10-06.sql | docker compose exec -T postgres psql -U synapsedx -d synapsedx
```

## n8n báo lỗi API
`workflow-service` cần `N8N_API_KEY` (tạo trong n8n Settings → API sau khi lập owner account). Khi chưa có key, `GET /v1/templates` (built-in) vẫn chạy — chỉ proxy sang n8n mới lỗi.

## 401 `Missing or invalid internal credential` gọi trực tiếp :4001/:4002
`SYNAPSEDX_INTERNAL_SECRET` đã cấu hình thì IAM/workflow chỉ chấp nhận traffic qua
gateway (header `x-synapsedx-internal`). Gọi trực tiếp service phải kèm header đó,
hoặc gọi qua gateway `:8080`. Kiểm tra 3 services dùng **cùng** giá trị secret.

## 401 `unauthorized` dù token còn hạn
Gateway và IAM **phải trùng** `IAM_JWT_SECRET` (K8s: cả 2 Deployment đều mount
`iam-jwt-secret`). Lệch secret → mọi Bearer đều rớt verify. Trong `NODE_ENV=production`
service từ chối boot luôn nếu secret yếu/mặc định — đọc log startup.

## 502 `bad_gateway` / 504 khi gọi workflows, executions
Upstream n8n chưa chạy hoặc `N8N_BASE_URL` sai: 502 JSON ngay (kèm log
`[gateway] proxy ... failed`), treo quá `PROXY_TIMEOUT_MS` thì 504. Kiểm tra
`docker compose ps n8n` và `/ready` của gateway.

## 400 `invalid_body` / `invalid_slug` / `invalid_document`
Validation mới (xem `docs/api.md`): email RFC ≤320 ký tự; slug `^[a-z0-9-]{2,64}$`;
policy document `Statement[]` 1–100, pattern ≤512 ký tự. CLI/SDK cũ tự build path
thủ công có thể gửi slug sai — dùng SDK/CLI mới (đã `encodeURIComponent` mọi id).
