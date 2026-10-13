# SynapseDX Console (management UI)

An AWS-Console-style admin UI for the Tier-1 PaaS: service-based sidebar navigation,
Org/Account switcher, IAM CRUD, authorize simulator, workflows, audit log.

- Stack: React 18 + Vite + Tailwind (Poppins, `#4FACFE → #00F2FE` gradients,
  `#f6f7fb` background, white `rounded-3xl` cards).
- Auth: dev sign-in (email+org), SSO via OIDC (`/oidc/callback` round-trip), or API key;
  sessions live in localStorage. All API calls go straight to the gateway (CORS open
  by default) with Bearer / `X-API-Key`.

## Run

```bash
# together with the platform (console on :3000)
docker compose up -d --build postgres redis s3 iam workflow gateway console
# open http://localhost:3000 → sign in demo@acme.local / org acme
```

Change the port/backend host:

```bash
CONSOLE_HOST_PORT=13000 SYNAPSEDX_PUBLIC_BASE_URL=http://localhost:18080 \
GATEWAY_HOST_PORT=18080 docker compose up -d --build console gateway ...
```

`SYNAPSEDX_PUBLIC_BASE_URL` **must be a browser-reachable URL** (not a docker service
name) — the container injects it into `config.js` at startup
(`apps/console/docker-entrypoint.sh`). `CONSOLE_APP_URL` is the canonical app host used
for cross-domain sign-in redirects (see multi-domain deploys in `infra/prod/`).

## SSO sign-in

`GET /v1/auth/oidc/start?org=<slug>` returns an `authorizeUrl`; after the IdP
redirects back to `/oidc/callback?code&state`, the page POSTs the single-use code to
`/v1/auth/oidc/callback`, stores the minted tokens and lands on `/dashboard`. Tokens
never appear in the URL.

For this to work, `OIDC_REDIRECT_URI` must point at the Console page, e.g.
`https://cloud.example.com/oidc/callback` (not the API endpoint).

## Frontend dev

```bash
cd apps/console
npm install
npm run dev   # :3000, /api proxies to localhost:8080 when needed
```

## Pages

Dashboard (ready/metrics) · Organizations · Accounts · Users · Roles ·
Policies (JSON editor + dry-run) · API Keys · Service Accounts · Workflows
(templates + create on n8n) · Authorize (simulator + live authorize) · Audit Log.
Public pages: Landing (`/`, install instructions), API Docs (try-it explorer), Docs
(SDK/CLI snippets), Login, OIDC callback.
