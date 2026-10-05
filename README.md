# OLP — Open Layer Platform (Tier-1 PaaS, open source)

Apache-2.0 open-source PaaS core: **API Gateway + IAM (AWS-style) + core data + n8n workflows + SDKs**.

![ci](https://github.com/olp/olp/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![sdk-js](https://img.shields.io/badge/sdk-JS%2FTS-green)
![sdk-py](https://img.shields.io/badge/sdk-Python-green)

> **Tầng 1 = PaaS**: điểm vào duy nhất (gateway), quản trị truy cập (IAM), cụm dữ liệu lõi, workflow. Không lock-in: Authentik/Keycloak và n8n chạy như engine ngoài qua OIDC/REST.

## Tính chất open source (thỏa mãn)
- **Giấy phép permissive**: `LICENSE` Apache-2.0 cho platform + mọi SDK; `NOTICE` ghi nhận third-party.
- **Phát triển công khai**: monorepo, Conventional Commits, PR template, CI (`ci.yml`) + release (`release.yml`), `CHANGELOG.md`.
- **Tài liệu mở**: `docs/` (architecture, iam-model, api, quickstart, object-storage, troubleshooting) + `README.md` này.
- **Đóng góp mở**: `CONTRIBUTING.md` (DCO sign-off), `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, `ROADMAP.md`.
- **Build tái lập**: `Dockerfile` mỗi service, `docker-compose.yml` pin image, `infra/k8s` Kustomize, `.env.example`.
- **Không fork license lạ**: n8n/Authentik dùng như container ngoài, gọi qua API/OIDC — code OLP vẫn thuần Apache-2.0.

## Kiến trúc (xem `docs/architecture.md`)
```
Client → Gateway :8080 ─┬─► IAM :4001 (Org/Account/Role/Policy + token + OIDC Authentik/Keycloak)
                        └─► Workflow :4002 ─► n8n :5678
                        Postgres :5432 / Redis :6379 / S3 (S3Mock) :9090
```

## Chạy trong 3 lệnh
```bash
cp .env.example .env        # rồi đổi các secret *_change_me_*
docker compose up --build -d
curl localhost:8080/health && curl localhost:4001/health && curl localhost:4002/health
```
Chi tiết: `docs/quickstart.md`. API: `docs/api.md`. Mô hình phân quyền: `docs/iam-model.md`. Mục lục: `docs/README.md`.

## Repo layout
```
packages/gateway           API gateway (proxy, JWT/API-key, principal x-olp-*, rate-limit, /metrics)
packages/iam-service       IAM AWS-style + token/SA + authorize/simulator + OIDC (Authentik/Keycloak)
packages/workflow-service  control-plane n8n (proxy + templates)
packages/sdk-js            @olp/sdk (TypeScript)
packages/sdk-python        olp-sdk (Python)
packages/sdk-go            olp-sdk-go (Go, minimal)
infra/postgres/init.sql    schema lõi (orgs/accounts/users/roles/policies/keys/...)
infra/k8s/base             Kustomize cho K8s
examples/quickstart        script demo end-to-end
examples/n8n-templates     workflow JSON mẫu
tests/e2e                  smoke test (sh/ps1) + SDK live check
docs                       architecture/iam-model/api/quickstart/object-storage/troubleshooting
```

## SDK nhanh
```ts
// JS/TS
import { OlpClient } from '@olp/sdk';
const c = new OlpClient({ baseUrl: 'http://localhost:8080' });
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
```
```python
# Python
from olp_sdk import OlpClient
c = OlpClient("http://localhost:8080")
login = c.login("demo@acme.local"); c.token = login["accessToken"]
print(c.list_orgs())
```
```go
// Go
c := olp.New("http://localhost:8080")
out, _ := c.Login("demo@acme.local")
```

## Cấu hình IdP (Access Management)
- Mặc định **Authentik** (nội bộ `authentik-server:9000`, ngoài máy `http://localhost:19000`), xem `infra/authentik/README.md`.
- Thích **Keycloak**? Chỉ đổi `OIDC_ISSUER=https://<keycloak>/realms/<realm>` + client id/secret — IAM giữ nguyên (federated OIDC, shadow user + phân quyền nội bộ).

## Lệnh hay dùng
| Lệnh | Ý nghĩa |
|---|---|
| `make bootstrap` | copy .env + npm install |
| `make build` / `make test` | build/test toàn monorepo |
| `make compose-up` / `make compose-down` | chạy/dừng platform |
| `bash tests/e2e/smoke.sh` | smoke test gateway+iam+workflow |

## Contributing / Security / License
- Đóng góp: `CONTRIBUTING.md`. Ứng xử: `CODE_OF_CONDUCT.md`. Quản trị: `GOVERNANCE.md`. Lộ trình: `ROADMAP.md`.
- Bảo mật: `SECURITY.md` (không mở issue công khai cho lỗ hổng).
- Giấy phép: Apache-2.0 (`LICENSE`), third-party: (`NOTICE`).
