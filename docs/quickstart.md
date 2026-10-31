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
curl localhost:4005/health      # base (documents)
curl localhost:4006/health      # faststore (cache/KV)
curl localhost:4007/health      # queue (messaging)
```

- First pull takes a while (authentik). For a lighter start:
  `docker compose up -d --build postgres redis s3 s3-init iam workflow base faststore queue gateway`
  (authentik only starts when named).
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
npm install @synapseone/sdk        # or: pip install synapseone-sdk
npx -y @synapseone/cli@latest login --email demo@acme.local
# (Defaults to https://synapseone.space; pass --base http://localhost:8080 when running against local compose)
```

## 4. Authentik (default IdP)

- Open `http://localhost:19000` (host port `AUTHENTIK_HTTP_PORT`; the bootstrap admin
  password is in the `authentik-server` log), create a `synapseone` Provider +
  Application, then put `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` in
  `.env` and restart `iam`.
- Sign-in flow: `GET /v1/auth/oidc/start?org=acme` → open `authorizeUrl` →
  the IdP redirects to the configured `OIDC_REDIRECT_URI` with `?code&state` →
  `POST /v1/auth/oidc/callback {code, state}` mints platform tokens. The Console's
  `/oidc/callback` page does this round-trip for you.
- To use Keycloak instead: stand up Keycloak, create a realm + client, set
  `OIDC_ISSUER=https://<keycloak>/realms/<realm>` — no IAM code changes needed.

## 5. Workflows (local engine, no setup)

- No external engine: `workflow-service` runs workflows itself (Postgres-backed).
- Create a workflow from a template: `POST /v1/workflows {"template":"webhook-to-log","name":"demo"}`.
  Templates: `webhook-to-log`, `cron-etl`, `iam-webhook`, `code-transform`,
  `manual-starter` (manual → code → set — the fastest way to click Execute).
- Execute it: `POST /v1/workflows/:id/execute {"hello":"world"}` — works for any
  trigger type, active or not. Activate only gates cron + public `ANY /webhook/:path`.
- Try the sandboxed transform: template `code-transform` (webhook → code → if → set).
- In the Console editor: pick a palette group (Triggers / Actions / Logic / Utils),
  click a node for its form (webhook shows its URL, schedule shows the next run),
  wire outputs → inputs (`if` asks for the true/false branch and labels the edges),
  then Test-run with the sample input before Save. Save is blocked with the exact
  reason while the graph has a cycle, self-loop, dangling node or duplicate name.
- Secrets: create them under the workflow Credentials picker (account-scoped,
  encrypted server-side) and reference by id — never paste tokens into headers.
- Harden inbound webhooks per node (shared secret / HMAC / JWT + rpm limit +
  idempotency key) before sharing the `/webhook/:path` URL.

## 6. Data services (Base, Faststore, Queue)

All three are behind the gateway and tenant-scoped automatically from your
principal (org → account → user).

```bash
# SynapseBase: collection + mapped object + query
curl -s -XPOST localhost:8080/v1/base/collections \
  -H"Authorization: Bearer $TOK" -H'Content-Type: application/json' \
  -d '{"name":"parks","mapping":{"name":"profile.name","capacity":"profile.capacity"}}'
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents \
  -H"Authorization: Bearer $TOK" -H'Content-Type: application/json' \
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'
curl -s "localhost:8080/v1/base/collections/parks/documents/park-1?as=object" \
  -H"Authorization: Bearer $TOK"

# Faststore: cache a value for 5 minutes and bump a counter
curl -s -XPUT localhost:8080/v1/faststore/keys/cache:park:1 \
  -H"Authorization: Bearer $TOK" -H'Content-Type: application/json' \
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'
curl -s -XPOST localhost:8080/v1/faststore/keys/visits/incr \
  -H"Authorization: Bearer $TOK" -H'Content-Type: application/json' -d '{"by":1}'

# Queue: publish, consume, ack
curl -s -XPOST localhost:8080/v1/queue/queues/emails/messages \
  -H"Authorization: Bearer $TOK" -H'Content-Type: application/json' \
  -d '{"payload":{"to":"alice@acme.test"},"dedupeKey":"welcome:alice"}'
curl -s -XPOST localhost:8080/v1/queue/queues/emails/consume \
  -H"Authorization: Bearer $TOK" -H'Content-Type: application/json' \
  -d '{"maxMessages":10,"consumer":"mailer-1"}'
# then POST .../ack with the returned receipt
```

Guides: [synapsebase.md](synapsebase.md) · [faststore.md](faststore.md) ·
[queue.md](queue.md). Base persists to Postgres, Faststore and Queue to Redis;
without those env vars they fall back to per-process memory (dev only).

## 7. Object storage (S3)

- S3 endpoint `http://localhost:9090` (S3Mock, S3-compatible), bucket `synapseone-core`
  auto-created by the `s3-init` service.
- Try it: `aws --endpoint-url http://localhost:9090 s3 ls` (keys in `.env`:
  `S3_ACCESS_KEY` / `S3_SECRET_KEY`).
- Production: switch to MinIO (`quay.io/minio/minio`) or real AWS S3 by replacing the
  `s3` service + `S3_ENDPOINT` — SDK/API code doesn't change since everything speaks S3.

## 8. Stop

```bash
docker compose down        # keep data
docker compose down -v     # wipe all data
```

## 9. Seed sample data (optional)

```bash
bash examples/quickstart/seed.sh   # demo org + prod/staging accounts + viewer+etl roles/policies
```

Idempotent, safe to re-run. `SEED_ORG` / `SEED_EMAIL` change the org/email.

## 10. Local HTTPS (optional)

```bash
bash infra/tls/gen-cert.sh
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d tls
# https://gateway.synapseone.local:8443 (API), https://synapseone.local:8443 (console)
# needs admin rights to add '127.0.0.1 synapseone.local gateway.synapseone.local' to hosts,
# or curl --resolve ...:8443:127.0.0.1 (bypasses SNI/DNS)
```

Self-signed cert for `synapseone.local` (`infra/tls/certs/`, git-ignored). Production:
use a real LE/ACME cert and keep the `tls` service shape (`infra/prod/` does exactly this).
