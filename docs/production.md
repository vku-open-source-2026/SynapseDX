# Production checklist (Tier-1 PaaS)

Dùng khi đưa OLP ra khỏi laptop. Mọi mục đều có sẵn cơ chế — chỉ cần bật.

## 1. Secret & auth
- [ ] Đổi **mọi** `*_change_me_*` trong `.env` (`IAM_JWT_SECRET` ≥ 32 ký tự ngẫu nhiên).
- [ ] `IAM_ALLOW_DEV_LOGIN=false` (chỉ còn OIDC).
- [ ] `GATEWAY_VERIFY_APIKEY=true` nếu client dùng API key (verify tập trung, fail-closed).
- [ ] Authentik/Keycloak chạy sau TLS; `OIDC_ISSUER` dùng URL https nội bộ đúng.
- [ ] Secret K8s qua SealedSecrets/External Secrets, **không** commit file đã điền
      (xem `infra/k8s/base/secrets.example.yaml`).

## 2. Mạng & TLS
- [ ] Gateway là điểm vào duy nhất (Ingress + TLS); IAM/workflow/n8n/postgres/redis
      không expose ra internet (ClusterIP / compose network nội bộ).
- [ ] Siết CORS của gateway theo origin frontend thật (mặc định mở hết cho MVP).
- [ ] Rate limit: rà `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` theo tải; Redis
      (`REDIS_URL`) để share giữa replicas.
- [ ] `PROXY_TIMEOUT_MS` theo SLA upstream (mặc định 30s).

## 3. Dữ liệu
- [ ] Postgres: volume bền + backup định kỳ (`pg_dump`, xem `docs/troubleshooting.md`).
- [ ] Object storage: đổi S3Mock → MinIO/S3 thật (`docs/object-storage.md`).
- [ ] Redis AOF đã bật trong compose; K8s dùng chart redis có persistence.

## 4. Vận hành
- [ ] Healthcheck/compose `depends_on healthy` đã có; K8s có liveness/readiness
      (xem `infra/k8s/base/all.yaml`). Cảnh báo khi `/ready` → 503.
- [ ] Pin image digest cho release (`olp/*:0.1.0` → digest), không dùng `latest` cho engine ngoài.
- [ ] Log tập trung (json-file driver mặc định; chuyển Loki/ELK khi cần) + giữ `x-request-id`.
- [ ] Định kỳ `npm audit`, theo dõi advisory đã ghi nhận trong `SECURITY.md`.

## 5. Nâng cấp
- [ ] Đọc `CHANGELOG.md` + `ROADMAP.md` trước khi lên tag mới; chạy
      `tests/e2e/api-check.sh` sau mỗi lần nâng cấp.
