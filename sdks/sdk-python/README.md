# synapsedx SDK for Python

Apache-2.0. See root LICENSE. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

Requires Python 3.9+. Single runtime dependency: `requests>=2.28`.

## Install

```bash
pip install synapsedx-sdk
```

## Quick start

```python
from synapsedx_sdk import SynapseDXClient

c = SynapseDXClient("http://localhost:8080")
login = c.iam.login("demo@acme.local")
c.set_token(login["accessToken"])

c.iam.create_org("acme-2", "ACME 2")
c.iam.authorize(login["user"]["id"], "workflow:Execute", "*")
c.workflow.create_workflow_from_template("webhook-to-log", "demo")
```

## Services

The SDK is split per service. Use the namespace that matches the service:

| Namespace | Service | Highlights |
| --- | --- | --- |
| `c.iam` | Synapse IAM | auth/OIDC, orgs, accounts, users, roles, policies, API keys, credentials, service accounts |
| `c.workflow` | Workflow | templates, workflow CRUD + activate/deactivate, executions, `test_run`, `trigger_webhook` |
| `c.lds` | LDS | datasources, attributes, records ingestion, NGSI-LD entities, licenses |
| `c.base` | SynapseBase | collections, documents, queries, batch, increment, change feed, typed object<->data mapping |
| `c.faststore` | Synapse Faststore | KV with TTL/NX/XX, incr, hashes, lists, sets, sorted sets, scans, batches, distributed locks |
| `c.queue` | SynapseQueue | queues, publish (delay/dedupe), consume leases, ack/nack/heartbeat, dead letters, replay |

### SynapseBase with typed objects

```python
from dataclasses import dataclass


@dataclass
class Park:
    name: str
    capacity: int


parks = c.base.collection(
    "parks",
    model=Park,
    mapping={"name": "profile.name", "capacity": "profile.capacity"},
)
parks.create(Park("Central", 120), id="park-1")
page = parks.query(
    {"capacity": {"gte": 100}}, order_by=[{"field": "name", "direction": "asc"}]
)
for park in page:  # page.items are Park instances
    print(park.name)
```

Writes accept raw `data` or logical `object`; reads accept `as_view="object"`.
Queries return a `QueryResult` (`items`, `total`, `limit`, `offset`,
`next_cursor`). `increment` is atomic and `changes(since)` polls the change feed.

### Faststore + Queue

```python
c.faststore.set("cache:park:1", {"name": "Central"}, ttl_seconds=300)
c.faststore.list_push("jobs", [{"id": 1}])
lock = c.faststore.lock_acquire("report", ttl_seconds=60)
c.faststore.lock_release("report", lock["token"])

c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=30)
c.queue.publish("emails", {"to": "a@b.c"}, dedupe_key="welcome:a@b.c")
batch = c.queue.consume("emails", max_messages=10, consumer="worker-1")
for msg in batch["messages"]:
    try:
        handle(msg["payload"])
        c.queue.ack("emails", msg["receipt"])
    except Exception as exc:
        c.queue.nack("emails", msg["receipt"], delay_seconds=30, error=str(exc))
```

## Auth and tenants

`SynapseDXClient(base_url, token=..., api_key=..., tenant=...)`, or
`set_token(jwt)` / `set_api_key(key)` after login. `timeout` configurable
(default 15s). `tenant` is sent as `x-synapsedx-tenant` and is only required by
platform callers of the tenant-scoped services (faststore/queue).

## Deprecated flat API

The old flat methods (`c.login(...)`, `c.list_templates()`,
`c.list_lds_datasources(...)`, ...) still work but emit a `DeprecationWarning`
that points at the namespaced replacement (e.g.
`client.workflow.list_templates()`). Migrate call sites and silence the
warnings. `c.call(method, path, body)` remains the generic escape hatch.

## Tests

```bash
python -m pytest synapsedx_sdk -q
```

## Full documentation

See **[docs/sdk-python.md](../../docs/sdk-python.md)** for the complete API
reference — constructor, auth, all methods with signatures, parameters, return
types, and examples.
