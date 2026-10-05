# Configuration (env reference)

Copy `.env.example` → `.env`, đổi mọi giá trị `*_change_me_*`. Chỉ service nào
đọc key nào (audited từ source):

## Gateway (`packages/gateway`)
| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` (fallback `GATEWAY_PORT`) | 8080 | cổng listen (trong container) |
| `IAM_SERVICE_URL` | `http://iam:4001` | upstream IAM |
| `WORKFLOW_SERVICE_URL` | `http://workflow:4002` | upstream workflow |
| `IAM_JWT_SECRET` | — | **phải trùng** IAM để verify Bearer |
| `GATEWAY_ROUTES_PATH` | `./routes.yaml` | bảng định tuyến |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | 60000 / 300 | rate limit |
| `GATEWAY_HOST_PORT` | 8080 | host port (compose only) |

## IAM (`packages/iam-service`)
| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4001 | cổng listen |
| `DATABASE_URL` | — (memory) | `postgres://...` → bật backend Postgres |
| `REDIS_URL` | — | dự trữ (session/ratelimit tập trung, v0.2) |
| `IAM_JWT_SECRET` | — | HS256 cho access/service JWT (≥32 ký tự) |
| `IAM_JWT_EXPIRES_IN` / `IAM_REFRESH_EXPIRES_IN` | 3600 / 2592000 (giây) | TTL token |
| `OIDC_PROVIDER` | `authentik` | tên hiển thị IdP (`authentik`\|`keycloak`) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | xem `.env.example` | federated OIDC (Authentik/Keycloak) |

## Workflow (`packages/workflow-service`)
| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4002 | cổng listen |
| `N8N_BASE_URL` | `http://n8n:5678` | engine n8n |
| `N8N_API_KEY` | — | API key n8n (Settings → API) |
| `IAM_SERVICE_URL` | — | dự trữ verify chéo |

## Dữ liệu lõi / engine ngoài
Postgres (`POSTGRES_*`), n8n (`N8N_ENCRYPTION_KEY`, `N8N_HOST_PORT`),
Authentik (`AUTHENTIK_*`, host ports `AUTHENTIK_HTTP_PORT=19000`),
S3 (`S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY`, `S3_HOST_PORT=9090`).
