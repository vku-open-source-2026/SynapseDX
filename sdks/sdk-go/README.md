# `synapsedx-sdk-go` — SynapseDX SDK for Go (full API coverage)

Apache-2.0. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

Zero external dependencies (standard library only). Requires Go >= 1.22.

## Install

```bash
# via the monorepo replace directive
go mod edit -replace github.com/synapsedx/synapsedx-sdk-go=./sdks/sdk-go
go mod tidy

# or from the registry
go get github.com/synapsedx/synapsedx-sdk-go@latest
```

## Quick start

```go
import synapsedx "github.com/synapsedx/synapsedx-sdk-go"

c := synapsedx.New("http://localhost:8080")
out, err := c.Login("demo@acme.local", "acme")
if err != nil { panic(err) }
c.SetToken(out["accessToken"].(string))
orgs, err := c.ListOrgs()
```

Full coverage: auth (login/refresh/logout/logout-all/verify/me), orgs, accounts,
users, roles, policies, authorize + dry-run, audit, API keys (+verify), service
accounts (+token), workflows (list/get/create from template or raw/activate/
deactivate/execute), templates, executions, LDS.

Data services & AI:

- **SynapseBase** — `Client.*Base*` methods plus the generic
  `NewBaseCollection[T]` typed collection with object↔data mapping.
- **Synapse Faststore** — `Client.Faststore*` for KV, counters, hashes, lists,
  sets, sorted sets, scans, batches and distributed locks.
- **SynapseQueue** — `Client.*Queue*` for publish (delay/dedupe), consume,
  ack/nack/heartbeat, dead letters and replay.
- **Synapse Inference Engine** — `Client.Inference*` for LLM chat proxy,
  self-hosted embeddings, Decision-2.0-Eos-0.8B structured questions and semantic routing.

Platform callers of Faststore/Queue set the tenant explicitly:

```go
c.SetTenant("acme") // x-synapsedx-tenant
```

## Full documentation

See **[docs/sdk-go.md](../../docs/sdk-go.md)** for the complete API reference —
client construction, auth, all methods with signatures, parameters, return types, and examples.

Forks: change the `github.com/synapsedx/synapsedx-sdk-go` module path in `go.mod` to your repo
(Go resolves packages via git tags, no separate registry publish needed).
