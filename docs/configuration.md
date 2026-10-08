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
| `GATEWAY_VERIFY_APIKEY` | `false` | `true` → verify `X-API-Key` tập trung qua IAM (fail-closed 503 khi IAM chết); `false` → edge check presence, upstream verify |
| `PROXY_TIMEOUT_MS` | 30000 | timeout upstream (504 khi quá hạn) |
| `CORS_ORIGIN` | (mở hết) | `a.com,b.com` → chỉ cho origin đó (production) |
| `SYNAPSEDX_INTERNAL_SECRET` | — (dev) | credential gateway → iam/workflow (header `x-synapsedx-internal`); **phải trùng** 3 services ở production |
| `HSTS_ENABLED` | `false` | `true` → gửi `Strict-Transport-Security` (chỉ bật sau TLS) |
| ~~`RATE_LIMIT_*` / `AUTH_RATE_LIMIT_*` / `TRUST_PROXY`~~ | — | đã gỡ khỏi gateway (rate-limit ở Ingress/WAF); muốn bật lại: revert commit gỡ limiter |
| `REDIS_URL` | — (memory) | `redis://...` → rate-limit dùng Redis (share giữa replicas, fail-open khi Redis chết) |
| `GATEWAY_HOST_PORT` | 8080 | host port (compose only) |

## IAM (`packages/iam-service`)
| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4001 | cổng listen |
| `DATABASE_URL` | — (memory) | `postgres://...` → bật backend Postgres |
| `REDIS_URL` | — | dự trữ (session/ratelimit tập trung, v0.2) |
| `IAM_JWT_SECRET` | — | HS256 cho access/service JWT (≥32 ký tự); boot fail ở `NODE_ENV=production` nếu yếu/mặc định |
| `IAM_JWT_EXPIRES_IN` / `IAM_REFRESH_EXPIRES_IN` | 3600 / 2592000 (giây) | TTL token (kẹp 60–86400 / 3600–315360000; env rác → default) |
| `IAM_API_KEY_PEPPER` | — (plain SHA-256) | pepper HMAC cho hash API-key/refresh-token lúc nghỉ; key cũ vẫn verify được (fallback legacy) |
| `IAM_ALLOW_DEV_LOGIN` | `true` | `false` để tắt `POST /v1/auth/login` ở production (chỉ còn OIDC) |
| `IAM_ALLOW_OIDC_DEMO_CALLBACK` | `true` | demo callback tin email caller gửi (mạo danh được) — production **phải** `false` (khi đó yêu cầu `code` IdP thật) |
| `SYNAPSEDX_INTERNAL_SECRET` | — (dev) | yêu cầu header `x-synapsedx-internal` khớp trên mọi `/v1/*` (trừ `/v1/auth/*`) — chặn bypass trực tiếp `:4001` |
| `HSTS_ENABLED` | `false` | `true` → gửi `Strict-Transport-Security` (chỉ bật sau TLS) |
| `OIDC_PROVIDER` | `authentik` | tên hiển thị IdP (`authentik`\|`keycloak`) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | xem `.env.example` | federated OIDC (Authentik/Keycloak) |

## Workflow (`packages/workflow-service`)
| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4002 | cổng listen |
| `N8N_BASE_URL` | `http://n8n:5678` | engine n8n |
| `N8N_API_KEY` | — | API key n8n (Settings → API) |
| `IAM_SERVICE_URL` | — | dự trữ verify chéo |
| `SYNAPSEDX_INTERNAL_SECRET` | — (dev) | yêu cầu header `x-synapsedx-internal` khớp trên mọi `/v1/*` — chặn bypass trực tiếp `:4002` |
| `HSTS_ENABLED` | `false` | `true` → gửi `Strict-Transport-Security` (chỉ bật sau TLS) |

## Dữ liệu lõi / engine ngoài
Postgres (`POSTGRES_*`), n8n (`N8N_ENCRYPTION_KEY`, `N8N_HOST_PORT`),
Authentik (`AUTHENTIK_*`, host ports `AUTHENTIK_HTTP_PORT=19000`),
S3 (`S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY`, `S3_HOST_PORT=9090`).
