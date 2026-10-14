# K8s deployment (Kustomize)

```bash
# 1. Create real secrets from the example (NEVER commit the filled-in file):
cp infra/k8s/base/secrets.example.yaml /tmp/synapsedx-secrets.yaml
# ... fill secrets into /tmp/synapsedx-secrets.yaml ...
kubectl apply -f /tmp/synapsedx-secrets.yaml

# 2. Deploy:
kubectl apply -k infra/k8s/base
kubectl -n synapsedx get pods,svc

# 3. Open the gateway (port-forward until you have an ingress):
kubectl -n synapsedx port-forward svc/gateway 8080:80
curl localhost:8080/health
```

Notes:
- `all.yaml` holds the Namespace + Deployments/Services for `iam`, `gateway`, `workflow`, `ai`, `console`. Postgres/Redis/object-storage(S3)/n8n/Authentik use each engine's own chart/manifests.
- Required secrets (`synapsedx-secrets`): `database-url`, `iam-jwt-secret` (gateway + IAM **identical**),
  `oidc-client-secret`, `n8n-api-key`, `ai-api-key`, `internal-secret` (gateway + IAM + workflow + ai identical),
  `api-key-pepper`. Replace the `console`/`gateway` placeholders (`console.example.com`, `gateway.example.com`) with your real domains.
- Production: add Ingress + TLS, HPA, PDB, resource limits, and manage secrets with SealedSecrets/External Secrets.
