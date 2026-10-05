# `olp-sdk-go` — OLP SDK for Go (minimal)

Apache-2.0. Part of [OLP](../../README.md) Tier-1 PaaS.

```bash
go get github.com/olp/olp-sdk-go
```

```go
import olp "github.com/olp/olp-sdk-go"

c := olp.New("http://localhost:8080")
out, err := c.Login("demo@acme.local")
// out["accessToken"] -> c.Token = ...
orgs, err := c.ListOrgs()
```

Cần Go ≥ 1.22 để chạy `go test ./...`. Xem thêm [docs/api.md](../../docs/api.md).
