# Troubleshooting

## Port đã có tiến trình khác dùng (EADDRINUSE / Bind for ... failed)
Máy dev thường đã chạy sẵn service (ví dụ một web chiếm `:8080`, Postgres chiếm `:5432`).
OLP không gán cứng host port — đổi qua env trong `.env`:

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
Kiểm tra `packages/gateway/routes.yaml` có prefix đó không (gateway match theo longest-prefix, xem `docs/api.md`).
Nếu tự sửa gateway: **không** `app.use(path, proxy)` + gán lại `req.url` — Express giữ bookkeeping `slashAdded/removed`, gán tay sẽ làm URL thành rác với exact-path. Dùng `pathFilter` của http-proxy-middleware v3 + mount ở root (xem code `packages/gateway/src/index.ts`).

## IAM báo `db=memory` trong khi muốn Postgres
`DATABASE_URL` chưa tới được container. Trong compose, `DATABASE_URL` trỏ `postgres:5432` (tên service). Khi chạy IAM ngoài docker (dev local), set:
`DATABASE_URL=postgres://olp:<pw>@localhost:<HOST_PORT>/olp`.

## Authentik không lên
`authentik-postgres-init` phải chạy xong trước (tạo user/db `authentik`). Xem log:
`docker compose logs authentik-postgres-init authentik-server`. Lần đầu lấy bootstrap admin password trong log `authentik-server`.

## Backup / restore Postgres (cụm dữ liệu lõi)
```bash
docker compose exec postgres pg_dump -U olp olp > olp-$(date +%F).sql
cat olp-2026-10-06.sql | docker compose exec -T postgres psql -U olp -d olp
```

## n8n báo lỗi API
`workflow-service` cần `N8N_API_KEY` (tạo trong n8n Settings → API sau khi lập owner account). Khi chưa có key, `GET /v1/templates` (built-in) vẫn chạy — chỉ proxy sang n8n mới lỗi.
