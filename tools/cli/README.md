# `synapseone` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [SynapseOne](../../README.md) Tier-1 PaaS. No `npm install` needed —
single file, only Node's built-in `fetch`.

## Install

```bash
# one-line installer (installs @synapseone/cli@latest globally)
curl -fsSL https://synapseone.space/install.sh | sh

# ..or from the registry directly:
npm install -g @synapseone/cli@latest

# ..or run without installing anything:
npx -y @synapseone/cli@latest --help

# ..or from source:
node tools/cli/bin/synapseone.js --help
# or link globally:
npm link ./tools/cli   # then call `synapseone ...` anywhere
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

## Full documentation

See **[docs/cli.md](../../docs/cli.md)** for the complete CLI reference —
configuration, global flags, all commands with usage, parameters, and examples.
