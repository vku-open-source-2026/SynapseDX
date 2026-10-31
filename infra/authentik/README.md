# Authentik — default IdP (swappable with Keycloak)

Compose stands up `authentik-server:9000` + `authentik-worker` sharing Postgres/Redis.

## First-time bootstrap

1. Sign in at `http://localhost:19000` as `akadmin` (password below),
   then **change the password immediately** (user menu → Change password).
2. Create a Provider (OAuth2/OIDC):
   - Authorization flow: `default-provider-authorization-implicit-consent`
   - Client ID: `synapseone-platform` (matches `OIDC_CLIENT_ID`)
   - Redirect URI: your Console `/oidc/callback` page, e.g.
     `https://cloud.example.com/oidc/callback` (matches `OIDC_REDIRECT_URI`;
     local dev without a frontend page may use the API callback instead)
3. Create the `synapseone` Application, attach the provider, take the slug →
   `OIDC_ISSUER=http://localhost:19000/application/o/synapseone/` for browsers, while
   inside the docker network IAM uses
   `OIDC_ISSUER=http://authentik-server:9000/application/o/synapseone/`.
4. Put `OIDC_CLIENT_SECRET` in `.env`, `docker compose up -d iam`.

> Deploy note: the Authentik image doesn't print the bootstrap password to the log, so
> the `akadmin` password is seeded directly via the DB at creation time (Django PBKDF2).
> Change it right after signing in. Reset when needed via UPDATE on
> `authentik_core_user` or Authentik's recovery flow.

## Using Keycloak instead

1. Stand up Keycloak (outside compose, or add a service).
2. Create a realm (e.g. `synapseone`) and a `synapseone-platform` client (standard flow,
   same redirect as above).
3. Change `.env`: `OIDC_ISSUER=https://<host>/realms/synapseone`,
   matching `OIDC_CLIENT_ID`/`SECRET`.
4. No IAM code changes — `GET /v1/auth/oidc/config` reflects the new issuer.

## Sign-in flow (real Authorization Code, no demo shortcuts)

`GET /v1/auth/oidc/start?org=<slug>` → open `authorizeUrl` → IdP redirects to
`OIDC_REDIRECT_URI` with `?code&state` → `POST /v1/auth/oidc/callback {code, state}`
redeems the code and verifies the ID token against the IdP JWKS. The legacy
demo-email callback only exists for local dev (`IAM_ALLOW_OIDC_DEMO_CALLBACK=true`).
