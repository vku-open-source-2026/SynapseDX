# `synapseone` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [SynapseOne](../README.md) Tier-1 PaaS. No `npm install` needed — single file, only Node's built-in `fetch`.

## Install

### One-line installer (recommended)

```bash
curl -fsSL https://synapseone.space/install.sh | sh
```

### From npm registry

```bash
npm install -g @synapseone/cli@latest
```

### Run without installing

```bash
npx -y @synapseone/cli@latest --help
```

### From source

```bash
# Run directly
node tools/cli/bin/synapseone.js --help

# Or link globally
npm link ./tools/cli
# then call `synapseone ...` anywhere
```

## Quick start

```bash
# Defaults to https://synapseone.space (or pass --base http://localhost:8080 for local dev)
synapseone login --email demo@acme.local
synapseone orgs
synapseone accounts create prod Production
synapseone authz <user-id> workflow:Execute "*" --context team=etl
synapseone workflows create --template webhook-to-log --name demo
synapseone audit --limit 20
```

For local container development: add `--base http://localhost:8080` (or `export SYNAPSEONE_BASE_URL=http://localhost:8080`).

## Configuration

### Base URL resolution

The CLI resolves the base URL in this order (first match wins):

1. `--base <URL>` flag
2. `$SYNAPSEONE_BASE_URL` environment variable
3. `baseUrl` in `~/.synapseone/config.json`
4. `https://synapseone.space` (default)

### Auth resolution

The CLI resolves credentials in this order (first match wins):

1. `--token <jwt>` / `--apikey <key>` flags
2. `$SYNAPSEONE_TOKEN` / `$SYNAPSEONE_API_KEY` environment variables
3. `token` / `apiKey` in `~/.synapseone/config.json`

> **Security note:** Prefer env vars or config file over `--token`/`--apikey` flags, since flags are visible via `ps` and shell history.

### Config file

`synapseone login` and `synapseone use-key` save credentials to `~/.synapseone/config.json` (file permissions `0600`, owner-only). The refresh token is also stored for `refresh` / `logout-all` reuse.

```bash
# Show saved config (secrets are redacted)
synapseone config
```

### Global flags

| Flag | Description |
|---|---|
| `--base <URL>` | Override base URL |
| `--token <jwt>` | Bearer token |
| `--apikey <key>` | API key |
| `--json` | Output raw JSON (script-friendly) |
| `--context k=v` | Add context key-value (repeatable) |
| `--file <path>` | Read JSON body from file |
| `--data <json\|path>` | Inline JSON or JSON file for workflow input / webhook payload (alias: `--input`) |
| `--input <json\|path>` | Same as `--data` |
| `--limit <N>` | Limit results (`0..9999`) |
| `--offset <N>` | Skip N executions (`0..9999`, `0` = first page) |
| `--workflow-id <ID>` | Filter executions by workflow (alias: `--workflow`, `--workflowId`) |
| `--status <s>` | Filter executions (`success`\|`error`\|`running`) |
| `--include-data` | Include per-node I/O (`includeData=true`) |
| `--path <p>` | Webhook path for `webhook <path>` |
| `--method <m>` | Webhook HTTP method (`GET`\|`POST`\|`PUT`\|`PATCH`\|`DELETE`\|`HEAD`); also `call <METHOD>` |
| `--type <t>` | Credential type (`bearer`\|`basic`\|`apiKey`\|`oauth2`) |
| `--secret <S>` | Credential secret (prefer `--secret-file`/env — flags leak via `ps`) |
| `--secret-file <path>` | Read credential secret from file (preferred) |
| `--expires-at <ISO>` | Credential expiry timestamp |
| `--actor <id>` | Filter by actor |
| `--name <name>` | Name for create operations |
| `--template <name>` | Template name |
| `--email <email>` | Email for login |
| `--org <slug>` | Org slug |
| `--label <label>` | Label/name |

## Commands

### Auth

#### `login`
```bash
synapseone login --email <email> [--org <slug>] [--base <url>]
```
Dev login. Saves token + refresh token to config.

```bash
synapseone login --email demo@acme.local
synapseone login --email alice@acme.local --org acme
```

#### `refresh`
```bash
synapseone refresh [refresh-token]
```
Rotates the access token (atomic server-side). Uses `$SYNAPSEONE_REFRESH_TOKEN` or config if no argument given.

```bash
synapseone refresh
synapseone refresh eyJhbGciOi...
```

#### `logout-all`
```bash
synapseone logout-all [refresh-token]
```
Revokes ALL sessions of the token owner.

```bash
synapseone logout-all
```

#### `logout`
```bash
synapseone logout
```
Clears saved credentials from config.

#### `verify`
```bash
synapseone verify
```
Checks the current Bearer token or API key.

#### `use-key`
```bash
synapseone use-key <api-key>
```
Saves an API key to config (instead of a token).

```bash
synapseone use-key sk_live_abc123...
```

#### `whoami`
```bash
synapseone whoami
```
Shows the current user (`/v1/auth/me`).

#### `config`
```bash
synapseone config
```
Shows saved config with secrets redacted.

### Organizations

#### `orgs`
```bash
synapseone orgs
synapseone orgs list
```
Lists all organizations.

#### `orgs create`
```bash
synapseone orgs create <slug> [name]
```
Creates an organization.

```bash
synapseone orgs create acme2 "ACME 2"
```

### Accounts

#### `accounts`
```bash
synapseone accounts [org]
synapseone accounts list [org]
```
Lists accounts in an organization. If no org is given, uses the first available org.

#### `accounts create`
```bash
synapseone accounts create [org] <slug> [name]
```
Creates an account under an organization.

```bash
synapseone accounts create prod Production
synapseone accounts create my-org prod Production
```

### Users

#### `users`
```bash
synapseone users [org]
synapseone users list [org]
```
Lists users in an organization.

#### `users create`
```bash
synapseone users create <org> <email> [name]
```
Creates a user in an organization.

```bash
synapseone users create my-org alice@acme.local "Alice"
```

#### `users policies`
```bash
synapseone users policies <user-id>
```
Shows the effective policy documents of a user.

```bash
synapseone users policies usr_abc123
```

### Roles

#### `roles`
```bash
synapseone roles <account>
synapseone roles list <account>
```
Lists roles in an account.

#### `roles create`
```bash
synapseone roles create <account> <slug>
```
Creates a role in an account.

```bash
synapseone roles create acc_abc123 etl-runner
```

#### `roles delete`
```bash
synapseone roles delete <role-id>
```
Deletes a role.

```bash
synapseone roles delete rol_abc123
```

### Policies

#### `policies`
```bash
synapseone policies <account>
synapseone policies list <account>
```
Lists policies in an account.

#### `policies create`
```bash
synapseone policies create <account> <slug> --file <policy.json>
```
Creates an IAM policy from a JSON file.

```bash
synapseone policies create acc_abc123 wf-exec --file policy.json
```

Example `policy.json`:
```json
{
  "Version": "2012-17-10",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["workflow:Execute"],
    "Resource": ["*"]
  }]
}
```

#### `policies delete`
```bash
synapseone policies delete <policy-id>
```
Deletes a policy.

```bash
synapseone policies delete pol_abc123
```

### Role-policy attachment

#### `attach`
```bash
synapseone attach <role-id> <policy-id>
```
Attaches a policy to a role.

```bash
synapseone attach rol_abc123 pol_abc123
```

#### `assign`
```bash
synapseone assign <user-id> <role-id>
```
Assigns a role to a user.

```bash
synapseone assign usr_abc123 rol_abc123
```

### Authorization

#### `authz`
```bash
synapseone authz <user-id> <action> <resource> [--context k=v]
```
Checks whether a user is authorized to perform an action on a resource.

```bash
synapseone authz usr_abc123 workflow:Execute "*"
synapseone authz usr_abc123 workflow:Execute "wf_123" --context team=etl
```

#### `sim`
```bash
synapseone sim --file <policy.json> <action> <resource> [--context k=v]
```
Dry-runs policy documents without a user (like AWS IAM Policy Simulator).

```bash
synapseone sim --file policy.json workflow:Execute "*"
synapseone sim --file policies.json workflow:Execute "wf_123" --context env=prod
```

The `--file` can contain a single policy object or an array of policies.

### Audit

#### `audit`
```bash
synapseone audit [--limit <N>] [--actor <id>]
```
Reads the audit log.

```bash
synapseone audit
synapseone audit --limit 20
synapseone audit --limit 50 --actor usr_abc123
```

### API keys

#### `keys create`
```bash
synapseone keys create <account> [--name <name>]
```
Creates an API key. The key is shown once — save it immediately.

```bash
synapseone keys create acc_abc123 --name ci-deploy
```

#### `keys revoke`
```bash
synapseone keys revoke <key-id>
```
Revokes an API key.

```bash
synapseone keys revoke key_abc123
```

#### `keys list`
```bash
synapseone keys list <account>
```
Lists key metadata (id/prefix only — never secret values).

```bash
synapseone keys list acc_abc123
```

#### `keys verify`
```bash
synapseone keys verify <api-key>
```
Checks a raw API key via the internal verify endpoint.

```bash
synapseone keys verify sk_live_abc123...
```

### Service accounts

#### `sa`
```bash
synapseone sa <account>
synapseone sa list <account>
```
Lists service accounts in an account.

#### `sa create`
```bash
synapseone sa create <account> <slug>
```
Creates a service account.

```bash
synapseone sa create acc_abc123 etl-bot
```

#### `sa token`
```bash
synapseone sa token <sa-id>
```
Mints a short-lived JWT for a service account. The token is shown once — save it immediately.

```bash
synapseone sa token sa_abc123
```

### Credentials (PROPOSED — backend in progress)

Account-scoped secrets for workflow nodes. Secrets are encrypted at rest and
**never returned**: `create`/`rotate` take a secret once; `list`/`get` return
metadata only (`{id, name, type, accountId, expiresAt, version}`).
Prefer `--secret-file` (or `$SYNAPSEONE_CREDENTIAL_SECRET`) over `--secret` —
flags leak via `ps` and shell history.

#### `credentials create`
```bash
synapseone credentials create <account> --name <name> --type bearer|basic|apiKey|oauth2 (--secret <S> | --secret-file <path>) [--expires-at <ISO>]
```

```bash
# Copy-paste: store a bearer token, then verify only metadata comes back.
echo -n 'tok_live_abc' > /tmp/stripe-secret
synapseone credentials create acc_abc123 --name stripe-live --type bearer --secret-file /tmp/stripe-secret --expires-at 2027-01-01T00:00:00Z
synapseone credentials list acc_abc123
```

#### `credentials list` / `credentials get`
```bash
synapseone credentials [list] <account>
synapseone credentials get <credential-id>
```

```bash
synapseone credentials list acc_abc123
synapseone credentials get cred_abc123
```

#### `credentials rotate`
```bash
synapseone credentials rotate <credential-id> (--secret <S> | --secret-file <path>)
```
Replaces the secret and bumps `version` (the old secret stops working).

```bash
echo -n 'tok_live_xyz' > /tmp/stripe-secret-v2
synapseone credentials rotate cred_abc123 --secret-file /tmp/stripe-secret-v2
```

#### `credentials delete`
```bash
synapseone credentials delete <credential-id>
```

```bash
synapseone credentials delete cred_abc123
```

### Generic call (escape hatch)

#### `call`
```bash
synapseone call <METHOD> <path> [--data '{...}'|body.json] [--file body.json]
```
Calls any gateway endpoint directly — forward-compat with endpoints added after
this CLI (e.g. the proposed credentials API).

```bash
synapseone call GET /v1/accounts/acc_abc123/credentials
synapseone call POST /v1/workflows/test-run --data '{"definition":{"nodes":[],"connections":{}},"input":{}}'
```

### Workflows

#### `workflows`
```bash
synapseone workflows
synapseone workflows list
```
Lists all workflows.

#### `workflows create` (from template)
```bash
synapseone workflows create --template <name> [--name <name>]
```
Instantiates a built-in template.

```bash
synapseone workflows create --template webhook-to-log --name my-webhook
```

#### `workflows create` (from file)
```bash
synapseone workflows create --file <definition.json> [--name <name>]
```
Creates a workflow from a raw workflow definition JSON file. The file can contain either a full body (`{"template": ..., "name": ...}` or `{"definition": ..., "name": ...}`) or a bare definition.

```bash
synapseone workflows create --file my-workflow.json --name my-wf
```

#### `workflows get`
```bash
synapseone workflows get <workflow-id>
```
Gets a single workflow by ID.

```bash
synapseone workflows get wf_abc123
```

#### `workflows activate`
```bash
synapseone workflows activate <workflow-id>
```
Activates a workflow.

```bash
synapseone workflows activate wf_abc123
```

#### `workflows deactivate`
```bash
synapseone workflows deactivate <workflow-id>
```
Deactivates a workflow.

```bash
synapseone workflows deactivate wf_abc123
```

#### `workflows exec`
```bash
synapseone workflows exec <workflow-id> [--data '{"k":v}'|input.json] [--file payload.json]
synapseone workflows execute <workflow-id> [--data ...] [--file ...]
```
Triggers a manual execution (the request body IS the workflow input).
`--data` takes inline JSON or a path to a JSON file; `--file` reads the
payload from a file (a bare input object, or `{input: {...}}`).

```bash
synapseone workflows exec wf_abc123
synapseone workflows exec wf_abc123 --data '{"value":21}'
echo '{"value":21}' > input.json
synapseone workflows exec wf_abc123 --data input.json
```

#### `workflows test-run`
```bash
synapseone workflows test-run --file <definition.json> [--input '{"k":v}'|input.json]
```
Tries a definition without saving (`POST /v1/workflows/test-run {definition, input}`).
`--file` (required) holds a bare `{nodes, connections}` definition or
`{definition, input}`; `--input` (inline JSON or JSON file) overrides the input.

```bash
# Copy-paste: try the code-transform template without saving.
synapseone templates code-transform --json > def.json
echo '{"value":21}' > input.json
synapseone workflows test-run --file def.json --input input.json
synapseone workflows test-run --file def.json --input '{"value":42}'
```

#### `workflows update`
```bash
synapseone workflows update <workflow-id> [--name <name>] [--file <definition.json>]
```
Updates a workflow's name and/or definition (at least one of `--name`/`--file`).

```bash
synapseone workflows update wf_abc123 --name renamed
```

#### `workflows delete`
```bash
synapseone workflows delete <workflow-id>
```
Deletes a workflow on the engine (`rm` is an alias).

```bash
synapseone workflows delete wf_abc123
```

### Templates

#### `templates`
```bash
synapseone templates
synapseone templates list
```
Lists all built-in workflow templates.

#### `templates <name>`
```bash
synapseone templates <name>
```
Fetches a single built-in template definition by name.

```bash
synapseone templates webhook-to-log
```

### Executions

> The engine always returns the envelope `{data: [...]}` for `GET /v1/executions`.
> The CLI unwraps it — list output is the plain execution array.

#### `executions`
```bash
synapseone executions
synapseone executions list [--limit <N>] [--offset <N>] [--workflow-id <ID>] [--status success|error|running] [--include-data]
```
Lists workflow executions. Allowed filters mirror the server allowlist
(`limit`/`offset` `0..9999`, `offset=0` = first page).

```bash
synapseone executions
synapseone executions list --limit 10
synapseone executions list --workflow-id wf_abc123 --status success --limit 20 --offset 20
synapseone executions list --limit 5 --include-data  # per-node I/O
```

#### `executions <id>`
```bash
synapseone executions <execution-id> [--include-data]
```
Gets a single execution by ID (`--include-data` adds per-node input/output).

```bash
synapseone executions exe_abc123
synapseone executions exe_abc123 --include-data
```

### Linked Data (SynapseLDS)

Publish licensed NGSI-LD open data. Reserved attribute names (id, type, @context,
internalId, tenantId, …) are rejected with `400 reserved_attribute`; unregistered
fields are stored but never exported (default deny — register them with `public`
visibility first). `_core` metadata never appears in any response.

```bash
synapseone lds licenses
synapseone lds datasources list [--org <orgId>] [--account <accountId>]
synapseone lds datasources create --name "Business Registry" --entity-type Organization \
  --license CC-BY-4.0 [--slug business-registry] \
  [--context https://data.example.vn/context/organization.jsonld]... [--visibility internal|public]
synapseone lds datasources get <id> | update <id> [--license ODbL-1.0] | delete <id>
synapseone lds attributes list <id>
synapseone lds attributes set <id> --file attributes.json   # [{name, ngsiLdType, visibility}]
synapseone lds ingest <id> --file record.json               # {"id":"55001","name":"ACME"}
synapseone lds entities <id> [--limit 20] [--offset 0] [--visibility public|restricted]
synapseone lds entity <id> <entityId>
synapseone lds stats <id>
```

`entities`/`entity` print pretty NGSI-LD JSON (each entity carries `@context`,
and responses come back with `X-LDS-License` + `Link rel="license"`). The
export read surface (`lds licenses`, `lds entities`, `lds entity`) is **public
open data**: without any login it serves the public projection — that is the
endpoint open-data consumers use. `--visibility restricted` needs a same-tenant
session (other tenants only get `404`; no token + restricted → `401`).

### Document DB & Vector Search (SynapseBase)

Manage collections, document JSON storage, vector similarity search, and hybrid queries.

```bash
# Collections CRUD
synapseone base collections list
synapseone base collections create <name> [--description <desc>] [--mapping '<json>'|--file <json>]
synapseone base collections get <name>
synapseone base collections delete <name>

# Documents CRUD
synapseone base documents list <col> [--limit 20] [--offset 0] [--as data|object]
synapseone base documents insert <col> [--id <id>] (--file doc.json | --data '{"k":"v"}')
synapseone base documents get <col> <id> [--as data|object]
synapseone base documents delete <col> <id>

# Vector Similarity & Hybrid Search
# Search by raw float vector:
synapseone base vector-search <col> --vector '[0.1, 0.2, 0.3]' [--limit 10] [--metric cosine|l2|ip] [--where '{"category":"tech"}']
# Search by natural language query (auto-embedded via inference service):
synapseone base vector-search <col> --query "authentication guide" [--limit 5] [--metric cosine]

# Structured Queries
synapseone base query <col> (--file query.json | --data '{"where":{"type":{"eq":"guide"}},"limit":10}')
```

### Webhooks (public, no auth)

`ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares
that `path`. No token needed. NOTE: the gateway does **not** proxy `/webhook/*` —
point `--base` at the workflow-service origin (default `http://localhost:4002`
for local dev), not the gateway.

#### `webhook`
```bash
synapseone webhook <path> [--data '{"k":v}'|payload.json] [--file payload.json] [--method POST] [--base http://localhost:4002]
```
Fires a public inbound webhook.

```bash
# Copy-paste: activate the code-transform template, then fire its webhook.
synapseone workflows create --template code-transform --name demo-transform
synapseone workflows activate <wf-id>
synapseone webhook transform --data '{"value":21}' --base http://localhost:4002
```

Raw curl equivalent:

```bash
curl -X POST http://localhost:4002/webhook/transform \
  -H 'Content-Type: application/json' \
  -d '{"value":21}'
```

## Output format

By default, the CLI prints a compact table (arrays) or key-value pairs (objects). Use `--json` for raw JSON output:

```bash
synapseone --json orgs
synapseone --json workflows list
```

## Environment variables

| Variable | Description |
|---|---|
| `SYNAPSEONE_BASE_URL` | Gateway URL |
| `SYNAPSEONE_TOKEN` | Bearer JWT |
| `SYNAPSEONE_API_KEY` | API key |
| `SYNAPSEONE_REFRESH_TOKEN` | Refresh token (for `refresh` / `logout-all`) |
| `SYNAPSEONE_CREDENTIAL_SECRET` | Credential secret (for `credentials create` / `rotate`, avoids `--secret` in `ps`) |
| `DEMO_ORG_SLUG` | Default org slug when auto-resolving org ID (defaults to `acme`) |

## Full workflow example

```bash
# 1. Login
synapseone login --email demo@acme.local

# 2. Create org + account
synapseone orgs create acme "ACME Corp"
synapseone accounts create prod Production

# 3. Create role + policy
synapseone roles create acc_abc123 wf-runner
synapseone policies create acc_abc123 wf-exec --file policy.json
synapseone attach rol_abc123 pol_abc123
synapseone assign usr_abc123 rol_abc123

# 4. Deploy + execute workflow
synapseone workflows create --template webhook-to-log --name demo
synapseone workflows activate wf_abc123
synapseone workflows exec wf_abc123 --data '{"value":21}'

# 5. Try a definition without saving + check history
synapseone workflows test-run --file def.json --input input.json
synapseone executions list --workflow-id wf_abc123 --limit 20

# 5. Check audit log
synapseone audit --limit 20
```
