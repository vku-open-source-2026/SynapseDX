# synapsedx — Rust SDK

Async Rust client for the [SynapseDX](https://synapsedx.sbs) Tier-2
capabilities API. It mirrors the published `@synapsedx/capabilities` JS client:
datasets, records, events, auth, AI, jobs, files, notifications, warehouse,
knowledge, hazards, geo, audit and usage.

```toml
[dependencies]
synapsedx = "0.7"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
serde_json = "1"
```

## Quick start

```rust
use serde_json::json;
use synapsedx::{Client, Credentials, RecordQuery, RequestOptions};

#[tokio::main]
async fn main() -> synapsedx::Result<()> {
    let client = Client::builder("https://synapsedx.sbs")
        .api_key("synapsedx_...")
        .tenant("acme")
        .product("city")
        .build()?;

    let page = client
        .records()
        .query(
            "dataset-id",
            RecordQuery::new().filter(json!({ "status": "new" })).limit(50),
            &RequestOptions::new(),
        )
        .await?;

    for record in page.items {
        println!("{} {}", record.id, record.data);
    }
    Ok(())
}
```

## Namespaces

| Handle | Coverage |
| --- | --- |
| `datasets()` | list/list_page/get/create/update/delete/publish/revoke/entities |
| `records()` | list/query/get/create/update/delete/bulk_create/iterate |
| `events()` | event feed + outbox flush |
| `auth()` | login/register/refresh/logout/password/email/OIDC/exchange |
| `ai()` | status/chat/embeddings/decision/route |
| `jobs()` | CRUD, runs, kinds, lease/heartbeat/complete |
| `files()` | create/upload/download/public/presign/complete/delete/quota |
| `notifications()` | send/get/list/cancel/templates/preferences |
| `warehouse()` | datasets, SQL, ETL, reports, dashboards, use cases |
| `knowledge()` | index/PDF ingest/list/query/status |
| `hazards()` | today/brief/status/KTTV crawler |
| `geo()` | autocomplete/geocode/reverse/place |
| `audit()` / `usage()` | audit log, usage summary/events |
| `health()` | `/v1/capabilities/health`, `/ready`, capability advertisement |

Raw endpoints:

```rust
let value = client
    .raw_request(http::Method::GET, "/v1/capabilities/something", None, &opts)
    .await?;
```

## Headers and request options

`RequestOptions` supports per-call overrides:

```rust
let opts = RequestOptions::new()
    .idempotency_key("order-123")
    .if_version(4)
    .tenant("other-tenant")
    .correlation_id("trace-1")
    .timeout(std::time::Duration::from_secs(10));

client
    .records()
    .update("dataset-id", "record-id", json!({ "status": "done" }), Some(true), &opts)
    .await?;
```

* Auth: `Authorization: Bearer` or `x-api-key` (or both).
* Tenant: `x-synapseone-tenant`; product: `x-synapsedx-product`.
* Every request gets `x-correlation-id` (generated when omitted).
* `if_version(n)` sends `if-match: "n"`.
* `idempotency_key` makes POST/PATCH retryable.
* `anonymous()` drops credentials for public file endpoints.

Retries are enabled for idempotent requests on network errors and `5xx/429`
(one retry by default).

## Errors

```rust
match client.datasets().get("missing", &opts).await {
    Err(error) if error.is_not_found() => { /* ... */ }
    Err(error) => eprintln!("{} code={:?} request={:?}", error, error.code(), error.request_id()),
    Ok(dataset) => println!("{}", dataset.name),
}
```

## Development

```bash
cargo test
cargo clippy --all-targets
cargo fmt --check
```

MSRV: 1.82. License: Apache-2.0.

## Publishing

Manual:

```bash
cargo publish --dry-run
cargo publish
```

CI (recommended): add the `CARGO_REGISTRY_TOKEN` repository secret and push a
tag that matches `Cargo.toml`:

```bash
git tag sdk-rust-v0.7.0
git push origin sdk-rust-v0.7.0
```

`.github/workflows/sdk-rust-publish.yml` runs format/clippy/tests, verifies the
tag, checks whether that exact version already exists and publishes only when
needed. Re-running a release tag is a no-op.

If `synapsedx` is unavailable, rename the package in `Cargo.toml` and keep the
library name via `[lib] name = "synapsedx"`.
