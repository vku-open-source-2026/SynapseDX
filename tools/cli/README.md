# `synapsedx` CLI — zero-dependency command line (Node 18+)

Apache-2.0. Part of [SynapseDX](../../README.md) Tier-1 PaaS. No `npm install` needed —
single file, only Node's built-in `fetch`.

## Install

```bash
# one-line installer (installs @synapsedx/cli@latest globally)
curl -fsSL https://synapsedx.sbs/install.sh | sh

# ..or from the registry directly:
npm install -g @synapsedx/cli@latest

# ..or run without installing anything:
npx -y @synapsedx/cli@latest --help

# ..or from source:
node tools/cli/bin/synapsedx.js --help
# or link globally:
npm link ./tools/cli   # then call `synapsedx ...` anywhere
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

Against the live demo: add `--base https://api.synapsedx.sbs` (or
`export SYNAPSEDX_BASE_URL=https://api.synapsedx.sbs`) and sign in with an API key
(`synapsedx use-key <key>`).

## Full documentation

See **[docs/cli.md](../../docs/cli.md)** for the complete CLI reference —
configuration, global flags, all commands with usage, parameters, and examples.
