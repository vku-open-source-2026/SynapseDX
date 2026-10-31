# Synapse Faststore — cache, key/value and data structures

Synapse Faststore is the platform's Redis-backed data-structure service: string
keys with TTLs, atomic counters, hashes, lists, sets, sorted sets, bulk reads,
key scans and distributed locks — all tenant-scoped.

- Service: `apps/faststore-service` · port **4006** · gateway prefix `/v1/faststore`
- Storage: Redis (`FASTSTORE_REDIS_URL` / `REDIS_URL`) with an in-memory fallback
  for dev/tests
- Auth: gateway JWT/API key (`either`); direct calls need
  `x-synapseone-internal: <SYNAPSEONE_INTERNAL_SECRET>` when configured
- SDKs: `client.faststore` (Python/JS), `Client.Faststore*` (Go)

## Tenancy

Every operation is namespaced by the caller's tenant:

| Principal | Namespace |
|---|---|
| Org (`x-synapseone-org`) | `org:<org>` |
| Account only (`x-synapseone-account`) | `account:<account>` |
| User only | `user:<sub>` |
| Platform caller | `tenant:<x-synapseone-tenant>` or `?tenant=<name>` |

- Tenant names provided by platform callers must be 1..128 chars (no control
  characters).
- The gateway strips client-supplied `x-synapseone-user/org/account/...` headers
  but forwards `x-synapseone-tenant`; for principal callers the verified
  principal always wins, so a client cannot choose another tenant by sending it.
- Platform callers (internal calls with no principal and no anonymous marker)
  **must** pass a tenant, otherwise `400 tenant_required`.
- Anonymous (public) calls are rejected with `401 auth_required`.
- Keys from different tenants never collide, even with identical names.

## Quick start

```bash
TOKEN=$(curl -s -XPOST localhost:8080/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

# string with a 5-minute TTL
curl -s -XPUT localhost:8080/v1/faststore/keys/cache:park:1 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'

curl -s localhost:8080/v1/faststore/keys/cache:park:1 \
  -H "Authorization: Bearer $TOKEN"
# → {"key":"cache:park:1","type":"string","value":{"name":"Central"},"ttlSeconds":299}

# atomic counter
curl -s -XPOST localhost:8080/v1/faststore/keys/visits/incr \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"by":1}'

# hash + list
curl -s -XPUT localhost:8080/v1/faststore/hashes/user:1 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"values":{"name":"Alice","plan":"pro"}}'
curl -s -XPOST localhost:8080/v1/faststore/lists/jobs/push \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"values":[{"id":1},{"id":2}],"side":"right"}'
```

## Key/value strings

A "string" key can hold any JSON value (object, array, number, string, boolean,
`null`). Values are returned as-is.

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/faststore/stats` | Tenant stats |
| `GET` | `/v1/faststore/keys` | Scan keys (`prefix`, `limit`, `cursor`) |
| `GET` | `/v1/faststore/keys/:key` | Read a key of any type |
| `PUT`/`POST` | `/v1/faststore/keys/:key` | Write a string key |
| `DELETE` | `/v1/faststore/keys/:key` | Delete a key of any type |
| `GET` | `/v1/faststore/keys/:key/ttl` | Remaining TTL |
| `POST` | `/v1/faststore/keys/:key/expire` | Set or clear the TTL |
| `POST` | `/v1/faststore/keys/:key/incr` | Atomic numeric increment |
| `POST` | `/v1/faststore/batch` | Batch key/value operations |

### Write

```json
{"value": {"name": "Central"}, "ttlSeconds": 300, "ifNotExists": true}
```

| Field | Meaning |
|---|---|
| `value` | required; any JSON value |
| `ttlSeconds` | 1..2,592,000 (30 days). `0` removes an existing TTL. Omit to keep the current TTL on overwrite (new keys have none) |
| `ifNotExists` | only write when the key is absent (`409 key_exists` otherwise) |
| `ifExists` | only write when the key exists (`404 not_found` otherwise) |

`ifNotExists` and `ifExists` are mutually exclusive (`400 invalid_request`).
Response: `201 {ok,key,created:true}` when created, `200 ... created:false` when
overwritten.

### Read

```json
{"key": "cache:park:1", "type": "string", "value": {"name": "Central"}, "ttlSeconds": 299}
```

- `type` is one of `string`, `hash`, `list`, `set`, `zset`; the `value` shape follows
  the type (`hash` → object, `list`/`set` → array, `zset` → `[{member,score}]`).
- `ttlSeconds` is the remaining TTL, or `null` when the key has no expiry.
- Missing key → `404 not_found`.

### Delete

`DELETE /v1/faststore/keys/:key` deletes any key type and returns
`{key, deleted}` (`deleted:false` when it did not exist).

### TTL and expire

`GET /v1/faststore/keys/:key/ttl` → `{key, ttlSeconds}` where `-1` means **no
expiry**; a missing key is `404 not_found`.

`POST /v1/faststore/keys/:key/expire {"ttlSeconds": 60}` sets a new TTL;
`{"ttlSeconds": 0}` removes it. Returns `{ok, key, ttlSeconds}` or `404` when the
key does not exist.

### Atomic counters

`POST /v1/faststore/keys/:key/incr`

```json
{"by": 1, "ttlSeconds": 60}
```

- `by` is an integer in `-1,000,000,000..1,000,000,000` (default `1`).
- Missing keys start at `0`; the result is `{key, value}`.
- A non-numeric value → `400 not_a_number`; a non-string type → `409 wrong_type`.
- `ttlSeconds` (optional) is applied to the key on success; `0` clears the TTL.

### Batch

`POST /v1/faststore/batch`

```json
{
  "operations": [
    {"op": "set", "key": "a", "value": 1, "ttlSeconds": 60},
    {"op": "get", "key": "a"},
    {"op": "incr", "key": "a", "by": 2},
    {"op": "expire", "key": "a", "ttlSeconds": 0},
    {"op": "delete", "key": "a"}
  ]
}
```

- 1..100 operations, processed in order. Supported ops: `set`, `get`, `delete`,
  `incr`, `expire`.
- Each result reports `{ok, op, key, ...}`; failures do not abort the batch.
  Unsupported ops return `{ok:false, error:"unsupported_op"}`.
- `get` results include `found`, and when found `type`, `value`, `ttlSeconds`.

### Scans and stats

`GET /v1/faststore/keys?prefix=&limit=100&cursor=`

```json
{"keys": [{"key": "user:1", "type": "hash", "ttlSeconds": null}], "cursor": "1", "truncated": false}
```

- `prefix` ≤ 256 chars; `limit` 1..500 (default 100); `cursor` is the opaque
  numeric offset from the previous response.
- `cursor: null` means the scan is finished. `truncated: true` means the tenant
  exceeded the internal scan cap (the scan is incomplete, not merely paged).
- `ttlSeconds` is `null` for keys without expiry.

`GET /v1/faststore/stats` →

```json
{
  "backend": "redis",
  "tenant": "org:acme",
  "keys": 12,
  "byType": {"string": 5, "hash": 3, "list": 2, "set": 1, "zset": 1}
}
```

## Hashes

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/faststore/hashes/:key` | All fields: `{key, values, ttlSeconds}` |
| `PUT` | `/v1/faststore/hashes/:key` | Set 1..500 fields |
| `DELETE` | `/v1/faststore/hashes/:key` | Delete the hash |
| `GET` | `/v1/faststore/hashes/:key/length` | Field count |
| `GET` | `/v1/faststore/hashes/:key/:field` | One field: `{key, field, value, ttlSeconds}` |
| `PUT` | `/v1/faststore/hashes/:key/:field` | Set one field |
| `DELETE` | `/v1/faststore/hashes/:key/:field` | Delete one field |
| `POST` | `/v1/faststore/hashes/:key/incr` | Atomic field increment |

Set fields:

```json
{"values": {"name": "Alice", "plan": "pro"}, "ttlSeconds": 3600}
```

- `values` must be a non-array object with 1..500 entries; field names are
  1..256 printable chars.
- `ttlSeconds` is applied to the whole hash (`0` clears it).
- Writing a field to a key that holds another type → `409 wrong_type`.

Increment:

```json
{"field": "logins", "by": 1, "ttlSeconds": 3600}
```

`field` is required; the hash is created when missing. Non-numeric field →
`400 not_a_number`.

Reading a missing hash or field is `404 not_found`. Deleting a field that does
not exist returns `deleted:false`.

## Lists

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/faststore/lists/:key?start=0&stop=-1` | Range + `length` |
| `DELETE` | `/v1/faststore/lists/:key` | Delete the list |
| `POST` | `/v1/faststore/lists/:key/push` | Push 1..1000 values |
| `POST` | `/v1/faststore/lists/:key/pop` | Pop 1..1000 values |
| `POST` | `/v1/faststore/lists/:key/trim` | Trim to `[start, stop]` |
| `GET` | `/v1/faststore/lists/:key/length` | Length |

- `start`/`stop` use Redis semantics (0-based, negative counts from the end,
  `-1` = last); valid range `-1,000,000..1,000,000`.
- Push body: `{"values":[...], "side":"left"|"right", "ttlSeconds":3600}`
  (`side` defaults to `right`, 1..1000 values).
- Pop body: `{"side":"left"|"right", "count":1}` (`side` defaults to `left`,
  count 1..1000). Returns `{key, side, values, length}`.
- Trim body: `{"start":0,"stop":99}`; returns `{ok, key, start, stop}`.
- Reading a missing list returns `{values: [], length: 0}` (not 404). Pushing to a
  key of another type → `409 wrong_type`.

## Sets

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/faststore/sets/:key` | `{key, members, card}` |
| `DELETE` | `/v1/faststore/sets/:key` | Delete the set |
| `POST` | `/v1/faststore/sets/:key/add` | Add 1..1000 members |
| `POST` | `/v1/faststore/sets/:key/remove` | Remove members |
| `POST` | `/v1/faststore/sets/:key/contains` | Membership test |
| `GET` | `/v1/faststore/sets/:key/card` | Cardinality |

- Add body: `{"members":[...], "ttlSeconds":3600}`; returns `{ok, key, added, card}`.
- Remove body: `{"members":[...]}`; returns `{key, removed, card}`.
- Contains body: `{"member":...}`; returns `{key, member, contains}`.
- Missing sets behave as empty (`members: []`, `card: 0`); type conflicts are
  `409 wrong_type`.

## Sorted sets

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/faststore/zsets/:key?start=0&stop=-1&rev=&withScores=` | Range + `card` |
| `DELETE` | `/v1/faststore/zsets/:key` | Delete the sorted set |
| `POST` | `/v1/faststore/zsets/:key/add` | Add `{member,score}` entries |
| `POST` | `/v1/faststore/zsets/:key/incr` | Increment a member's score |
| `POST` | `/v1/faststore/zsets/:key/remove` | Remove members |
| `POST` | `/v1/faststore/zsets/:key/score` | Read a member's score |
| `POST` | `/v1/faststore/zsets/:key/rank` | 0-based rank |
| `GET` | `/v1/faststore/zsets/:key/card` | Cardinality |

- Range: `rev=true` returns highest score first; `withScores=true` returns
  `[{member,score}]` (without it, `members` is the member array). Redis
  `start`/`stop` semantics.
- Add body: `{"members":[{"member":"a","score":1.5}], "ttlSeconds":3600}`;
  scores must be finite numbers. Returns `{ok, key, added, card}`.
- Incr body: `{"member":"a","by":1}`; returns `{key, member, score}`.
- Score body: `{"member":"a"}`; returns `{key, member, score}` where `score` is
  `null` for an absent member.
- Rank body: `{"member":"a","rev":false}`; returns `{key, member, rank}`
  (`rank` is `null` for an absent member).
- Remove body: `{"members":[...]}`; returns `{key, removed, card}`.

## Distributed locks

Locks are tenant-scoped and token-owned. The token is returned by `acquire` and
must be supplied to `release`/`extend`; a different token cannot release or
extend the lock. Locks expire after their TTL, so always choose a TTL longer than
the critical section, or extend while working.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/faststore/locks/:name/acquire` | Acquire, optionally waiting |
| `POST` | `/v1/faststore/locks/:name/release` | Release your lock |
| `POST` | `/v1/faststore/locks/:name/extend` | Extend your lock's TTL |

Acquire:

```json
{"ttlSeconds": 30, "waitMs": 1000, "token": "optional-caller-token"}
```

- `ttlSeconds` 1..2,592,000 (default **30**); `waitMs` 0..10,000 (default 0).
- `token` is optional; the server generates one when omitted. Tokens are 1..256
  chars and are required for release/extend.
- Success: `{"acquired":true,"lock":name,"token":"...","ttlSeconds":30,"expiresAt":"..."}`.
- Failure: `{"acquired":false,"lock":name,"retryAfterMs":50,"ttlSeconds":30}`
  (HTTP 200 — check `acquired`).

Release body: `{"token":"..."}` → `{lock, released}`. Extend body:
`{"token":"...","ttlSeconds":30}` → `{lock, extended}`. `released:false` /
`extended:false` means the token did not own a live lock.

Lock names are 1..256 printable chars without `/` or `\`.

## Errors

All errors use `{error, message}`.

| Status | `error` | Typical cause |
|---|---|---|
| 400 | `invalid_key`, `invalid_field`, `invalid_lock_name`, `invalid_token`, `invalid_ttl`, `invalid_request`, `invalid_body`, `invalid_prefix`, `invalid_cursor`, `invalid_json` | bad input |
| 400 | `not_a_number` | `incr` on a non-numeric value |
| 401 | `auth_required`, `unauthorized` | anonymous caller / missing internal secret |
| 400 | `tenant_required` | platform caller without a tenant |
| 404 | `not_found` | missing key/field/hash, `ifExists` on an absent key, `/ttl` on a missing key |
| 409 | `key_exists`, `wrong_type` | `ifNotExists` conflict / key holds another type |
| 413 | `payload_too_large` | request body too large |
| 503 | `storage_unavailable` | Redis connection lost |
| 500 | `internal` | unexpected server error |

## Limits

| Limit | Value |
|---|---|
| Key | 1..512 printable chars, no `/`, `\` or control chars |
| Hash field | 1..256 printable chars |
| Lock name | 1..256 printable chars, no `/`, `\` |
| TTL | 1..2,592,000 seconds; `0` clears TTL on writes/expire |
| Batch | 1..100 operations |
| Hash write | 1..500 fields |
| List/set/zset write | 1..1000 values/members |
| List pop / scan `limit` | 1..1000 / 1..500 |
| `incr` / `by` | integer -1,000,000,000..1,000,000,000 |
| Lock wait | 0..10,000 ms |
| Request body | 2 MB (HTTP layer) |

## SDK usage

### Python

```python
from synapseone_sdk import SynapseOneClient

c = SynapseOneClient("http://localhost:8080", token=jwt)

c.faststore.set("cache:park:1", {"name": "Central"}, ttl_seconds=300, if_not_exists=True)
entry = c.faststore.get("cache:park:1")
print(entry["type"], entry["value"], entry["ttlSeconds"])
print(c.faststore.exists("cache:park:1"))        # 404 -> False
c.faststore.incr("visits", by=1)

c.faststore.hash_set("user:1", {"name": "Alice", "plan": "pro"}, ttl_seconds=3600)
c.faststore.hash_incr("user:1", "logins", by=1)

c.faststore.list_push("jobs", [{"id": 1}], side="left")
print(c.faststore.list_pop("jobs", count=10)["values"])

c.faststore.set_add("tags", ["a", "b"])
c.faststore.zset_add("scores", [{"member": "alice", "score": 10}])
print(c.faststore.zset_range("scores", with_scores=True)["members"])

lock = c.faststore.lock_acquire("report", ttl_seconds=60, wait_ms=500)
if lock["acquired"]:
    try:
        ...
    finally:
        c.faststore.lock_release("report", lock["token"])

page = c.faststore.list_keys(prefix="cache:", limit=100)
```

### JavaScript / TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient({ baseUrl: 'http://localhost:8080', token: jwt });

await c.faststore.set('cache:park:1', { name: 'Central' }, { ttlSeconds: 300, ifNotExists: true });
const entry = await c.faststore.get('cache:park:1');
await c.faststore.incr('visits', { by: 1 });

await c.faststore.hashSet('user:1', { name: 'Alice' }, { ttlSeconds: 3600 });
await c.faststore.listPush('jobs', [{ id: 1 }], { side: 'left' });

const lock = await c.faststore.lockAcquire('report', { ttlSeconds: 60, waitMs: 500 });
if (lock.acquired) await c.faststore.lockRelease('report', lock.token!);

// Batch
await c.faststore.batch([
  { op: 'set', key: 'a', value: 1, ttlSeconds: 60 },
  { op: 'incr', key: 'a', by: 2 },
  { op: 'get', key: 'a' },
]);
```

### Go

```go
c := synapseone.New("http://localhost:8080")
c.SetToken(jwt)
// Platform callers: c.SetTenant("acme") -> x-synapseone-tenant

_, err := c.FaststoreSet("cache:park:1", map[string]any{"name": "Central"},
    synapseone.FaststoreSetOptions{TTLSeconds: 300, IfNotExists: true})
entry, err := c.FaststoreGet("cache:park:1")
_, err = c.FaststoreIncr("visits", 1, 0)

_, err = c.FaststoreHashSet("user:1", map[string]any{"name": "Alice"}, 3600)
_, err = c.FaststoreListPush("jobs", []any{map[string]any{"id": 1}},
    synapseone.FaststoreListPushOptions{Side: "left"})

_, err = c.FaststoreSetAdd("tags", []any{"a", "b"}, 0)
_, err = c.FaststoreZSetAdd("scores",
    []synapseone.FaststoreZSetMember{{Member: "alice", Score: 10}}, 0)

lock, err := c.FaststoreLockAcquire("report", synapseone.FaststoreLockOptions{TTLSeconds: 60, WaitMS: 500})
if acquired, _ := lock["acquired"].(bool); acquired {
    _, _ = c.FaststoreLockRelease("report", lock["token"].(string))
}
```

## Operations

- `GET /health` → `{status, service:"faststore", version, backend:"redis"|"memory", time}`
- `GET /metrics` → `synapseone_faststore_up`,
  `synapseone_faststore_backend_info{backend="redis"|"memory"}`,
  `synapseone_faststore_http_requests_total{key="METHOD|route|status"}`,
  `synapseone_faststore_process_uptime_seconds`
- Production requires `SYNAPSEONE_INTERNAL_SECRET` and
  `FASTSTORE_REDIS_URL` (or `REDIS_URL`). Without Redis the service uses a
  per-process in-memory store — fine for local development, not for replicas.
- Redis keys live under `synapseone:faststore:v1:<tenant>:`; do not write that
  namespace directly.
