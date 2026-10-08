# K8s deployment (Kustomize)

```bash
# 1. Tạo secret thật từ ví dụ (KHÔNG commit file đã điền):
cp infra/k8s/base/secrets.example.yaml /tmp/synapsedx-secrets.yaml
# ... điền secret vào /tmp/synapsedx-secrets.yaml ...
kubectl apply -f /tmp/synapsedx-secrets.yaml

# 2. Deploy:
kubectl apply -k infra/k8s/base
kubectl -n synapsedx get pods,svc

# 3. Mở gateway (port-forward khi chưa có ingress):
kubectl -n synapsedx port-forward svc/gateway 8080:80
curl localhost:8080/health
```

Ghi chú:
- `all.yaml` chứa Namespace + Deployments/Services cho `iam`, `gateway`, `workflow`, `console`. Postgres/Redis/object-storage(S3)/n8n/Authentik dùng chart/manifest riêng của từng engine.
- Secrets bắt buộc (`synapsedx-secrets`): `database-url`, `iam-jwt-secret` (gateway + IAM **trùng nhau**),
  `oidc-client-secret`, `n8n-api-key`, `internal-secret` (gateway + IAM + workflow trùng nhau),
  `api-key-pepper`. Đổi `console`/`gateway` placeholder (`console.example.com`, `gateway.example.com`) theo domain thật.
- Production: thêm Ingress + TLS, HPA, PDB, resource limits, và quản lý secret bằng SealedSecrets/External Secrets.
