# K8s deployment (Kustomize)

```bash
# 1. Create real secrets from the example (NEVER commit the filled-in file):
cp infra/k8s/base/secrets.example.yaml /tmp/synapseone-secrets.yaml
# ... fill secrets into /tmp/synapseone-secrets.yaml ...
kubectl apply -f /tmp/synapseone-secrets.yaml

# 2. Deploy:
kubectl apply -k infra/k8s/base
kubectl -n synapseone get pods,svc

# 3. Open the gateway (port-forward until you have an ingress):
kubectl -n synapseone port-forward svc/gateway 8080:80
curl localhost:8080/health
```

Notes:
- `all.yaml` holds the Namespace + Deployments/Services for `iam`, `gateway`, `workflow`, `ai`, `console`. Postgres/Redis/object-storage(S3)/Authentik use each engine's own chart/manifests.
- Required secrets (`synapseone-secrets`): `database-url`, `iam-jwt-secret` (gateway + IAM **identical**),
  `oidc-client-secret`, `ai-api-key`, `internal-secret` (gateway + IAM + workflow + ai identical),
  `api-key-pepper`. Replace the `console`/`gateway` placeholders (`console.example.com`, `gateway.example.com`) with your real domains.
- Production: add Ingress + TLS, HPA, PDB, resource limits, and manage secrets with SealedSecrets/External Secrets.
