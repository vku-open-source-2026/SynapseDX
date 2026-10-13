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
| `--limit <N>` | Limit results |
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
Creates a workflow from a raw n8n definition JSON file. The file can contain either a full body (`{"template": ..., "name": ...}` or `{"definition": ..., "name": ...}`) or a bare n8n definition.

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
synapsedx workflows exec <workflow-id>
synapsedx workflows execute <workflow-id>
```
Triggers a manual execution (proxied to the engine).

```bash
synapsedx workflows exec wf_abc123
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

#### `executions`
```bash
synapsedx executions
synapsedx executions list [--limit <N>]
```
Lists workflow executions.

```bash
synapsedx executions
synapsedx executions list --limit 10
```

#### `executions <id>`
```bash
synapsedx executions <execution-id>
```
Gets a single execution by ID.

```bash
synapsedx executions exe_abc123
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
synapsedx workflows exec wf_abc123

# 5. Check audit log
synapsedx audit --limit 20
```
