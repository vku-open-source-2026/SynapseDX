# Architecture — synapsedx Tier-1 PaaS

```
                    ┌─────────────┐   OIDC    ┌──────────────┐
                    │  Authentik  │◄─────────►│   Keycloak   │  (chọn 1, ngoài cụm)
                    │  (mặc định) │   (alt)   │  (tương thích)│
                    └──────┬──────┘           └──────────────┘
                           │ sub/email
                    ┌──────▼──────────────────────────────────┐
                    │ IAM service (:4001)                     │
                    │ Org→Account→User→Role→Policy (AWS-style)│
                    │ token: JWT + refresh + API key + SA     │
                    │ Postgres (bảng orgs/accounts/...)       │
                    └──────┬──────────────────────┬───────────┘
                           │ verify                │ authorize()
              ┌────────────▼────────┐    ┌─────────▼───────────┐
              │ Gateway (:8080)     │    │ Workflow svc (:4002) │
              │ proxy + JWT/API key │───►│ proxy n8n + template│
              │ rate-limit + metrics│    │                     │
              └────────────┬────────┘    └─────────┬───────────┘
                           │                     │ REST
                    ┌───────▼───────┐      ┌──────▼──────┐
                    │ Postgres/Redis│      │  N8N (:5678) │
                    │ S3Mock (S3)   │      │  engine ngoài│
                    └───────────────┘      └─────────────┘
```

## Tầng 1 = PaaS
- **API Gateway**: điểm vào duy nhất, xác thực (JWT/API key), strip + ghi lại header `x-synapsedx-*` từ principal đã verify (chống spoof), rate-limit (Redis khi có `REDIS_URL`, fail-open), định tuyến theo `routes.yaml`, metrics Prometheus.
- **Access Management (IAM)**: mô hình AWS — Organization (như AWS Organization), Account (như AWS Account), User/Role/Policy JSON (như IAM policy), `POST /v1/authorize` đánh giá Allow/Deny. Authentik/Keycloak chỉ làm IdP federated qua OIDC; IAM giữ shadow user + toàn bộ phân quyền.
- **Token**: JWT ngắn hạn (Bearer), refresh token xoay vòng (opaque, hash trong DB), API key dài hạn kiểu `synapsedx_...` (hash + prefix), service account cho workload.
- **Cụm dữ liệu lõi**: Postgres 16 (source of truth), Redis (cache/rate-limit/session), S3Mock (object storage S3-compatible, bucket `synapsedx-core`; production đổi sang MinIO/S3 thật qua `S3_ENDPOINT`).
- **Workflow**: n8n là engine ngoài (SUL, không fork), `workflow-service` là control-plane: proxy API, template versioned, execute.

## Quyết định kỹ thuật
- Node 20 + TypeScript cho cả 3 service để dễ đóng góp; Postgres driver `pg`, không ORM để SQL minh bạch.
- Gateway dùng `http-proxy-middleware`, xác thực nhẹ tại edge + verify sâu tại IAM (`/v1/auth/verify`).
- Mọi secret qua env; không hardcode. Compose healthcheck đầy đủ.
- SDK mỏng, fetch/requests/net-http, không phụ thuộc nặng.
