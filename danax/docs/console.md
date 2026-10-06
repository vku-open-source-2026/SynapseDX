# OLP Console (management UI)

Giao diện quản trị kiểu AWS Console cho Tier-1 PaaS: sidebar điều hướng theo
service, Org/Account switcher, CRUD IAM, authorize simulator, workflow, audit log.

- Stack: React 18 + Vite + Tailwind, phong cách BWD (Poppins, gradient
  `#4FACFE → #00F2FE`, nền `#f6f7fb`, card trắng `rounded-3xl`).
- Auth: dev login (email+org) hoặc API key, lưu localStorage. Mọi gọi API đi
  thẳng tới gateway (CORS mở mặc định) với Bearer/`X-API-Key`.

## Chạy

```bash
# cùng compose với platform (console ở :3000)
docker compose up -d --build postgres redis s3 iam workflow gateway console
# mở http://localhost:3000 → login demo@acme.local / org acme
```

Đổi cổng/host backend:
```bash
CONSOLE_HOST_PORT=13000 OLP_PUBLIC_BASE_URL=http://localhost:18080 \
GATEWAY_HOST_PORT=18080 docker compose up -d --build console gateway ...
```
`OLP_PUBLIC_BASE_URL` **phải là URL trình duyệt gọi được** (không phải tên
service docker) — container tự chèn vào `config.js` lúc khởi động
(`packages/console/docker-entrypoint.sh`).

## Dev frontend

```bash
cd packages/console
npm install
npm run dev   # :3000, proxy /api -> localhost:8080 nếu cần
```

## Trang
Dashboard (ready/metrics) · Organizations · Accounts · Users · Roles ·
Policies (JSON editor + dry-run) · API Keys · Service Accounts · Workflows
(templates + tạo trên n8n) · Authorize (simulator + authorize thật) · Audit Log.
