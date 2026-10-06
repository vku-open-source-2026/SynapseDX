# K8s deployment (Kustomize)

```bash
# 1. Tạo secret thật từ ví dụ (KHÔNG commit file đã điền):
cp infra/k8s/base/secrets.example.yaml /tmp/danax-secrets.yaml
# ... điền secret vào /tmp/danax-secrets.yaml ...
kubectl apply -f /tmp/danax-secrets.yaml

# 2. Deploy:
kubectl apply -k infra/k8s/base
kubectl -n danax get pods,svc

# 3. Mở gateway (port-forward khi chưa có ingress):
kubectl -n danax port-forward svc/gateway 8080:80
curl localhost:8080/health
```

Ghi chú:
- `all.yaml` chứa Namespace + Deployments/Services cho `iam`, `gateway`, `workflow`. Postgres/Redis/object-storage(S3)/n8n/Authentik dùng chart/manifest riêng của từng dự án (không bake vào đây để dễ nâng cấp).
- Production: thêm Ingress + TLS, HPA, PDB, resource limits, và quản lý secret bằng SealedSecrets/External Secrets.
