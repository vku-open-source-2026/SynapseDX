# Quickstart

## 1. Requirements

Docker 24+, Docker Compose v2, 4 GB free RAM. You don't need Node or Python to run
the platform (only for SDK development).

## 2. Run

```bash
cp .env.example .env
# replace every *_change_me_* secret in .env
docker compose up --build -d
docker compose ps
curl localhost:8080/health      # gateway
curl localhost:4001/health      # iam
curl localhost:4002/health      # workflow
```

- First pull takes a while (n8n, authentik). For a lighter start:
  `docker compose up -d --build postgres redis s3 s3-init iam workflow gateway`
  (n8n still comes up via `workflow`'s `depends_on`; authentik only starts when named).
- Host port busy? Change `GATEWAY_HOST_PORT` (or any `*_HOST_PORT`) in `.env` —
  see `docs/troubleshooting.md`.
- Windows: use `examples/quickstart/demo.ps1` (equivalent of `demo.sh`).

## 3. First flow (dev sign-in → org → key → workflow)

```bash
# sign in (dev login; disabled in production — use SSO or an API key there)
TOK=$(curl -s -XPOST localhost:8080/v1/auth/login -H'Content-Type: application/json' -d'{"email":"demo@acme.local","orgSlug":"acme"}' | tee /tmp/login.json | jq -r .accessToken)
echo $TOK
curl -s localhost:8080/v1/orgs -H"Authorization: Bearer $TOK" | jq
# workflow templates
curl -s localhost:8080/v1/templates -H"Authorization: Bearer $TOK" | jq
```

Prefer SDKs/CLI over raw curl — same API:

```bash
npm install @synapsedx/sdk        # or: pip install synapsedx-sdk
npx -y @synapsedx/cli@latest --base http://localhost:8080 login --email demo@acme.local
```

## 4. Authentik (default IdP)

- Open `http://localhost:19000` (host port `AUTHENTIK_HTTP_PORT`; the bootstrap admin
  password is in the `authentik-server` log), create a `synapsedx` Provider +
  Application, then put `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` in
  `.env` and restart `iam`.
- Sign-in flow: `GET /v1/auth/oidc/start?org=acme` → open `authorizeUrl` →
  the IdP redirects to the configured `OIDC_REDIRECT_URI` with `?code&state` →
  `POST /v1/auth/oidc/callback {code, state}` mints platform tokens. The Console's
  `/oidc/callback` page does this round-trip for you.
- To use Keycloak instead: stand up Keycloak, create a realm + client, set
  `OIDC_ISSUER=https://<keycloak>/realms/<realm>` — no IAM code changes needed.

## 5. n8n

- Open `http://localhost:5678`, create the owner account, go to Settings → API →
  create an API key → put it in `N8N_API_KEY` in `.env` → restart `workflow`.
  (Or run `bash tools/setup-n8n.sh --setup` with `OWNER_PW` set.)
- Create a workflow from a template: `POST /v1/workflows {"template":"webhook-to-log","name":"demo"}`.
- Headless setup script (verified against n8n 1.66):
  ```bash
  curl -XPOST localhost:5678/rest/owner/setup -H'Content-Type: application/json' \
    -d'{"email":"owner@acme.local","firstName":"synapsedx","lastName":"Owner","password":"<STR0NG>"}'
  # sign in (cookie), then create an API key:
  curl -c jar -XPOST localhost:5678/rest/login -H'Content-Type: application/json' \
    -d'{"email":"owner@acme.local","password":"<STR0NG>"}'
  curl -b jar -XPOST localhost:5678/rest/api-keys -H'Content-Type: application/json' \
    -d'{"label":"synapsedx"}'   # → data.apiKey
  ```
  Note: n8n sets `Secure` cookies, so the cookie flow only works over plain http when
  `N8N_SECURE_COOKIE=false` (local dev); behind a TLS-terminating proxy keep the default.
  The API-key flow (`X-N8N-API-KEY`, how `workflow-service` calls n8n) needs no cookies.

## 6. Object storage (S3)

- S3 endpoint `http://localhost:9090` (S3Mock, S3-compatible), bucket `synapsedx-core`
  auto-created by the `s3-init` service.
- Try it: `aws --endpoint-url http://localhost:9090 s3 ls` (keys in `.env`:
  `S3_ACCESS_KEY` / `S3_SECRET_KEY`).
- Production: switch to MinIO (`quay.io/minio/minio`) or real AWS S3 by replacing the
  `s3` service + `S3_ENDPOINT` — SDK/API code doesn't change since everything speaks S3.

## 7. Stop

```bash
docker compose down        # keep data
docker compose down -v     # wipe all data
```

## 8. Seed sample data (optional)

```bash
bash examples/quickstart/seed.sh   # demo org + prod/staging accounts + viewer+etl roles/policies
```

Idempotent, safe to re-run. `SEED_ORG` / `SEED_EMAIL` change the org/email.

## 9. Local HTTPS (optional)

```bash
bash infra/tls/gen-cert.sh
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d tls
# https://gateway.synapsedx.local:8443 (API), https://synapsedx.local:8443 (console)
# needs admin rights to add '127.0.0.1 synapsedx.local gateway.synapsedx.local' to hosts,
# or curl --resolve ...:8443:127.0.0.1 (bypasses SNI/DNS)
```

Self-signed cert for `synapsedx.local` (`infra/tls/certs/`, git-ignored). Production:
use a real LE/ACME cert and keep the `tls` service shape (`infra/prod/` does exactly this).
