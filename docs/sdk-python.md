# `synapseone-sdk` — SynapseOne SDK for Python

Apache-2.0. Part of [SynapseOne](../README.md) Tier-1 PaaS.

Requires Python 3.10+. Single runtime dependency: `requests>=2.28`.

## Install

```bash
pip install synapseone-sdk
```

Or with a virtual environment:

```bash
python -m venv .venv
source .venv/bin/activate
pip install synapseone-sdk
```

For development (from the monorepo):

```bash
cd sdks/sdk-python
pip install -e .
```

## Quick start

```python
from synapseone_sdk import SynapseOneClient

c = SynapseOneClient("http://localhost:8080")

# Login (dev login or seed)
login = c.iam.login("demo@acme.local")
c.set_token(login["accessToken"])

# Create org, authorize user, deploy workflow
c.iam.create_org("acme-2", "ACME 2")
c.iam.authorize(login["user"]["id"], "workflow:Execute", "*")
c.workflow.create_workflow_from_template("webhook-to-log", "demo")
```

## Constructor

```python
SynapseOneClient(base_url, token=None, api_key=None, timeout=15, tenant=None)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `base_url` | `str` | — | Gateway URL, e.g. `http://localhost:8080` |
| `token` | `str \| None` | `None` | Bearer JWT (from login or service account) |
| `api_key` | `str \| None` | `None` | API key sent as `X-API-Key` header |
| `timeout` | `int` | `15` | Per-request timeout in seconds |
| `tenant` | `str \| None` | `None` | `x-synapseone-tenant`; platform callers only (Faststore/Queue) |

### Auth methods

```python
c.set_token(token)      # set/replace Bearer token
c.set_api_key(key)      # set/replace API key
c.tenant = "acme"       # set/replace x-synapseone-tenant (or None)
```

Both credentials can also be set via constructor arguments. When both are present,
both headers are sent. `tenant` is ignored for principal callers — the service
always uses their verified org/account/user scope.

## Service namespaces

The SDK is split by service. `SynapseOneClient` is a thin facade that shares one
HTTP layer and exposes:

| Namespace | Service | Examples |
|---|---|---|
| `c.iam` | IAM | `login`, `list_orgs`, `create_role`, `create_api_key`, credentials |
| `c.workflow` | Workflow engine | `list_templates`, `create_workflow`, `execute_workflow`, `list_executions` |
| `c.lds` | SynapseLDS | `licenses`, `create_datasource`, `set_attributes`, `ingest_records` |
| `c.base` | SynapseBase | `create_collection`, `create_document`, `query_documents`, `changes` |
| `c.faststore` | Synapse Faststore | `set`, `get`, `incr`, `hash_set`, `list_push`, `lock_acquire` |
| `c.queue` | SynapseQueue | `publish`, `consume`, `ack`, `nack`, `dead_letters` |

The legacy flat methods (`c.login(...)`, `c.list_templates(...)`,
`c.list_lds_licenses(...)`, ...) still work but emit a `DeprecationWarning` and
forward to the namespaced call. The LDS namespace **drops the `lds_` prefix**:
`c.list_lds_licenses()` → `c.lds.list_licenses()`,
`c.ingest_lds_records(...)` → `c.lds.ingest_records(...)`.

The API reference below documents the legacy flat surface (kept for existing
code). For new code prefer the namespace equivalents; the dedicated service
guides show both.

## API reference

### Auth

#### `login(email, org_slug="acme")`
```python
def login(self, email: str, org_slug: str = "acme") -> dict
```
Authenticates via dev login. Returns `{"accessToken": ..., "refreshToken": ..., "user": ...}`.

```python
result = c.login("demo@acme.local", "acme")
```

#### `refresh(refresh_token)`
```python
def refresh(self, refresh_token: str) -> dict
```
Rotates a refresh token (atomic server-side; old token is revoked). Returns `{"accessToken": ..., "refreshToken": ...}`.

#### `logout(refresh_token)`
```python
def logout(self, refresh_token: str) -> dict
```
Revokes a single refresh token.

#### `logout_all(refresh_token)`
```python
def logout_all(self, refresh_token: str) -> dict
```
Revokes every session of the token owner.

#### `verify()`
```python
def verify(self) -> dict
```
Checks the current Bearer token or API key without fetching the user.

#### `me()`
```python
def me(self) -> dict
```
Returns the user record behind the current Bearer token.

### Organizations

#### `list_orgs()`
```python
def list_orgs(self) -> list
```
Lists all organizations.

#### `create_org(slug, display_name)`
```python
def create_org(self, slug: str, display_name: str) -> dict
```
Creates an organization.

```python
c.create_org("acme-2", "ACME 2")
```

### Accounts

#### `list_accounts(org_id)`
```python
def list_accounts(self, org_id: str) -> list
```
Lists accounts in an organization.

#### `create_account(org_id, slug, display_name)`
```python
def create_account(self, org_id: str, slug: str, display_name: str) -> dict
```
Creates an account under an organization.

```python
c.create_account(org_id, "prod", "Production")
```

### Users

#### `list_users(org_id)`
```python
def list_users(self, org_id: str) -> list
```
Lists users in an organization.

#### `create_user(org_id, email, display_name=None)`
```python
def create_user(self, org_id: str, email: str, display_name: str | None = None) -> dict
```
Creates or updates a user in an organization.

```python
c.create_user(org_id, "alice@acme.local", "Alice")
```

#### `user_policies(user_id)`
```python
def user_policies(self, user_id: str) -> list
```
Returns the effective policy documents of a user (debug helper for authorize).

### Roles

#### `create_role(account_id, slug, description="")`
```python
def create_role(self, account_id: str, slug: str, description: str = "") -> dict
```
Creates a role in an account.

```python
c.create_role(account_id, "etl-runner", "Runs ETL workflows")
```

#### `list_roles(account_id)`
```python
def list_roles(self, account_id: str) -> list
```
Lists roles in an account.

#### `delete_role(role_id)`
```python
def delete_role(self, role_id: str) -> dict
```
Deletes a role.

### Policies

#### `create_policy(account_id, slug, document, description="")`
```python
def create_policy(self, account_id: str, slug: str, document: dict, description: str = "") -> dict
```
Creates an IAM policy. `document` is a JSON policy document.

```python
doc = {
    "Version": "2012-17-10",
    "Statement": [{
        "Effect": "Allow",
        "Action": ["workflow:Execute"],
        "Resource": ["*"],
    }],
}
c.create_policy(account_id, "wf-exec", doc, "Allow workflow execution")
```

#### `list_policies(account_id)`
```python
def list_policies(self, account_id: str) -> list
```
Lists policies in an account.

#### `delete_policy(policy_id)`
```python
def delete_policy(self, policy_id: str) -> dict
```
Deletes a policy.

### Role-policy attachment

#### `attach_policy(role_id, policy_id)`
```python
def attach_policy(self, role_id: str, policy_id: str) -> dict
```
Attaches a policy to a role.

```python
c.attach_policy(role_id, policy_id)
```

#### `assign_role(user_id, role_id)`
```python
def assign_role(self, user_id: str, role_id: str) -> dict
```
Assigns a role to a user.

```python
c.assign_role(user_id, role_id)
```

### Authorization

#### `authorize(user_id, action, resource, context=None)`
```python
def authorize(self, user_id: str, action: str, resource: str, context: dict | None = None) -> dict
```
Checks whether a user is authorized to perform an action on a resource.

```python
result = c.authorize(user_id, "workflow:Execute", "*", {"team": "etl"})
allowed = result["allowed"]
```

#### `simulate(documents, action, resource, context=None)`
```python
def simulate(self, documents: list, action: str, resource: str, context: dict | None = None) -> dict
```
Dry-runs policy documents without a user (like AWS IAM Policy Simulator).

```python
result = c.simulate([policy_doc], "workflow:Execute", "*")
```

### Audit

#### `list_audit(limit=50, actor=None)`
```python
def list_audit(self, limit: int = 50, actor: str | None = None) -> list
```
Reads the audit log. `limit` defaults to 50.

```python
entries = c.list_audit(20, user_id)
```

### API keys

#### `create_api_key(account_id, name="default", scopes=None)`
```python
def create_api_key(self, account_id: str, name: str = "default", scopes: list | None = None) -> dict
```
Creates an API key. `name` defaults to `"default"`, `scopes` defaults to `["*"]`.

```python
result = c.create_api_key(account_id, "ci-deploy", ["workflow:Execute"])
api_key = result["apiKey"]
```

#### `revoke_api_key(key_id)`
```python
def revoke_api_key(self, key_id: str) -> dict
```
Revokes an API key.

#### `verify_api_key(api_key)`
```python
def verify_api_key(self, api_key: str) -> dict
```
Checks a raw API key via the internal verify endpoint.

#### `list_api_keys(account_id)`
```python
def list_api_keys(self, account_id: str) -> Any
```
Lists key metadata (id/prefix only — never secret values).

### Service accounts

#### `create_service_account(account_id, slug, description="")`
```python
def create_service_account(self, account_id: str, slug: str, description: str = "") -> dict
```
Creates a service account.

```python
c.create_service_account(account_id, "etl-bot", "ETL service account")
```

#### `list_service_accounts(account_id)`
```python
def list_service_accounts(self, account_id: str) -> list
```
Lists service accounts in an account.

#### `service_account_token(sa_id, scopes=None)`
```python
def service_account_token(self, sa_id: str, scopes: list | None = None) -> dict
```
Mints a short-lived JWT for a service account. When `scopes` is omitted the
server delegates the caller's own scopes (it never widens to `["*"]`). Pass an
explicit list to narrow the minted token; it must be a subset of the caller's
scopes unless the caller holds `*`.

```python
result = c.service_account_token(sa_id, ["workflow:Execute"])
token = result["accessToken"]
```

### Credentials (PROPOSED — backend in progress)

Account-scoped secrets for workflow nodes (webhook auth, DB passwords, OAuth
tokens...). Secrets are encrypted at rest and **never returned**: `create`/`rotate`
accept a `secret` once; `list`/`get` return metadata only —
`{"id", "name", "type", "accountId", "expiresAt", "version"}`.
`type` is one of `bearer`|`basic`|`apiKey`|`oauth2`.

```python
import os

# Copy-paste: store a bearer token, then list metadata (no secrets leak).
cred = c.create_credential(
    account_id,
    "stripe-live",
    "bearer",
    os.environ["STRIPE_TOKEN"],
    expires_at="2027-01-01T00:00:00Z",
)
print(cred["id"], cred["version"])  # secret is NOT in the response
all_creds = c.list_credentials(account_id)
one = c.get_credential(cred["id"])
rotated = c.rotate_credential(cred["id"], os.environ["STRIPE_TOKEN_V2"])
c.delete_credential(cred["id"])
```

#### `create_credential(account_id, name, type, secret, expires_at=None)`
```python
def create_credential(self, account_id: str, name: str, type: str, secret: str, expires_at: str | None = None) -> dict
```

#### `list_credentials(account_id)`
```python
def list_credentials(self, account_id: str) -> list
```
Lists credential metadata (never secret values).

#### `get_credential(cred_id)` / `delete_credential(cred_id)` / `rotate_credential(cred_id, secret)`
```python
def get_credential(self, cred_id: str) -> dict
def delete_credential(self, cred_id: str) -> dict
def rotate_credential(self, cred_id: str, secret: str) -> dict
```
`rotate_credential` replaces the secret and bumps `version` (the old secret stops working).

### Generic call (escape hatch)

```python
def call(self, method: str, path: str, body: Any | None = None) -> Any
```
Calls any gateway endpoint directly — forward-compat with endpoints added after
this SDK (e.g. the proposed credentials API). Same auth + `status+path+body` errors.

```python
creds = c.call("GET", f"/v1/accounts/{account_id}/credentials")
```

### Workflows

#### `list_workflows()`
```python
def list_workflows(self) -> Any
```
Lists all workflows.

#### `get_workflow(wf_id)`
```python
def get_workflow(self, wf_id: str) -> Any
```
Gets a single workflow by ID.

#### `create_workflow_from_template(template, name=None)`
```python
def create_workflow_from_template(self, template: str, name: str | None = None) -> Any
```
Instantiates a built-in template on the engine.

```python
c.create_workflow_from_template("webhook-to-log", "my-webhook")
```

#### `create_workflow(name, definition)`
```python
def create_workflow(self, name: str, definition: dict) -> Any
```
Creates a workflow from a raw workflow definition.

```python
c.create_workflow("my-wf", definition)
```

#### `activate_workflow(wf_id)`
```python
def activate_workflow(self, wf_id: str) -> Any
```
Activates a workflow.

#### `deactivate_workflow(wf_id)`
```python
def deactivate_workflow(self, wf_id: str) -> Any
```
Deactivates a workflow.

#### `execute_workflow(wf_id, payload=None)`
```python
def execute_workflow(self, wf_id: str, payload: dict | None = None) -> Any
```
Triggers a manual execution (proxied to the engine).

```python
c.execute_workflow(wf_id, {"url": "https://example.com/hook"})
```

#### `update_workflow(wf_id, name=None, definition=None)`
```python
def update_workflow(self, wf_id: str, name: str | None = None, definition: dict | None = None) -> Any
```
Updates a workflow's name and/or definition.

```python
c.update_workflow(wf_id, name="renamed")
```

#### `delete_workflow(wf_id)`
```python
def delete_workflow(self, wf_id: str) -> Any
```
Deletes a workflow on the engine.

```python
c.delete_workflow(wf_id)
```

#### `test_run(definition, input=None)`
```python
def test_run(self, definition: dict, input: dict | None = None) -> Any
```
Tries a definition without saving (`POST /v1/workflows/test-run {definition, input}`).
Powers the editor's "try before Save". Returns `{"ok", "output", "nodeRuns", "executionId"}`.

```python
# Copy-paste: validate a code-transform definition before saving it.
definition = {
    "nodes": [
        {"name": "Webhook", "type": "n8n-nodes-base.webhook",
         "parameters": {"path": "transform", "httpMethod": "POST"}},
        {"name": "Transform", "type": "n8n-nodes-base.code",
         "parameters": {"code": "return { ...$input, doubled: ($input.value ?? 0) * 2 };']],
    ],
    "connections": {"Webhook": {"main": [[{"node": "Transform", "type": "main", "index": 0}]]}},
}
r = c.test_run(definition, {"value": 21})
print(r["ok"], r["output"])  # True {'value': 21, 'doubled': 42}
```

### Templates

#### `list_templates()`
```python
def list_templates(self) -> Any
```
Lists all built-in workflow templates.

#### `get_template(name)`
```python
def get_template(self, name: str) -> Any
```
Fetches a single built-in template definition by name.

```python
tpl = c.get_template("webhook-to-log")
```

### Executions

> The engine always returns the envelope `{"data": [...]}` for `GET /v1/executions`
> (forward-compat with the old n8n proxy). `list_executions()` unwraps it for you —
> you always get a plain list, and a bare array response is accepted too
> (see `unwrap_executions()`).

#### `list_executions(query="")`
```python
def list_executions(self, query: str | dict | None = "") -> list
```
Lists executions. `query` may be a raw string (`"limit=20"`) or a dict limited to
the server allowlist: `limit`, `offset`, `workflowId`, `status`
(`success`|`error`|`running`), `includeData`. `limit`/`offset` are `0..9999`
(`offset=0` = first page).

```python
recent = c.list_executions("limit=10")
failed = c.list_executions({"workflowId": wf_id, "status": "error", "limit": 20})
with_io = c.list_executions({"limit": 5, "includeData": True})  # per-node I/O
```

#### `get_execution(exec_id, include_data=False)`
```python
def get_execution(self, exec_id: str, include_data: bool = False) -> Any
```
Gets a single execution by ID. Pass `include_data=True` for per-node input/output.

```python
exec_ = c.get_execution(exec_id, include_data=True)
```

#### `unwrap_executions(payload)`
```python
def unwrap_executions(payload: Any) -> list
```
Normalizes a raw `GET /v1/executions` payload (envelope `{"data": []}` or bare
array) to a list. `list_executions()` already applies it.

### Linked Data (SynapseLDS)

```python
c.list_lds_licenses()
ds = c.create_lds_datasource("Business Registry", entity_type="Organization", license="CC-BY-4.0")
c.set_lds_datasource_attributes(ds["id"], [
    {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
    {"name": "taxCode", "visibility": "restricted"},
])
c.ingest_lds_records(ds["id"], {"id": "55001", "name": "ACME"})   # dict or list
c.list_lds_entities(ds["id"], limit=50)                           # NGSI-LD JSON-LD
c.get_lds_entity(ds["id"], "urn:ngsi-ld:Organization:55001")
c.get_lds_datasource_stats(ds["id"])
c.delete_lds_datasource(ds["id"])
```

`_core` metadata is never serialized; attributes without a registry entry (or
not visible to the caller) are omitted from entity listings. The public export
surface (`lds licenses`, `lds entities`, `lds entity`) reads anonymously — no
token required for the public projection; a token earns same-tenant
`restricted` reads (other tenants → `404`).

### SynapseBase (`c.base`)

Collections of JSON documents with a logical object↔data mapping, queries,
optimistic concurrency, counters, batches and a change feed. Full guide:
[synapsebase.md](synapsebase.md).

```python
from dataclasses import dataclass

@dataclass
class Park:
    name: str
    capacity: int | None = None

# Dynamic API
c.base.create_collection("parks", mapping={
    "name": {"path": "profile.name", "type": "string", "required": True},
    "capacity": {"path": "profile.capacity", "type": "number"},
})
c.base.create_document("parks", object={"name": "Central", "capacity": 120}, id="park-1")
doc = c.base.get_document("parks", "park-1", as_view="object")
page = c.base.query_documents(
    "parks",
    {"capacity": {"gte": 100}},
    order_by=[{"field": "name", "direction": "asc"}],
    as_view="object",
)
print(page.total, page.next_cursor)      # QueryResult is iterable + len()

# Typed collection: model attributes must equal logical mapping names
parks = c.base.collection(
    "parks", model=Park,
    mapping={"name": "profile.name", "capacity": "profile.capacity"},
)
parks.create(Park("Riverside", 80), id="park-2")
for park in parks.query({"capacity": {"gte": 100}}):
    print(park.name, park.capacity)
parks.increment("park-1", "profile.capacity", by=10)
feed = parks.changes("2026-10-01T00:00:00Z")
```

| Method | Purpose |
|---|---|
| `list_collections()` / `create_collection(name, mapping=, description=, org_id=, account_id=)` | collection registry |
| `get_collection` / `update_collection` / `delete_collection` / `collection_stats` | collection lifecycle |
| `create_document(collection, data=None, object=None, id=None)` | exactly one payload view |
| `get_document(collection, id, as_view="data")` | `as_view` because `as` is a Python keyword |
| `set_document(..., merge=False, if_version=None)` | replace/upsert |
| `update_document(..., unset=None, if_version=None)` | merge + dot-path removals |
| `delete_document(collection, id, if_version=None)` | optimistic delete |
| `query_documents(collection, where=None, order_by=None, limit=None, offset=None, cursor=None, select=None, as_view=)` | returns `QueryResult` |
| `list_documents` / `increment(collection, id, field, by=1, if_version=None)` / `batch` / `changes` | raw-data endpoints |
| `collection(name, model=, mapping=)` | typed `BaseCollection` |

`data`/`object` use the exported `UNSET` sentinel, so an explicit `None` is not
mistaken for an omitted argument. Typed collections convert list/increment/
changes results locally through `mapping`.

### Synapse Faststore (`c.faststore`)

Redis-backed strings, counters, hashes, lists, sets, sorted sets, scans, batches
and distributed locks. Full guide: [faststore.md](faststore.md).

```python
c.faststore.set("cache:park:1", {"name": "Central"}, ttl_seconds=300, if_not_exists=True)
entry = c.faststore.get("cache:park:1")
print(entry["type"], entry["value"], entry["ttlSeconds"])
print(c.faststore.exists("cache:park:1"))          # 404 -> False
c.faststore.incr("visits", by=1, ttl_seconds=60)

c.faststore.hash_set("user:1", {"name": "Alice", "plan": "pro"}, ttl_seconds=3600)
c.faststore.hash_incr("user:1", "logins", by=1)
c.faststore.list_push("jobs", [{"id": 1}], side="left", ttl_seconds=600)
print(c.faststore.list_pop("jobs", count=10)["values"])
c.faststore.set_add("tags", ["a", "b"])
c.faststore.zset_add("scores", [{"member": "alice", "score": 10}])

lock = c.faststore.lock_acquire("report", ttl_seconds=60, wait_ms=500)
if lock["acquired"]:
    try:
        ...
    finally:
        c.faststore.lock_release("report", lock["token"])

page = c.faststore.list_keys(prefix="cache:", limit=100)
```

Method families: `get/set/delete/ttl/expire/incr/batch`, `hash_*`, `list_*`,
`set_*`, `zset_*`, `lock_acquire/lock_release/lock_extend`, `stats`,
`list_keys`, `exists`.

### SynapseQueue (`c.queue`)

At-least-once queues with delays, deduplication, visibility-timeout leases,
ack/nack/heartbeat, retries, dead letters and replay. Full guide:
[queue.md](queue.md).

```python
c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=60)
published = c.queue.publish(
    "emails",
    {"to": "alice@acme.test"},
    dedupe_key="welcome:alice",
    headers={"traceId": "abc-123"},
)
c.queue.publish_batch("emails", [{"payload": {"n": 1}}, {"payload": {"n": 2}, "delaySeconds": 30}])

batch = c.queue.consume("emails", max_messages=10, consumer="mailer-1")
for msg in batch["messages"]:
    try:
        send(msg["payload"])
        c.queue.ack("emails", msg["receipt"])
    except Exception as exc:
        c.queue.nack("emails", msg["receipt"], delay_seconds=30, error=str(exc))

c.queue.heartbeat("emails", receipt, visibility_timeout_seconds=60)
print(c.queue.queue_stats("emails"))
for dead in c.queue.dead_letters("emails")["messages"]:
    c.queue.replay_dead("emails", dead["id"], reset_attempts=True)
```

Also: `list_queues`, `get_queue`, `delete_queue`, `purge_queue`, `ack_many`,
`peek(limit=, ready=)` and `delete_dead`.

### Webhooks (public, no auth)

`ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares
that `path`. The gateway does **not** proxy `/webhook/*` — call the
workflow-service origin directly (e.g. `http://localhost:4002`).

```python
from synapseone_sdk import trigger_webhook

# Copy-paste: fire the code-transform template's webhook after activating it.
out = trigger_webhook("http://localhost:4002", "transform", {"value": 21})
print(out["output"])
```

Raw curl equivalent:

```bash
curl -X POST http://localhost:4002/webhook/transform \
  -H 'Content-Type: application/json' \
  -d '{"value":21}'
```

## Error handling

All methods raise `SynapseOneError` on failure (network or HTTP errors):

```python
from synapseone_sdk import SynapseOneClient, SynapseOneError

try:
    c.authorize(user_id, "workflow:Execute", "*")
except SynapseOneError as e:
    print(f"Error: {e}")
```

The error message includes the HTTP status and path, e.g. `"synapseone 403 /v1/authorize: ..."`.

## Full example

```python
from synapseone_sdk import SynapseOneClient

def main():
    c = SynapseOneClient("http://localhost:8080")

    # 1. Login
    login = c.login("demo@acme.local")
    c.set_token(login["accessToken"])
    user = login["user"]

    # 2. Create org + account
    org = c.create_org("acme", "ACME Corp")
    account = c.create_account(org["id"], "prod", "Production")

    # 3. Create role + policy
    role = c.create_role(account["id"], "wf-runner", "Workflow runner")
    policy = c.create_policy(account["id"], "wf-exec", {
        "Version": "2012-17-10",
        "Statement": [{"Effect": "Allow", "Action": ["workflow:Execute"], "Resource": ["*"]}],
    })
    c.attach_policy(role["id"], policy["id"])
    c.assign_role(user["id"], role["id"])

    # 4. Deploy + execute workflow
    wf = c.create_workflow_from_template("webhook-to-log", "demo")
    c.activate_workflow(wf["id"])
    exec_result = c.execute_workflow(wf["id"], {"url": "https://example.com"})

    print(f"Execution: {exec_result['id']}")

if __name__ == "__main__":
    main()
```
