# `synapsedx-sdk-go` — SynapseDX SDK for Go (full API coverage)

Apache-2.0. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

```bash
go get github.com/synapsedx/synapsedx-sdk-go
```

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
deactivate/execute), templates, executions.

Cần Go ≥ 1.22 để chạy `go test ./...`. Xem thêm [docs/api.md](../../docs/api.md).

Forks: đổi module path `github.com/synapsedx/synapsedx-sdk-go` trong `go.mod` theo repo của bạn
(Go resolve package qua git tag, không cần publish registry riêng).
