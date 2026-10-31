# SynapseQueue — tenant-scoped message queue

SynapseQueue is the platform's work queue: publish JSON payloads with optional
delays and deduplication, consume them with visibility-timeout leases, and
acknowledge, retry or dead-letter each delivery. It is designed for
**at-least-once** processing between services and background workers.

- Service: `apps/queue-service` · port **4007** · gateway prefix `/v1/queue`
- Storage: Redis (`QUEUE_REDIS_URL` / `REDIS_URL`) with an in-memory fallback
  for dev/tests
- Auth: gateway JWT/API key (`either`); direct calls need
  `x-synapseone-internal: <SYNAPSEONE_INTERNAL_SECRET>` when configured
- SDKs: `client.queue` (Python/JS), `Client.*Queue*` (Go)

## Delivery model

Every message moves through a small state machine:

```
publish ──▶ pending ──consume──▶ in-flight ──ack──▶ deleted
              ▲                    │
              │                    ├─nack(requeue)──▶ pending (retry)
              │                    └─nack(no requeue / maxAttempts)──▶ dead
              └──── lease expired (visibility timeout) ────┘
```

1. **Publish** stores the payload and makes the message available now or after
   `delaySeconds`.
2. **Consume** atomically leases up to 100 ready messages. Each leased message
   comes with a `receipt` and a `leaseExpiresAt` deadline. `attempts` is
   incremented on every delivery.
3. **Ack** the receipt to delete the message, or **nack** it to retry (optionally
   after a delay) or dead-letter it. Long handlers call **heartbeat** to extend
   the lease.
4. If a lease expires without ack/nack — worker crashed, network partition — the
   message is returned to `pending` and redelivered on the next consume. This is
   what makes delivery at-least-once, so **consumers must be idempotent**.
5. A message that exceeds `maxAttempts` (or is nacked with `requeue: false`) moves
   to the **dead-letter set**, where it can be inspected, replayed or deleted.

Two consequences worth remembering:

- `maxAttempts` is enforced on **nack**, not on lease expiry. A repeatedly
  crashing consumer can redeliver a message indefinitely; a consumer that
  positively rejects it will exhaust the budget and dead-letter it.
- Ack/nack with an unknown or already-used receipt returns `404 receipt_not_found`.
  A duplicate ack is not an error to retry blindly — check whether work was
  already completed.

## Tenancy

Every queue, message and receipt is namespaced by the caller's tenant:

| Principal | Namespace |
|---|---|
| Org (`x-synapseone-org`) | `org:<org>` |
| Account only (`x-synapseone-account`) | `account:<account>` |
| User only | `user:<sub>` |
| Platform caller | `tenant:<x-synapseone-tenant>` or `?tenant=<name>` |

- Tenant names provided by platform callers must be 1..128 chars (no control
  characters).
- The gateway strips client-supplied identity headers but forwards
  `x-synapseone-tenant`; for principal callers the verified principal always
  wins, so a client cannot choose another tenant by sending it.
- Platform callers (internal calls with no principal and no anonymous marker)
  **must** pass a tenant, otherwise `400 tenant_required`.
- Anonymous (public) calls are rejected with `401 auth_required`.
- Queue names are only unique per tenant; two tenants can both have a queue
  called `emails` and their messages never mix.

## Quick start

```bash
TOKEN=$(curl -s -XPOST localhost:8080/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

# 1. declare a queue (idempotent)
curl -s -XPUT localhost:8080/v1/queue/queues/emails \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxAttempts":5,"visibilityTimeoutSeconds":30}'

# 2. publish a message
curl -s -XPOST localhost:8080/v1/queue/queues/emails/messages \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"payload":{"to":"alice@acme.test","template":"welcome"},"dedupeKey":"welcome:alice"}'
# → {"ok":true,"queue":"emails","id":"...","duplicate":false,"message":{...}}

# 3. lease a batch of messages as a worker
curl -s -XPOST localhost:8080/v1/queue/queues/emails/consume \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"maxMessages":10,"consumer":"mailer-1"}'

# 4. acknowledge one processed message
curl -s -XPOST localhost:8080/v1/queue/queues/emails/ack \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"receipt":"<receipt from consume>"}'
```

## Queues

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/queue/queues` | List the tenant's queues |
| `PUT` | `/v1/queue/queues/:queue` | Create or update a queue |
| `GET` | `/v1/queue/queues/:queue` | Config plus current stats |
| `DELETE` | `/v1/queue/queues/:queue` | Delete a queue and all its data |
| `POST` | `/v1/queue/queues/:queue/purge` | Clear messages, keep the queue |
| `GET` | `/v1/queue/queues/:queue/stats` | Queue counters only |

Queue names must match `[A-Za-z][A-Za-z0-9_-]{0,63}`.

### Create or update

`PUT /v1/queue/queues/:queue`

```json
{"maxAttempts": 5, "visibilityTimeoutSeconds": 30}
```

| Field | Meaning |
|---|---|
| `maxAttempts` | 1..100, default **5**; delivery attempts before nack dead-letters |
| `visibilityTimeoutSeconds` | 1..3600, default **30**; lease length for consumed messages |

- Both fields are optional; omitted fields keep their current value (or the
  default for a new queue).
- Returns **201** with `{name, maxAttempts, visibilityTimeoutSeconds, createdAt,
  updatedAt}` when the queue was created, **200** with the same shape when it
  already existed.
- Publishing or consuming into a missing queue implicitly creates it with
  defaults, so an explicit `PUT` is only needed to set non-default config.
- Per-message `maxAttempts` overrides the queue default for that message.

### List and read

`GET /v1/queue/queues` → array of queue configs, sorted by name.

`GET /v1/queue/queues/:queue` → config plus nested `stats`:

```json
{
  "name": "emails",
  "maxAttempts": 5,
  "visibilityTimeoutSeconds": 30,
  "createdAt": "2026-10-21T09:00:00.000Z",
  "updatedAt": "2026-10-21T09:00:00.000Z",
  "stats": {
    "queue": "emails",
    "pending": 12,
    "inflight": 2,
    "dead": 1,
    "published": 40,
    "acked": 25,
    "retried": 2,
    "replayed": 0,
    "maxAttempts": 5,
    "visibilityTimeoutSeconds": 30
  }
}
```

Missing queue → `404 not_found`.

### Purge and delete

- `DELETE /v1/queue/queues/:queue` removes the queue and every key belonging to
  it — pending, in-flight, delayed and dead messages. Returns `{queue, deleted}`;
  `deleted:false` when the queue did not exist.
- `POST /v1/queue/queues/:queue/purge` clears **all** messages (pending,
  delayed, in-flight and dead) and resets counters, but keeps the queue and its
  config. Returns `{ok:true, queue, purged:true}`; `404 not_found` if the queue
  does not exist. In-flight consumers will later get `404 receipt_not_found`.

## Publishing

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/queue/queues/:queue/messages` | Publish one message |
| `POST` | `/v1/queue/queues/:queue/messages:batch` | Publish 1..100 messages |

```json
{
  "payload": {"to": "alice@acme.test", "template": "welcome"},
  "delaySeconds": 0,
  "maxAttempts": 5,
  "headers": {"traceId": "abc-123"},
  "id": "welcome-alice-1",
  "dedupeKey": "welcome:alice"
}
```

| Field | Meaning |
|---|---|
| `payload` | **required**; any JSON value (object, array, string, number, boolean, `null`) |
| `delaySeconds` | 0..604800 (7 days), default 0; message becomes ready after the delay |
| `maxAttempts` | 1..100; overrides the queue default for this message |
| `headers` | optional metadata object; up to 50 entries, names 1..64 printable chars, ≤8 KiB total |
| `id` | optional caller-supplied message id, 1..128 chars from `[A-Za-z0-9_@.:+-]`; otherwise a UUID |
| `dedupeKey` | optional 1..256 printable chars; suppress duplicates |

Success response:

```json
{
  "ok": true,
  "queue": "emails",
  "id": "welcome-alice-1",
  "duplicate": false,
  "message": {
    "id": "welcome-alice-1",
    "payload": {"to": "alice@acme.test", "template": "welcome"},
    "headers": {"traceId": "abc-123"},
    "publishedAt": "2026-10-21T09:00:00.000Z",
    "availableAt": "2026-10-21T09:00:00.000Z",
    "attempts": 0,
    "maxAttempts": 5,
    "dedupeKey": "welcome:alice",
    "dead": false
  }
}
```

- New message → **201**; deduplicated publish → **200** with `duplicate: true`
  and the **original** message id/message.
- Payloads are stored as JSON; the serialized payload must be ≤
  `QUEUE_MAX_PAYLOAD_BYTES` (default 262144, configurable 1024..1048576).
  Larger payloads return `413 payload_too_large`.
- `id` must be unique within the queue. Reusing a live id →
  `409 conflict` (`message '<id>' already exists`).
- Message ids remain reserved until the message is acked, deleted from the dead
  set, or the queue is purged/deleted.

### Deduplication

`dedupeKey` is a per-queue suppression window, not a scheduled uniqueness
constraint:

- While a message with that key **still exists** (pending, in-flight or dead),
  publishing again returns the original message with `duplicate: true` and does
  not create a second message.
- After the original is acked, deleted or purged, the same `dedupeKey` can be
  used for a new message.
- Retries that publish the same logical event should therefore use a stable
  dedupe key (for example `welcome:<userId>` or the source event id).

### Batch publish

`POST /v1/queue/queues/:queue/messages:batch`

```json
{
  "messages": [
    {"payload": {"n": 1}},
    {"payload": {"n": 2}, "delaySeconds": 60},
    {"payload": {"n": 3}, "dedupeKey": "batch:n3"}
  ]
}
```

- 1..100 entries; each entry accepts the same fields as a single publish.
- The call returns **200** even when individual messages fail. Inspect `ok` and
  `results`:

```json
{
  "queue": "emails",
  "ok": true,
  "results": [
    {"ok": true, "id": "...", "duplicate": false, "message": {...}},
    {"ok": false, "error": "payload_too_large", "message": "payload exceeds 262144 bytes"}
  ]
}
```

- Items are processed in order and a failure does not abort the rest.

## Consuming and acknowledging

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/queue/queues/:queue/consume` | Lease 1..100 ready messages |
| `POST` | `/v1/queue/queues/:queue/ack` | Ack one receipt or up to 100 |
| `POST` | `/v1/queue/queues/:queue/nack` | Retry or dead-letter a delivery |
| `POST` | `/v1/queue/queues/:queue/heartbeat` | Extend a lease |

### Consume

```json
{"maxMessages": 10, "visibilityTimeoutSeconds": 60, "consumer": "mailer-1"}
```

| Field | Meaning |
|---|---|
| `maxMessages` | 1..100, default 1 |
| `visibilityTimeoutSeconds` | 1..3600, default = queue config |
| `consumer` | optional label (≤128 printable chars); defaults to the principal's `sub`, else `worker` |

Response:

```json
{
  "queue": "emails",
  "count": 1,
  "visibilityTimeoutSeconds": 60,
  "messages": [
    {
      "id": "...",
      "payload": {"to": "alice@acme.test"},
      "publishedAt": "2026-10-21T09:00:00.000Z",
      "attempts": 1,
      "maxAttempts": 5,
      "dead": false,
      "consumer": "mailer-1",
      "receipt": "...",
      "leaseExpiresAt": "2026-10-21T09:01:00.000Z"
    }
  ]
}
```

- Only messages whose `availableAt` has passed are returned; delayed messages
  wait until their delay elapses.
- `attempts` is incremented by the delivery itself, so the first delivery reports
  `attempts: 1`.
- Consuming is a lease, not a delete. Work on the message, then ack or nack
  before `leaseExpiresAt`.
- If a lease expires, the message is moved back to pending (with its current
  attempt count) and can be delivered again.
- Empty result → `200` with `count: 0` and `messages: []`. Polling with a short
  sleep is expected; long-polling is not supported.

### Ack

```json
{"receipt": "<receipt>"}
```

→ `{ok:true, queue, receipt, id}`. Unknown or already-used receipt →
`404 receipt_not_found`.

Batch form (1..100 receipts):

```json
{"receipts": ["<receipt-1>", "<receipt-2>"]}
```

→ `{queue, ok, results:[{ok:true, receipt, id}, {ok:false, receipt,
error:"receipt_not_found"}]}`. The call is **200** even when some receipts fail.

### Nack

```json
{"receipt": "<receipt>", "requeue": true, "delaySeconds": 30, "error": "smtp timeout"}
```

| Field | Meaning |
|---|---|
| `receipt` | **required** |
| `requeue` | default `true`; `false` dead-letters immediately |
| `delaySeconds` | 0..604800; retry delay when requeueing |
| `error` | optional ≤1024 chars stored as `lastError` on the message |

Response:

```json
{"ok":true,"queue":"emails","id":"...","state":"retry","attempts":1,"availableAt":"..."}
```

or, when dead-lettered:

```json
{"ok":true,"queue":"emails","id":"...","state":"dead","attempts":5,"deadAt":"..."}
```

- A message is dead-lettered when `requeue:false` **or** its `attempts` has
  reached `maxAttempts`.
- `state:"retry"` means it is pending again (after `delaySeconds` if given).
- Unknown/previously-used receipt → `404 receipt_not_found`.

### Heartbeat

```json
{"receipt": "<receipt>", "visibilityTimeoutSeconds": 60}
```

→ `{ok:true, queue, receipt, leaseExpiresAt, visibilityTimeoutSeconds}`.
`visibilityTimeoutSeconds` defaults to the queue config. Call it before the
current lease expires, for example every `lease/2` while processing a large
job. An expired or unknown receipt → `404 receipt_not_found` — the message has
already been reclaimed.

## Inspection and dead letters

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/queue/queues/:queue/messages?limit=100&ready=` | Peek at pending messages |
| `GET` | `/v1/queue/queues/:queue/dead?limit=100` | List dead letters (newest first) |
| `POST` | `/v1/queue/queues/:queue/dead/:id/replay` | Requeue a dead letter |
| `DELETE` | `/v1/queue/queues/:queue/dead/:id` | Delete a dead letter |

### Peek

- `limit` 1..500, default 100.
- Returns pending messages (ready **and** delayed), ordered by availability.
- `ready=true` filters out messages whose `availableAt` is still in the future.
- Pending messages show `availableAt`; delayed ones therefore appear with a
  future timestamp. In-flight (leased) messages are not returned by peek.
- Peeking does not lease or modify messages, but it does reclaim expired leases
  first, so a crashed consumer's message reappears here.

```json
{
  "queue": "emails",
  "count": 1,
  "messages": [
    {"id": "...", "payload": {...}, "availableAt": "2026-10-21T09:00:00.000Z",
     "attempts": 0, "maxAttempts": 5, "dead": false}
  ]
}
```

### Dead letters

`GET .../dead?limit=100` returns dead messages most recently dead-lettered first:

```json
{
  "queue": "emails",
  "count": 1,
  "messages": [
    {"id": "...", "payload": {...}, "attempts": 5, "maxAttempts": 5,
     "lastError": "smtp timeout", "dead": true, "deadAt": "2026-10-21T09:10:00.000Z"}
  ]
}
```

### Replay

`POST .../dead/:id/replay`

```json
{"delaySeconds": 0, "resetAttempts": true}
```

- The message leaves the dead set, `dead`/`deadAt`/`lastError` are cleared, and it
  becomes pending after `delaySeconds`.
- `resetAttempts: true` resets `attempts` to 0, giving it a fresh budget;
  otherwise it keeps its exhausted count and will dead-letter on the next nack.
- Response: `{ok:true, queue, message}`. Missing/not-dead id →
  `404 dead_message_not_found`.

### Delete dead

`DELETE .../dead/:id` → `{queue, id, deleted}`; `deleted:false` when the id is
not in the dead set.

## Stats

`GET /v1/queue/queues/:queue/stats` returns:

| Field | Meaning |
|---|---|
| `pending` | Messages waiting to be consumed, **including delayed messages** |
| `inflight` | Messages currently leased to consumers |
| `dead` | Dead-lettered messages |
| `published` | Lifetime publishes (deduplicated publishes are not counted) |
| `acked` | Lifetime successful acks |
| `retried` | Lifetime nacks that requeued |
| `replayed` | Lifetime dead-letter replays |
| `maxAttempts` | Queue default |
| `visibilityTimeoutSeconds` | Queue default |

Counters are reset by `purge` and discarded with the queue. Stats calls and
consume/peek/heartbeat reclaim expired leases first, so `pending` and `inflight`
reflect a crashed worker within one call.

## Errors

All errors use `{error, message}`.

| Status | `error` | Typical cause |
|---|---|---|
| 400 | `invalid_queue`, `invalid_message_id`, `invalid_receipt`, `invalid_consumer`, `invalid_headers`, `invalid_payload`, `invalid_dedupe_key`, `invalid_request`, `invalid_body`, `invalid_json` | bad input |
| 401 | `auth_required`, `unauthorized` | anonymous caller / missing internal secret |
| 400 | `tenant_required` | platform caller without a tenant |
| 404 | `not_found`, `receipt_not_found`, `dead_message_not_found` | missing queue/receipt/dead letter |
| 409 | `conflict` | caller-supplied message `id` already exists |
| 413 | `payload_too_large` | payload or HTTP body exceeds the limit |
| 503 | `storage_unavailable` | Redis connection lost |
| 500 | `internal` | unexpected server error |

## Limits

| Limit | Value |
|---|---|
| Queue name | `[A-Za-z][A-Za-z0-9_-]{0,63}` |
| Message id | 1..128 chars `[A-Za-z0-9_@.:+-]` |
| Receipt | 1..512 printable chars |
| Payload | ≤ `QUEUE_MAX_PAYLOAD_BYTES` (default 262144; 1024..1048576) |
| Headers | ≤50 entries, names 1..64 chars, ≤8 KiB serialized |
| `delaySeconds` | 0..604800 (7 days) |
| Visibility timeout | 1..3600 seconds (default 30) |
| `maxAttempts` | 1..100 (default 5) |
| Consume batch | 1..100 messages |
| Ack batch | 1..100 receipts |
| Publish batch | 1..100 messages |
| Peek / dead list `limit` | 1..500 (default 100) |
| `consumer` label | ≤128 printable chars |
| `nack.error` | ≤1024 chars |
| Request body | 5 MB (HTTP layer) |

## SDK usage

### Python

```python
from synapseone_sdk import SynapseOneClient

c = SynapseOneClient("http://localhost:8080", token=jwt)

c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=60)

published = c.queue.publish(
    "emails",
    {"to": "alice@acme.test", "template": "welcome"},
    dedupe_key="welcome:alice",
    headers={"traceId": "abc-123"},
)
print(published["id"], published["duplicate"])

c.queue.publish_batch("emails", [
    {"payload": {"n": 1}},
    {"payload": {"n": 2}, "delaySeconds": 30},
])

batch = c.queue.consume("emails", max_messages=10, consumer="mailer-1")
for msg in batch["messages"]:
    try:
        send(msg["payload"])
        c.queue.ack("emails", msg["receipt"])
    except Exception as exc:
        c.queue.nack("emails", msg["receipt"], delay_seconds=30, error=str(exc))

# Long job: keep the lease alive.
c.queue.heartbeat("emails", receipt, visibility_timeout_seconds=60)

# Inspect and recover.
print(c.queue.queue_stats("emails"))
print(c.queue.peek("emails", limit=20, ready=True))
for dead in c.queue.dead_letters("emails")["messages"]:
    c.queue.replay_dead("emails", dead["id"], reset_attempts=True)
```

### JavaScript / TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient({ baseUrl: 'http://localhost:8080', token: jwt });

await c.queue.createQueue('emails', { maxAttempts: 5, visibilityTimeoutSeconds: 60 });

const published = await c.queue.publish(
  'emails',
  { to: 'alice@acme.test', template: 'welcome' },
  { dedupeKey: 'welcome:alice', headers: { traceId: 'abc-123' } },
);

await c.queue.publishBatch('emails', [
  { payload: { n: 1 } },
  { payload: { n: 2 }, delaySeconds: 30 },
]);

const batch = await c.queue.consume('emails', { maxMessages: 10, consumer: 'mailer-1' });
for (const msg of batch.messages) {
  try {
    await send(msg.payload);
    await c.queue.ack('emails', msg.receipt);
  } catch (err) {
    await c.queue.nack('emails', msg.receipt, { delaySeconds: 30, error: String(err) });
  }
}

await c.queue.heartbeat('emails', receipt, { visibilityTimeoutSeconds: 60 });

// Batch ack
await c.queue.ackMany('emails', ['receipt-1', 'receipt-2']);

const stats = await c.queue.queueStats('emails');
const dead = await c.queue.deadLetters('emails', { limit: 20 });
await c.queue.replayDead('emails', dead.messages[0].id, { resetAttempts: true });
```

### Go

```go
c := synapseone.New("http://localhost:8080")
c.SetToken(jwt)
// Platform callers: c.SetTenant("acme") -> x-synapseone-tenant

_, err := c.CreateQueue("emails", synapseone.QueueConfig{
    MaxAttempts: 5, VisibilityTimeoutSeconds: 60,
})
if err != nil {
    log.Fatal(err)
}

published, err := c.PublishMessage("emails",
    map[string]any{"to": "alice@acme.test", "template": "welcome"},
    synapseone.QueuePublishOptions{DedupeKey: "welcome:alice"})
id := published["id"].(string)

batch, err := c.ConsumeMessages("emails", synapseone.QueueConsumeOptions{
    MaxMessages: 10, Consumer: "mailer-1",
})
for _, raw := range batch["messages"].([]any) {
    msg := raw.(map[string]any)
    receipt := msg["receipt"].(string)
    if err := send(msg["payload"]); err != nil {
        _, _ = c.NackMessage("emails", receipt, synapseone.QueueNackOptions{
            DelaySeconds: 30, Error: err.Error(),
        })
        continue
    }
    _, _ = c.AckMessage("emails", receipt)
}

_, _ = c.HeartbeatMessage("emails", receipt, 60)
stats, err := c.QueueStats("emails")
dead, err := c.DeadMessages("emails", 20)
_, err = c.ReplayDeadMessage("emails", id, 0, true)
```

## Operations

- `GET /health` → `{status, service:"queue", version, backend:"redis"|"memory", time}`
- `GET /metrics` → `synapseone_queue_up`,
  `synapseone_queue_backend_info{backend="redis"|"memory"}`,
  `synapseone_queue_http_requests_total{key="METHOD|route|status"}`,
  `synapseone_queue_process_uptime_seconds`
- Production requires `SYNAPSEONE_INTERNAL_SECRET` and `QUEUE_REDIS_URL` (or
  `REDIS_URL`). Without Redis the service uses a per-process in-memory store —
  fine for local development, but replicas would not share messages.
- Redis keys live under `synapseone:queue:v1:<tenant>:`; do not write that
  namespace directly. Queue metadata and messages are separate hashes/sorted
  sets, so `DEL`-ing a queue prefix by hand can corrupt in-flight leases.
- Scale consumers freely: consume is atomic per message and leases guarantee
  only one consumer holds a delivery at a time. Ack/nack/heartbeat are routed to
  the same tenant/queue but do not require the same process that consumed.
- Choose `visibilityTimeoutSeconds` longer than normal processing time and use
  heartbeats for outliers. Too short a lease causes duplicate processing; too
  long a lease delays recovery after a crash.
- Dead-letter alerts: poll `/dead` or alert on the `dead` stat. Replay with
  `resetAttempts` only after fixing the consumer bug, otherwise messages will
  dead-letter again.
