# `danax-sdk-go` — danax SDK for Go (minimal)

Apache-2.0. Part of [danax](../../README.md) Tier-1 PaaS.

```bash
go get github.com/danax/danax-sdk-go
```

```go
import danax "github.com/danax/danax-sdk-go"

c := danax.New("http://localhost:8080")
out, err := c.Login("demo@acme.local")
// out["accessToken"] -> c.Token = ...
orgs, err := c.ListOrgs()
```

Cần Go ≥ 1.22 để chạy `go test ./...`. Xem thêm [docs/api.md](../../docs/api.md).

Forks: đổi module path `github.com/danax/danax-sdk-go` trong `go.mod` theo repo của bạn
(Go resolve package qua git tag, không cần publish registry riêng).
