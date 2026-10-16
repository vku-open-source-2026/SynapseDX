# `synapsedx` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [SynapseDX](../README.md) Tier-1 PaaS. No `npm install` needed — single file, only Node's built-in `fetch`.

## Install

### One-line installer (recommended)

```bash
curl -fsSL https://synapsedx.sbs/install.sh | sh
```

### From npm registry

```bash
npm install -g @synapsedx/cli@latest
```

### Run without installing

```bash
npx -y @synapsedx/cli@latest --help
```

### From source

```bash
# Run directly
node tools/cli/bin/synapsedx.js --help

# Or link globally
npm link ./tools/cli
# then call `synapsedx ...` anywhere
```

## Quick start

```bash
export SYNAPSEDX_BASE_URL=http://localhost:8080
synapsedx login --email demo@acme.local
synapsedx orgs
synapsedx accounts create prod Production
synapsedx authz <user-id> workflow:Execute "*" --context team=etl
synapsedx workflows create --template webhook-to-log --name demo
synapsedx audit --limit 20
```

Against the live demo: add `--base https://api.synapsedx.sbs` (or `export SYNAPSEDX_BASE_URL=https://api.synapsedx.sbs`) and sign in with an API key (`synapsedx use-key <key>`).

## Configuration

### Base URL resolution

The CLI resolves the base URL in this order (first match wins):

1. `--base <URL>` flag
2. `$SYNAPSEDX_BASE_URL` environment variable
3. `baseUrl` in `~/.synapsedx/config.json`
4. `http://localhost:8080` (default)

### Auth resolution

The CLI resolves credentials in this order (first match wins):

1. `--token <jwt>` / `--apikey <key>` flags
2. `$SYNAPSEDX_TOKEN` / `$SYNAPSEDX_API_KEY` environment variables
3. `token` / `apiKey` in `~/.synapsedx/config.json`

> **Security note:** Prefer env vars or config file over `--token`/`--apikey` flags, since flags are visible via `ps` and shell history.

### Config file

`synapsedx login` and `synapsedx use-key` save credentials to `~/.synapsedx/config.json` (file permissions `0600`, owner-only). The refresh token is also stored for `refresh` / `logout-all` reuse.

```bash
# Show saved config (secrets are redacted)
synapsedx config
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
synapsedx login --email <email> [--org <slug>] [--base <url>]
```
Dev login. Saves token + refresh token to config.

```bash
synapsedx login --email demo@acme.local
synapsedx login --email alice@acme.local --org acme
```

#### `refresh`
```bash
synapsedx refresh [refresh-token]
```
Rotates the access token (atomic server-side). Uses `$SYNAPSEDX_REFRESH_TOKEN` or config if no argument given.

```bash
synapsedx refresh
synapsedx refresh eyJhbGciOi...
```

#### `logout-all`
```bash
synapsedx logout-all [refresh-token]
```
Revokes ALL sessions of the token owner.

```bash
synapsedx logout-all
```

#### `logout`
```bash
synapsedx logout
```
Clears saved credentials from config.

#### `verify`
```bash
synapsedx verify
```
Checks the current Bearer token or API key.

#### `use-key`
```bash
synapsedx use-key <api-key>
```
Saves an API key to config (instead of a token).

```bash
synapsedx use-key sk_live_abc123...
```

#### `whoami`
```bash
synapsedx whoami
```
Shows the current user (`/v1/auth/me`).

#### `config`
```bash
synapsedx config
```
Shows saved config with secrets redacted.

### Organizations

#### `orgs`
```bash
synapsedx orgs
synapsedx orgs list
```
Lists all organizations.

#### `orgs create`
```bash
synapsedx orgs create <slug> [name]
```
Creates an organization.

```bash
synapsedx orgs create acme2 "ACME 2"
```

### Accounts

#### `accounts`
```bash
synapsedx accounts [org]
synapsedx accounts list [org]
```
Lists accounts in an organization. If no org is given, uses the first available org.

#### `accounts create`
```bash
synapsedx accounts create [org] <slug> [name]
```
Creates an account under an organization.

```bash
synapsedx accounts create prod Production
synapsedx accounts create my-org prod Production
```

### Users

#### `users`
```bash
synapsedx users [org]
synapsedx users list [org]
```
Lists users in an organization.

#### `users create`
```bash
synapsedx users create <org> <email> [name]
```
Creates a user in an organization.

```bash
synapsedx users create my-org alice@acme.local "Alice"
```

#### `users policies`
```bash
synapsedx users policies <user-id>
```
Shows the effective policy documents of a user.

```bash
synapsedx users policies usr_abc123
```

### Roles

#### `roles`
```bash
synapsedx roles <account>
synapsedx roles list <account>
```
Lists roles in an account.

#### `roles create`
```bash
synapsedx roles create <account> <slug>
```
Creates a role in an account.

```bash
synapsedx roles create acc_abc123 etl-runner
```

#### `roles delete`
```bash
synapsedx roles delete <role-id>
```
Deletes a role.

```bash
synapsedx roles delete rol_abc123
```

### Policies

#### `policies`
```bash
synapsedx policies <account>
synapsedx policies list <account>
```
Lists policies in an account.

#### `policies create`
```bash
synapsedx policies create <account> <slug> --file <policy.json>
```
Creates an IAM policy from a JSON file.

```bash
synapsedx policies create acc_abc123 wf-exec --file policy.json
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
synapsedx policies delete <policy-id>
```
Deletes a policy.

```bash
synapsedx policies delete pol_abc123
```

### Role-policy attachment

#### `attach`
```bash
synapsedx attach <role-id> <policy-id>
```
Attaches a policy to a role.

```bash
synapsedx attach rol_abc123 pol_abc123
```

#### `assign`
```bash
synapsedx assign <user-id> <role-id>
```
Assigns a role to a user.

```bash
synapsedx assign usr_abc123 rol_abc123
```

### Authorization

#### `authz`
```bash
synapsedx authz <user-id> <action> <resource> [--context k=v]
```
Checks whether a user is authorized to perform an action on a resource.

```bash
synapsedx authz usr_abc123 workflow:Execute "*"
synapsedx authz usr_abc123 workflow:Execute "wf_123" --context team=etl
```

#### `sim`
```bash
synapsedx sim --file <policy.json> <action> <resource> [--context k=v]
```
Dry-runs policy documents without a user (like AWS IAM Policy Simulator).

```bash
synapsedx sim --file policy.json workflow:Execute "*"
synapsedx sim --file policies.json workflow:Execute "wf_123" --context env=prod
```

The `--file` can contain a single policy object or an array of policies.

### Audit

#### `audit`
```bash
synapsedx audit [--limit <N>] [--actor <id>]
```
Reads the audit log.

```bash
synapsedx audit
synapsedx audit --limit 20
synapsedx audit --limit 50 --actor usr_abc123
```

### API keys

#### `keys create`
```bash
synapsedx keys create <account> [--name <name>]
```
Creates an API key. The key is shown once — save it immediately.

```bash
synapsedx keys create acc_abc123 --name ci-deploy
```

#### `keys revoke`
```bash
synapsedx keys revoke <key-id>
```
Revokes an API key.

```bash
synapsedx keys revoke key_abc123
```

#### `keys list`
```bash
synapsedx keys list <account>
```
Lists key metadata (id/prefix only — never secret values).

```bash
synapsedx keys list acc_abc123
```

#### `keys verify`
```bash
synapsedx keys verify <api-key>
```
Checks a raw API key via the internal verify endpoint.

```bash
synapsedx keys verify sk_live_abc123...
```

### Service accounts

#### `sa`
```bash
synapsedx sa <account>
synapsedx sa list <account>
```
Lists service accounts in an account.

#### `sa create`
```bash
synapsedx sa create <account> <slug>
```
Creates a service account.

```bash
synapsedx sa create acc_abc123 etl-bot
```

#### `sa token`
```bash
synapsedx sa token <sa-id>
```
Mints a short-lived JWT for a service account. The token is shown once — save it immediately.

```bash
synapsedx sa token sa_abc123
```

### Credentials (PROPOSED — backend in progress)

Account-scoped secrets for workflow nodes. Secrets are encrypted at rest and
**never returned**: `create`/`rotate` take a secret once; `list`/`get` return
metadata only (`{id, name, type, accountId, expiresAt, version}`).
Prefer `--secret-file` (or `$SYNAPSEDX_CREDENTIAL_SECRET`) over `--secret` —
flags leak via `ps` and shell history.

#### `credentials create`
```bash
synapsedx credentials create <account> --name <name> --type bearer|basic|apiKey|oauth2 (--secret <S> | --secret-file <path>) [--expires-at <ISO>]
```

```bash
# Copy-paste: store a bearer token, then verify only metadata comes back.
echo -n 'tok_live_abc' > /tmp/stripe-secret
synapsedx credentials create acc_abc123 --name stripe-live --type bearer --secret-file /tmp/stripe-secret --expires-at 2027-01-01T00:00:00Z
synapsedx credentials list acc_abc123
```

#### `credentials list` / `credentials get`
```bash
synapsedx credentials [list] <account>
synapsedx credentials get <credential-id>
```

```bash
synapsedx credentials list acc_abc123
synapsedx credentials get cred_abc123
```

#### `credentials rotate`
```bash
synapsedx credentials rotate <credential-id> (--secret <S> | --secret-file <path>)
```
Replaces the secret and bumps `version` (the old secret stops working).

```bash
echo -n 'tok_live_xyz' > /tmp/stripe-secret-v2
synapsedx credentials rotate cred_abc123 --secret-file /tmp/stripe-secret-v2
```

#### `credentials delete`
```bash
synapsedx credentials delete <credential-id>
```

```bash
synapsedx credentials delete cred_abc123
```

### Generic call (escape hatch)

#### `call`
```bash
synapsedx call <METHOD> <path> [--data '{...}'|body.json] [--file body.json]
```
Calls any gateway endpoint directly — forward-compat with endpoints added after
this CLI (e.g. the proposed credentials API).

```bash
synapsedx call GET /v1/accounts/acc_abc123/credentials
synapsedx call POST /v1/workflows/test-run --data '{"definition":{"nodes":[],"connections":{}},"input":{}}'
```

### Workflows

#### `workflows`
```bash
synapsedx workflows
synapsedx workflows list
```
Lists all workflows.

#### `workflows create` (from template)
```bash
synapsedx workflows create --template <name> [--name <name>]
```
Instantiates a built-in template.

```bash
synapsedx workflows create --template webhook-to-log --name my-webhook
```

#### `workflows create` (from file)
```bash
synapsedx workflows create --file <definition.json> [--name <name>]
```
Creates a workflow from a raw workflow definition JSON file. The file can contain either a full body (`{"template": ..., "name": ...}` or `{"definition": ..., "name": ...}`) or a bare definition.

```bash
synapsedx workflows create --file my-workflow.json --name my-wf
```

#### `workflows get`
```bash
synapsedx workflows get <workflow-id>
```
Gets a single workflow by ID.

```bash
synapsedx workflows get wf_abc123
```

#### `workflows activate`
```bash
synapsedx workflows activate <workflow-id>
```
Activates a workflow.

```bash
synapsedx workflows activate wf_abc123
```

#### `workflows deactivate`
```bash
synapsedx workflows deactivate <workflow-id>
```
Deactivates a workflow.

```bash
synapsedx workflows deactivate wf_abc123
```

#### `workflows exec`
```bash
synapsedx workflows exec <workflow-id> [--data '{"k":v}'|input.json] [--file payload.json]
synapsedx workflows execute <workflow-id> [--data ...] [--file ...]
```
Triggers a manual execution (the request body IS the workflow input).
`--data` takes inline JSON or a path to a JSON file; `--file` reads the
payload from a file (a bare input object, or `{input: {...}}`).

```bash
synapsedx workflows exec wf_abc123
synapsedx workflows exec wf_abc123 --data '{"value":21}'
echo '{"value":21}' > input.json
synapsedx workflows exec wf_abc123 --data input.json
```

#### `workflows test-run`
```bash
synapsedx workflows test-run --file <definition.json> [--input '{"k":v}'|input.json]
```
Tries a definition without saving (`POST /v1/workflows/test-run {definition, input}`).
`--file` (required) holds a bare `{nodes, connections}` definition or
`{definition, input}`; `--input` (inline JSON or JSON file) overrides the input.

```bash
# Copy-paste: try the code-transform template without saving.
synapsedx templates code-transform --json > def.json
echo '{"value":21}' > input.json
synapsedx workflows test-run --file def.json --input input.json
synapsedx workflows test-run --file def.json --input '{"value":42}'
```

#### `workflows update`
```bash
synapsedx workflows update <workflow-id> [--name <name>] [--file <definition.json>]
```
Updates a workflow's name and/or definition (at least one of `--name`/`--file`).

```bash
synapsedx workflows update wf_abc123 --name renamed
```

#### `workflows delete`
```bash
synapsedx workflows delete <workflow-id>
```
Deletes a workflow on the engine (`rm` is an alias).

```bash
synapsedx workflows delete wf_abc123
```

### Templates

#### `templates`
```bash
synapsedx templates
synapsedx templates list
```
Lists all built-in workflow templates.

#### `templates <name>`
```bash
synapsedx templates <name>
```
Fetches a single built-in template definition by name.

```bash
synapsedx templates webhook-to-log
```

### Executions

> The engine always returns the envelope `{data: [...]}` for `GET /v1/executions`.
> The CLI unwraps it — list output is the plain execution array.

#### `executions`
```bash
synapsedx executions
synapsedx executions list [--limit <N>] [--offset <N>] [--workflow-id <ID>] [--status success|error|running] [--include-data]
```
Lists workflow executions. Allowed filters mirror the server allowlist
(`limit`/`offset` `0..9999`, `offset=0` = first page).

```bash
synapsedx executions
synapsedx executions list --limit 10
synapsedx executions list --workflow-id wf_abc123 --status success --limit 20 --offset 20
synapsedx executions list --limit 5 --include-data  # per-node I/O
```

#### `executions <id>`
```bash
synapsedx executions <execution-id> [--include-data]
```
Gets a single execution by ID (`--include-data` adds per-node input/output).

```bash
synapsedx executions exe_abc123
synapsedx executions exe_abc123 --include-data
```

### Webhooks (public, no auth)

`ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares
that `path`. No token needed. NOTE: the gateway does **not** proxy `/webhook/*` —
point `--base` at the workflow-service origin (default `http://localhost:4002`
for local dev), not the gateway.

#### `webhook`
```bash
synapsedx webhook <path> [--data '{"k":v}'|payload.json] [--file payload.json] [--method POST] [--base http://localhost:4002]
```
Fires a public inbound webhook.

```bash
# Copy-paste: activate the code-transform template, then fire its webhook.
synapsedx workflows create --template code-transform --name demo-transform
synapsedx workflows activate <wf-id>
synapsedx webhook transform --data '{"value":21}' --base http://localhost:4002
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
synapsedx --json orgs
synapsedx --json workflows list
```

## Environment variables

| Variable | Description |
|---|---|
| `SYNAPSEDX_BASE_URL` | Gateway URL |
| `SYNAPSEDX_TOKEN` | Bearer JWT |
| `SYNAPSEDX_API_KEY` | API key |
| `SYNAPSEDX_REFRESH_TOKEN` | Refresh token (for `refresh` / `logout-all`) |
| `SYNAPSEDX_CREDENTIAL_SECRET` | Credential secret (for `credentials create` / `rotate`, avoids `--secret` in `ps`) |
| `DEMO_ORG_SLUG` | Default org slug when auto-resolving org ID (defaults to `acme`) |

## Full workflow example

```bash
# 1. Login
synapsedx login --email demo@acme.local

# 2. Create org + account
synapsedx orgs create acme "ACME Corp"
synapsedx accounts create prod Production

# 3. Create role + policy
synapsedx roles create acc_abc123 wf-runner
synapsedx policies create acc_abc123 wf-exec --file policy.json
synapsedx attach rol_abc123 pol_abc123
synapsedx assign usr_abc123 rol_abc123

# 4. Deploy + execute workflow
synapsedx workflows create --template webhook-to-log --name demo
synapsedx workflows activate wf_abc123
synapsedx workflows exec wf_abc123 --data '{"value":21}'

# 5. Try a definition without saving + check history
synapsedx workflows test-run --file def.json --input input.json
synapsedx executions list --workflow-id wf_abc123 --limit 20

# 5. Check audit log
synapsedx audit --limit 20
```
