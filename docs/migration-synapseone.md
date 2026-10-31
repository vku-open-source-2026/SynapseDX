# Migrating from SynapseDX to SynapseOne

SynapseOne 0.7.0 is the same platform under a new name. Data, APIs and behavior
are unchanged; identifiers, packages and namespaces were renamed. This guide is
for operators upgrading an existing SynapseDX deployment.

## Rename map

| Area | Before | After | Compatibility |
|---|---|---|---|
| Product | SynapseDX | SynapseOne | — |
| Domain (examples) | `synapsedx.sbs` | `synapseone.space` | configure DNS/TLS yourself |
| Compose project | `synapsedx` | `synapseone` | see [volumes](#1-compose-project-and-volumes) |
| Env prefix | `SYNAPSEDX_*` | `SYNAPSEONE_*` | services mirror old → new at boot |
| Internal headers | `x-synapsedx-*` | `x-synapseone-*` | gateway accepts, strips and mirrors both |
| JWT issuer | `synapsedx-iam` | `synapseone-iam` | gateway/IAM accept both issuers |
| Workflow nodes | `synapsedx.*` | `synapseone.*` | engine normalizes legacy nodes on read/run |
| npm SDK | `@synapsedx/sdk` | `@synapseone/sdk` | `SynapseDXClient`/`SynapseDXError` aliases |
| npm CLI | `@synapsedx/cli` | `@synapseone/cli` | `synapseone` binary; old config dir read as fallback |
| PyPI | `synapsedx-sdk` | `synapseone-sdk` | `synapsedx_sdk` import shim + class aliases |
| Go module | `…/synapsedx-sdk-go` | `…/SynapseOne/sdks/sdk-go` | update `go.mod` (see [SDKs](#5-sdks-and-cli)) |
| DB tables (Base) | `synapsedx_base_*` | `synapseone_base_*` | migration renames in place |
| DB tables (Workflow) | `synapsedx_*` | `synapseone_*` | migration renames in place |
| Redis keys | `synapsedx:queue/faststore/stream:*` | `synapseone:*` | **not** dual-read; drain or copy |
| OIDC app slug | `/application/o/synapsedx/` | `/application/o/synapseone/` | configure IdP or keep old env values |
| CLI config | `~/.synapsedx/config.json` | `~/.synapseone/config.json` | old file read when new one is absent |
| Console session key | `synapsedx.console.auth` | `synapseone.console.auth` | migrated on first load |
| TLS dev CN | `synapsedx.local` | `synapseone.local` | regenerate certs |

## Upgrade checklist

### 0. Back up

```bash
docker compose down
docker run --rm -v synapsedx_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/synapseone-pgdata-pre-0.7.0.tar.gz -C /data .
```

Adjust the volume name if your Compose project is not `synapsedx`.

### 1. Compose project and volumes

`docker-compose.yml` now sets `name: synapseone`. Docker Compose derives volume
names from the project name, so an existing stack would otherwise start with
**empty** `synapseone_pgdata` / `synapseone_redisdata` volumes.

Pick one:

**A. Keep the old project name (recommended, no copy):**

```dotenv
# .env
COMPOSE_PROJECT_NAME=synapsedx
```

The stack keeps using `synapsedx_pgdata`, `synapsedx_redisdata`, etc. The new
network name does not matter. Remove the override after you migrate volumes.

**B. Move the volumes to the new project name:**

```bash
for v in pgdata redisdata s3data prometheusdata; do
  docker volume create "synapseone_$v"
  docker run --rm -v "synapsedx_$v:/from" -v "synapseone_$v:/to" alpine \
    sh -c 'cd /from && cp -a . /to/'
done
```

Keep the old volumes until you have verified the upgrade.

### 2. Environment file

Rename the keys in `.env` (the services still mirror `SYNAPSEDX_*`, but Compose
substitution prefers the new names):

```diff
-SYNAPSEDX_INTERNAL_SECRET=...
-SYNAPSEDX_IAM_API_KEY=...
-SYNAPSEDX_PUBLIC_BASE_URL=https://api.example.com
+SYNAPSEONE_INTERNAL_SECRET=...
+SYNAPSEONE_IAM_API_KEY=...
+SYNAPSEONE_PUBLIC_BASE_URL=https://api.example.com
```

`docker-compose.yml` falls back to the old names for these three variables, so a
partial rename also works. Update `POSTGRES_DB`/`POSTGRES_USER` only if you also
rename the database role/database itself; the default changed from `synapsedx`
to `synapseone` for **new** installs.

### 3. Database

Migrations run automatically at service boot:

- `apps/workflow-service/drizzle/0001_rebrand_synapseone.sql` renames
  `synapsedx_workflows` → `synapseone_workflows` (plus executions/credentials,
  indexes and constraints).
- `apps/base-service/drizzle/0003_rebrand_synapseone.sql` renames
  `synapsedx_base_collections|documents|vectors` (plus constraints).

Both migrations are conditional: fresh databases created with 0.7.0 already use
the new names and the statements are no-ops. Historical migration files were
rebranded in place, which is safe because Drizzle tracks applied migrations by
journal timestamp.

Verify:

```sql
\dt synapseone_*
SELECT * FROM __drizzle_migrations_workflow ORDER BY created_at DESC LIMIT 1;
SELECT * FROM __drizzle_migrations_base ORDER BY created_at DESC LIMIT 1;
```

IAM and LDS table names never carried the prefix and need no rename.

### 4. Redis namespaces

Queue, Faststore and Stream key prefixes changed:

```
synapsedx:queue:v1:<tenant>:...      -> synapseone:queue:v1:<tenant>:...
synapsedx:faststore:v1:<tenant>:...  -> synapseone:faststore:v1:<tenant>:...
synapsedx:stream:v1:<tenant>:...     -> synapseone:stream:v1:<tenant>:...
```

There is no dual-read (two writers would break queue ordering). Choose one:

- **Drain first:** stop producers, consume pending queue messages, then upgrade.
- **Copy keys:** stop writers, then rename keys with `SCAN` + `RENAMENX` before
  starting 0.7.0. Faststore cache keys can also be allowed to expire/rebuild.
- **Accept data loss:** fine for cache-only deployments, not for queues/DLQ.

### 5. SDKs and CLI

**JavaScript / TypeScript**

```diff
-import { SynapseDXClient } from '@synapsedx/sdk';
+import { SynapseOneClient } from '@synapseone/sdk';
```

`SynapseDXClient`, `SynapseDXError` and `SynapseDXClientOptions` remain exported
as aliases (same classes) for the rebrand window.

**Python**

```diff
-from synapsedx_sdk import SynapseDXClient
+from synapseone_sdk import SynapseOneClient
```

`synapsedx_sdk` is still installable as a shim from the same distribution, and
`SynapseDXClient`/`SynapseDXError` are aliases of the new classes.

**CLI**

```diff
-npx -y @synapsedx/cli login
+npx -y @synapseone/cli login
```

The binary is now `synapseone`. It reads `SYNAPSEONE_*`, falls back to
`SYNAPSEDX_*`, and reads `~/.synapsedx/config.json` when
`~/.synapseone/config.json` does not exist.

**Go**

```diff
-import sdk "github.com/synapsedx/synapsedx-sdk-go"
+import sdk "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"
```

Update `go.mod` and any `replace` directive. Tags are published from the renamed
repository, so `go get` resolves the new path once the repository rename lands.

### 6. OIDC / SSO

The default Authentik slug and client id changed:

```
OIDC_ISSUER=http://authentik-server:9000/application/o/synapseone/
OIDC_CLIENT_ID=synapseone-platform
```

Either create a new provider/application in Authentik (slug `synapseone`,
redirect URI unchanged) or keep the old values in `.env`; both work. Old JWT
sessions keep working because the gateway and IAM accept the legacy
`synapsedx-iam` issuer.

### 7. TLS and DNS

Dev self-signed certs changed CN:

```bash
rm -f infra/tls/certs/synapseone.local.crt infra/tls/certs/synapseone.local.key
bash infra/tls/gen-cert.sh
```

Production: point `synapseone.space`, `cloud.synapseone.space` and
`api.synapseone.space` at the edge, then issue certificates:

```bash
DOMAIN=synapseone.space LE_EMAIL=you@example.com bash infra/prod/init-letsencrypt.sh
```

The old `synapsedx.sbs` hostnames can keep serving during a transition if you
keep the old DNS records and certificates.

### 8. Smoke test

```bash
curl -fsS https://api.synapseone.space/health
docker compose ps
docker compose logs --tail=100 gateway iam workflow base
```

Log in to the Console, open an existing workflow, run it once, and confirm that
Base collections created before the upgrade are still listed.
