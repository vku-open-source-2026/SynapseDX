/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Card, Code, PageTitle, Table } from '../components/ui.jsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'base', label: 'SynapseBase' },
  { id: 'faststore', label: 'Faststore' },
  { id: 'queue', label: 'SynapseQueue' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'go', label: 'Go' },
  { id: 'cli', label: 'CLI' },
];

const METHOD_TONE = { GET: 'blue', POST: 'green', PUT: 'amber', PATCH: 'amber', DELETE: 'red' };

function DocSection({ title, kicker, children }) {
  return (
    <Card className="mb-4">
      {kicker && <p className="text-xs font-semibold uppercase tracking-wide text-main-blue mb-1">{kicker}</p>}
      <h3 className="font-semibold text-main-text mb-3">{title}</h3>
      <div className="text-sm text-normal-text leading-relaxed space-y-3">{children}</div>
    </Card>
  );
}

function DocCode({ limit = 4000, ...props }) {
  return <Code {...props} limit={limit} wrap />;
}

function Text({ children }) {
  return <p>{children}</p>;
}

function Bullets({ items }) {
  return (
    <ul className="list-disc pl-5 space-y-1.5">
      {items.map((item) => (
        <li key={typeof item === 'string' ? item : item.join(' ')}>{item}</li>
      ))}
    </ul>
  );
}

function EndpointTable({ rows, columns = ['Method', 'Endpoint', 'Purpose'] }) {
  return (
    <Table head={columns}>
      {rows.map(([method, path, desc]) => (
        <tr key={`${method}:${path}`} className="border-t border-slate-100 align-top">
          <td className="py-2 pr-4 whitespace-nowrap">
            {String(method).includes('/') || String(method).includes('·') ? (
              <span className="text-xs font-medium text-normal-text">{method}</span>
            ) : (
              <Badge tone={METHOD_TONE[method] || 'gray'}>{method}</Badge>
            )}
          </td>
          <td className="py-2 pr-4 min-w-[14rem]">
            <code className="text-xs text-main-text break-all">{path}</code>
          </td>
          <td className="py-2 text-xs">{desc}</td>
        </tr>
      ))}
    </Table>
  );
}

function OperatorTable({ rows }) {
  return (
    <Table head={['Operator', 'Meaning']}>
      {rows.map(([op, meaning]) => (
        <tr key={op} className="border-t border-slate-100">
          <td className="py-2 pr-4">
            <code className="text-xs text-main-text">{op}</code>
          </td>
          <td className="py-2 text-xs">{meaning}</td>
        </tr>
      ))}
    </Table>
  );
}

function TabButton({ tab, active, onClick, children }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onClick(tab)}
      className={`px-4 py-2 rounded-2xl text-sm font-medium transition-colors ${
        active ? 'bg-gradient-to-b from-main-start to-main-end text-white shadow-sm' : 'bg-white text-normal-text shadow-sm hover:text-main-blue'
      }`}
    >
      {children}
    </button>
  );
}

const OVERVIEW_RUN = `# From the repository root
cp .env.example .env
# Replace every *_change_me_* secret in .env, then:
docker compose up -d --build
docker compose ps

# Gateway health + aggregate readiness (iam, workflow, ai, lds, base, faststore, queue)
curl http://localhost:8080/health
curl http://localhost:8080/ready

# Individual services
curl http://localhost:4005/health   # SynapseBase
curl http://localhost:4006/health   # Faststore
curl http://localhost:4007/health   # SynapseQueue`;

const OVERVIEW_FLOW = `# 1. Sign in (dev login; use SSO/API keys in production)
TOKEN=$(curl -s -XPOST http://localhost:8080/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

# 2. SynapseBase: create a mapped collection and write a logical object
curl -s -XPOST http://localhost:8080/v1/base/collections \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"parks","mapping":{"name":"profile.name","capacity":"profile.capacity"}}'
curl -s -XPOST http://localhost:8080/v1/base/collections/parks/documents \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'

# 3. Faststore: cache a value and bump a counter
curl -s -XPUT http://localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'
curl -s -XPOST http://localhost:8080/v1/faststore/keys/visits/incr \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"by":1}'

# 4. SynapseQueue: publish a message
curl -s -XPOST http://localhost:8080/v1/queue/queues/emails/messages \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"to":"alice@acme.test"},"dedupeKey":"welcome:alice"}'`;

const BASE_MAPPING = `{
  "fields": {
    "name":     { "path": "profile.name",     "type": "string",  "required": true },
    "capacity": { "path": "profile.capacity", "type": "number" },
    "tags":     { "path": "profile.tags",     "type": "array" }
  },
  "additional": false
}

// Shorthand accepted everywhere (no type/required metadata):
{ "name": "profile.name", "capacity": "profile.capacity" }`;

const BASE_QUICKSTART = `# Create the collection and its mapping
curl -s -XPOST localhost:8080/v1/base/collections \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "name": "parks",
    "mapping": {
      "name": { "path": "profile.name", "type": "string", "required": true },
      "capacity": { "path": "profile.capacity", "type": "number" }
    }
  }'

# Write object -> the service stores { "profile": { "name": ..., "capacity": ... } }
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'

# Read object <- data
curl -s "localhost:8080/v1/base/collections/parks/documents/park-1?as=object" \\
  -H "Authorization: Bearer $TOKEN"`;

const BASE_QUERY = `curl -s -XPOST localhost:8080/v1/base/collections/parks/query \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{
    "where": {
      "or": [
        { "field": "capacity", "op": "gte", "value": 100 },
        { "and": [
          { "field": "profile.tags", "op": "contains", "value": "family" },
          { "field": "$updatedAt", "op": "gt", "value": "2026-10-01T00:00:00Z" }
        ] }
      ]
    },
    "orderBy": [{ "field": "name", "direction": "asc" }],
    "limit": 20,
    "select": ["name", "capacity"],
    "as": "object"
  }'`;

const BASE_WRITES = `# Full replace with optimistic concurrency (If-Match also works)
curl -s -XPUT localhost:8080/v1/base/collections/parks/documents/park-1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"object":{"name":"Central Park","capacity":150},"ifVersion":2}'

# Partial merge + dot-path removals
curl -s -XPATCH localhost:8080/v1/base/collections/parks/documents/park-1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"object":{"capacity":160},"unset":["profile.obsolete"],"ifVersion":3}'

# Atomic counter; field is a raw dot path. Missing doc is created at version 1.
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents/park-1/increment \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"field":"profile.capacity","by":10,"ifVersion":4}'

# Batch (1..100 ordered ops; ifVersion is honored only by delete)
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents:batch \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"operations":[
    {"op":"create","id":"park-2","object":{"name":"Riverside"}},
    {"op":"increment","id":"park-1","field":"profile.capacity","by":5},
    {"op":"delete","id":"park-3","ifVersion":4}
  ]}'`;

const BASE_LIMITS = `BASE_MAX_DOCUMENT_BYTES=262144   # default 256 KiB, clamped 1 KiB..4 MiB
BASE_QUERY_SCAN_LIMIT=10000       # default 10k, clamped 100..100k
# nesting depth 32 | arrays 10,000 | filters 50 | filter nesting 8
# orderBy 3 | query limit 1..1000 | select 100 | batch 100 | changes limit 1..1000`;

const FASTSTORE_QUICKSTART = `# String with TTL (0 clears TTL; 1..2592000 seconds)
curl -s -XPUT localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"value":{"name":"Central"},"ttlSeconds":300}'

curl -s localhost:8080/v1/faststore/keys/cache:park:1 \\
  -H "Authorization: Bearer $TOKEN"

# Atomic counter
curl -s -XPOST localhost:8080/v1/faststore/keys/visits/incr \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"by":1}'

# Hash, list, set and sorted set
curl -s -XPUT localhost:8080/v1/faststore/hashes/user:42 \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"values":{"name":"Alice","plan":"pro"},"ttlSeconds":600}'
curl -s -XPOST localhost:8080/v1/faststore/lists/events/push \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"values":["login","checkout"],"side":"right"}'
curl -s -XPOST localhost:8080/v1/faststore/sets/roles/add \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"members":["admin","editor"]}'
curl -s -XPOST localhost:8080/v1/faststore/zsets/leaderboard/add \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"members":[{"member":"alice","score":100}]}'`;

const FASTSTORE_LOCK = `# Acquire with a 60s lease, waiting up to 5s; unique token per acquisition
curl -s -XPOST localhost:8080/v1/faststore/locks/cron:nightly/acquire \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"ttlSeconds":60,"waitMs":5000}'

# -> {"acquired":true,"token":"...","expiresAt":"..."}
# Only the owner may release/extend; acquire failure is HTTP 200 {acquired:false}

curl -s -XPOST localhost:8080/v1/faststore/locks/cron:nightly/release \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"token":"<token>"}'`;

const FASTSTORE_LIMITS = `# Keys 1..512 chars, no "/" or "\\".
# TTL 1..2592000s; 0 clears an existing TTL; reads return ttlSeconds:null when none.
# Scan limit 1..500 | batch <=100 operations
# Hash <=500 fields | list/set/sorted-set <=1000 members
# Batch operations: set, get, delete, incr, expire
# Read /ttl returns -1 when the key has no expiry and 404 when it does not exist.`;

const QUEUE_QUICKSTART = `# Optional: tune retries / lease default (idempotent create-or-update)
curl -s -XPUT localhost:8080/v1/queue/queues/emails \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxAttempts":5,"visibilityTimeoutSeconds":30}'

# Publish (201); a duplicate dedupeKey returns the original message with 200
curl -s -XPOST localhost:8080/v1/queue/queues/emails/messages \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"payload":{"to":"alice@acme.test"},"dedupeKey":"welcome:alice"}'

# Consume a lease (attempts increments on every consume)
curl -s -XPOST localhost:8080/v1/queue/queues/emails/consume \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"maxMessages":10,"visibilityTimeoutSeconds":30,"consumer":"mailer-1"}'

# Ack with the returned receipt (or send {"receipts":[...]} for a batch)
curl -s -XPOST localhost:8080/v1/queue/queues/emails/ack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>"}'`;

const QUEUE_RETRY = `# Requeue for a later attempt
curl -s -XPOST localhost:8080/v1/queue/queues/emails/nack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","requeue":true,"delaySeconds":60,"error":"smtp timeout"}'

# Dead-letter immediately (requeue:false), or automatically at attempts >= maxAttempts
curl -s -XPOST localhost:8080/v1/queue/queues/emails/nack \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","requeue":false,"error":"invalid address"}'

# Extend a long-running lease
curl -s -XPOST localhost:8080/v1/queue/queues/emails/heartbeat \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"receipt":"<receipt>","visibilityTimeoutSeconds":120}'

# Inspect and replay dead letters
curl -s "localhost:8080/v1/queue/queues/emails/dead?limit=50" \\
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST localhost:8080/v1/queue/queues/emails/dead/<id>/replay \\
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"delaySeconds":0,"resetAttempts":true}'`;

const QUEUE_SEMANTICS = `# Delivery contract
# - at-least-once: consume leases a message; ack deletes it.
# - visibility timeout expiry returns the message to pending regardless of attempts.
# - nack requeues or dead-letters (requeue:false / attempts >= maxAttempts).
# - attempts increments on EVERY consume, including redeliveries.
# - dedupe suppresses duplicates only while the original message still exists.
# - purge clears ready + delayed + in-flight + dead messages and counters,
#   but keeps the queue configuration.
# - consume/ack/publish batch <=100 | payload <= QUEUE_MAX_PAYLOAD_BYTES (256 KiB)
# - delay <=7 days | maxAttempts 1..100 (default 5) | visibility 1..3600s (default 30)`;

const JS_QUICKSTART = `import { SynapseDXClient } from '@synapsedx/sdk';

const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });

const { accessToken } = await c.iam.login('demo@acme.local', 'acme');
c.setToken(accessToken);

// One client, one namespace per service:
await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
await c.base.createCollection({ name: 'parks', mapping: { name: 'profile.name' } });
await c.faststore.set('cache:demo', { ok: true }, { ttlSeconds: 300 });
await c.queue.publish('emails', { to: 'demo@acme.local' });

// Legacy flat methods still work, but emit a DeprecationWarning:
//   c.listOrgs() -> c.iam.listOrgs()`;

const JS_AUTH = `const c = new SynapseDXClient({
  baseUrl: 'http://localhost:8080',
  token: jwt,                 // Bearer JWT
  apiKey: key,                // or X-API-Key (use one auth mode)
  tenant: 'org:acme',         // x-synapsedx-tenant (platform callers)
  timeoutMs: 15000,
});

c.setToken(jwt);
c.setApiKey(key);
c.setTenant('org:acme');      // pass undefined to clear

const me = await c.iam.me();
const verified = await c.iam.verify();
const { refreshToken } = await c.iam.login('demo@acme.local', 'acme');
await c.iam.refresh(refreshToken);
await c.iam.logout(refreshToken);`;

const JS_IAM = `const org = await c.iam.createOrg('acme', 'ACME Corp');
const account = await c.iam.createAccount(org.id, 'prod', 'Production');
const user = await c.iam.createUser(org.id, 'alice@acme.local', 'Alice');

const role = await c.iam.createRole(account.id, 'runner', 'Workflow runner');
const policy = await c.iam.createPolicy(account.id, 'exec', {
  Version: '2026-01-01',
  Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*' }],
});
await c.iam.attachPolicy(role.id, policy.id);
await c.iam.assignRole(user.id, role.id);

const { allowed } = await c.iam.authorize(user.id, 'workflow:Execute', '*');
const key = await c.iam.createApiKey(account.id, 'ci', ['workflow:Execute']);
const accounts = await c.iam.listAccounts(org.id);
const audit = await c.iam.listAudit(20);`;

const JS_WORKFLOWS = `const templates = await c.workflow.listTemplates();
const wf = await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
await c.workflow.activateWorkflow(wf.id);

const run = await c.workflow.executeWorkflow(wf.id, { value: 21 });
const test = await c.workflow.testRun(definition, { value: 21 });
const executions = await c.workflow.listExecutions({ limit: 10 });
const detail = await c.workflow.getExecution(run.executionId, true);

await c.workflow.updateWorkflow(wf.id, { name: 'renamed' });
await c.workflow.deactivateWorkflow(wf.id);`;

const JS_LDS = `const licenses = await c.lds.licenses();
const ds = await c.lds.createDatasource({
  name: 'Business Registry',
  entityType: 'Organization',
  license: 'CC-BY-4.0',
});
await c.lds.setAttributes(ds.id, [
  { name: 'name', ngsiLdType: 'Property', visibility: 'public' },
]);
const result = await c.lds.ingest(ds.id, [{ id: '55001', name: 'ABC' }]);
const entities = await c.lds.entities(ds.id, { visibility: 'public' });
const stats = await c.lds.stats(ds.id);`;

const JS_BASE = `// Dynamic API (raw objects / data)
const doc = await c.base.createDocument('parks', {
  id: 'park-1',
  object: { name: 'Central', capacity: 120 },
});
const page = await c.base.queryDocuments('parks', {
  where: { capacity: { gte: 100 } },
  orderBy: [{ field: 'name', direction: 'asc' }],
  as: 'object',
});

// Typed collection: model keys must equal logical mapping names
const parks = c.base.collection('parks', {
  mapping: { name: 'profile.name', capacity: 'profile.capacity' },
});
await parks.create({ name: 'Riverside', capacity: 80 }, { id: 'park-2' });
const park = await parks.get('park-1');
await parks.update('park-1', { capacity: 200 }, { ifVersion: doc.version });
await parks.increment('park-1', { field: 'profile.capacity', by: 10 });
const changes = await parks.changes({ since: '2026-10-01T00:00:00Z' });`;

const JS_FASTSTORE = `await c.faststore.set('session:42', { userId: 42 }, { ttlSeconds: 900 });
const item = await c.faststore.get('session:42');   // { key, type, value, ttlSeconds }
await c.faststore.incr('visits', { by: 1 });
await c.faststore.expire('visits', 3600);

await c.faststore.hashSet('user:42', { name: 'Alice' }, { ttlSeconds: 600 });
await c.faststore.listPush('events', ['login'], { side: 'right' });
await c.faststore.setAdd('roles', ['admin', 'editor']);
await c.faststore.zsetAdd('leaderboard', [{ member: 'alice', score: 100 }]);

const lock = await c.faststore.lockAcquire('cron:nightly', { ttlSeconds: 60, waitMs: 5000 });
if (lock.acquired) {
  try {
    // critical section
  } finally {
    await c.faststore.lockRelease('cron:nightly', lock.token);
  }
}`;

const JS_QUEUE = `await c.queue.createQueue('emails', { maxAttempts: 5, visibilityTimeoutSeconds: 30 });
const message = await c.queue.publish('emails', { to: 'alice@acme.test' }, {
  dedupeKey: 'welcome:alice',
});

const { messages } = await c.queue.consume('emails', {
  maxMessages: 10,
  visibilityTimeoutSeconds: 30,
  consumer: 'mailer-1',
});
for (const m of messages) {
  try {
    await handle(m.payload);                        // your processor
    await c.queue.ack('emails', m.receipt);
  } catch (e) {
    await c.queue.nack('emails', m.receipt, { error: String(e) });
  }
}

const dead = await c.queue.deadLetters('emails', { limit: 50 });
await c.queue.replayDead('emails', dead.messages[0].id, { resetAttempts: true });`;

const JS_ERRORS = `import { SynapseDXError } from '@synapsedx/sdk';

try {
  await c.base.getDocument('parks', 'missing');
} catch (e) {
  if (e instanceof SynapseDXError) {
    console.error(e.status, e.body);   // status is undefined for network errors
  }
}

// c.call(method, path, body) is the forward-compat escape hatch.
await c.call('GET', '/v1/base/collections');`;

const PYTHON_QUICKSTART = `from synapsedx_sdk import SynapseDXClient

c = SynapseDXClient("http://localhost:8080")
login = c.iam.login("demo@acme.local", "acme")
c.set_token(login["accessToken"])

c.workflow.create_workflow_from_template("webhook-to-log", "demo")
c.base.create_collection("parks", mapping={"name": "profile.name"})
c.faststore.set("cache:demo", {"ok": True}, ttl_seconds=300)
c.queue.publish("emails", {"to": "demo@acme.local"})

# Legacy flat methods still work but emit DeprecationWarning:
#   c.list_orgs() -> c.iam.list_orgs()`;

const PYTHON_AUTH = `c = SynapseDXClient(
    "http://localhost:8080",
    token=jwt,                 # Bearer JWT
    api_key=key,               # or X-API-Key (use one auth mode)
    tenant="org:acme",         # x-synapsedx-tenant (platform callers)
    timeout=15,
)
c.set_token(jwt)
c.set_api_key(key)
c.tenant = "org:acme"          # None clears it

me = c.iam.me()
verified = c.iam.verify()
login = c.iam.login("demo@acme.local", "acme")
c.iam.refresh(login["refreshToken"])
c.iam.logout(login["refreshToken"])`;

const PYTHON_IAM = `org = c.iam.create_org("acme", "ACME Corp")
account = c.iam.create_account(org["id"], "prod", "Production")
user = c.iam.create_user(org["id"], "alice@acme.local", "Alice")

role = c.iam.create_role(account["id"], "runner", "Workflow runner")
policy = c.iam.create_policy(account["id"], "exec", {
    "Version": "2026-01-01",
    "Statement": [{"Effect": "Allow", "Action": ["workflow:Execute"], "Resource": "*"}],
})
c.iam.attach_policy(role["id"], policy["id"])
c.iam.assign_role(user["id"], role["id"])

allowed = c.iam.authorize(user["id"], "workflow:Execute", "*")["allowed"]
key = c.iam.create_api_key(account["id"], "ci", ["workflow:Execute"])
audit = c.iam.list_audit(20)`;

const PYTHON_WORKFLOWS = `templates = c.workflow.list_templates()
wf = c.workflow.create_workflow_from_template("webhook-to-log", "demo")
c.workflow.activate_workflow(wf["id"])

run = c.workflow.execute_workflow(wf["id"], {"value": 21})
test = c.workflow.test_run(definition, {"value": 21})
executions = c.workflow.list_executions({"limit": 10})
detail = c.workflow.get_execution(run["executionId"], include_data=True)

c.workflow.update_workflow(wf["id"], name="renamed")
c.workflow.deactivate_workflow(wf["id"])`;

const PYTHON_LDS = `licenses = c.lds.list_licenses()
ds = c.lds.create_datasource(
    name="Business Registry",
    entity_type="Organization",
    license="CC-BY-4.0",
)
c.lds.set_datasource_attributes(ds["id"], [
    {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
])
result = c.lds.ingest_records(ds["id"], [{"id": "55001", "name": "ABC"}])
entities = c.lds.list_entities(ds["id"], visibility="public")
stats = c.lds.get_datasource_stats(ds["id"])`;

const PYTHON_BASE = `# Dynamic API
doc = c.base.create_document("parks", object={"name": "Central", "capacity": 120}, id="park-1")
page = c.base.query_documents(
    "parks",
    {"capacity": {"gte": 100}},
    order_by=[{"field": "name", "direction": "asc"}],
    as_view="object",
)
print(page.total, page.next_cursor)

# Typed collection: dataclass attribute names == logical mapping names
from dataclasses import dataclass

@dataclass
class Park:
    name: str
    capacity: int | None = None

parks = c.base.collection("parks", model=Park, mapping={"name": "profile.name", "capacity": "profile.capacity"})
parks.create(Park("Riverside", 80), id="park-2")
park = parks.get("park-1")
parks.update("park-1", Park("Central Park", 200), if_version=doc["version"])
parks.increment("park-1", "profile.capacity", by=10)
changes = parks.changes("2026-10-01T00:00:00Z")`;

const PYTHON_FASTSTORE = `c.faststore.set("session:42", {"userId": 42}, ttl_seconds=900)
item = c.faststore.get("session:42")
c.faststore.incr("visits", by=1)
c.faststore.expire("visits", 3600)

c.faststore.hash_set("user:42", {"name": "Alice"}, ttl_seconds=600)
c.faststore.list_push("events", ["login"], side="right")
c.faststore.set_add("roles", ["admin", "editor"])
c.faststore.zset_add("leaderboard", [{"member": "alice", "score": 100}])

lock = c.faststore.lock_acquire("cron:nightly", ttl_seconds=60, wait_ms=5000)
if lock["acquired"]:
    try:
        pass  # critical section
    finally:
        c.faststore.lock_release("cron:nightly", lock["token"])`;

const PYTHON_QUEUE = `c.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=30)
message = c.queue.publish("emails", {"to": "alice@acme.test"}, dedupe_key="welcome:alice")

result = c.queue.consume("emails", max_messages=10, consumer="mailer-1")
for m in result["messages"]:
    try:
        handle(m["payload"])                       # your processor
        c.queue.ack("emails", m["receipt"])
    except Exception as exc:
        c.queue.nack("emails", m["receipt"], error=str(exc))

dead = c.queue.dead_letters("emails", limit=50)
c.queue.replay_dead("emails", dead["messages"][0]["id"], reset_attempts=True)`;

const PYTHON_ERRORS = `from synapsedx_sdk import SynapseDXError

try:
    c.base.get_document("parks", "missing")
except SynapseDXError as e:
    print(e.status, e.body)   # status is None for network errors

# Forward-compat escape hatch:
c.call("GET", "/v1/base/collections")`;

const GO_QUICKSTART = `import synapsedx "github.com/synapsedx/synapsedx-sdk-go"

c := synapsedx.New("http://localhost:8080")

login, err := c.Login("demo@acme.local", "acme")
if err != nil { log.Fatal(err) }
c.SetToken(login["accessToken"].(string))

_, err = c.ListOrgs()
_, err = c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
_, err = c.CreateBaseCollection(map[string]any{"name": "parks"})
_, err = c.FaststoreSet("cache:demo", map[string]any{"ok": true},
    synapsedx.FaststoreSetOptions{TTLSeconds: 300})
_, err = c.PublishMessage("emails", map[string]any{"to": "demo@acme.local"},
    synapsedx.QueuePublishOptions{})
if err != nil { log.Fatal(err) }`;

const GO_AUTH = `c := synapsedx.New("http://localhost:8080")
c.SetToken(jwt)        // Bearer JWT
c.SetAPIKey(key)       // or X-API-Key (use one auth mode)
c.SetTenant("org:acme") // x-synapsedx-tenant (platform callers; "" clears)

login, err := c.Login("demo@acme.local", "acme")
refreshed, err := c.Refresh(login["refreshToken"].(string))
_, err = c.LogoutAll(refreshed["refreshToken"].(string))
_, err = c.Me()
_, err = c.Verify()
if err != nil { log.Fatal(err) }`;

const GO_IAM = `org, err := c.CreateOrg("acme", "ACME Corp")
acct, err := c.CreateAccount(org["id"].(string), "prod", "Production")
user, err := c.CreateUser(org["id"].(string), "alice@acme.local", "Alice")

role, err := c.CreateRole(acct["id"].(string), "runner", "Workflow runner")
policy, err := c.CreatePolicy(acct["id"].(string), "exec", map[string]any{
    "Version": "2026-01-01",
    "Statement": []any{
        map[string]any{"Effect": "Allow", "Action": []string{"workflow:Execute"}, "Resource": "*"},
    },
}, "")
err = c.AttachPolicy(role["id"].(string), policy["id"].(string))
err = c.AssignRole(user["id"].(string), role["id"].(string))

result, err := c.Authorize(user["id"].(string), "workflow:Execute", "*", nil)
fmt.Println(result["allowed"])
_, err = c.ListAPIKeys(acct["id"].(string))
_, err = c.ListAudit(20, "")
if err != nil { log.Fatal(err) }`;

const GO_WORKFLOWS = `_, err := c.ListTemplates()
wf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
err = c.ActivateWorkflow(wf["id"].(string))

run, err := c.ExecuteWorkflow(wf["id"].(string), map[string]any{"value": 21})
_, err = c.TestRun(definition, map[string]any{"value": 21}, "")
_, err = c.ListExecutions("limit=10")
_, err = c.GetExecutionWithData(run["executionId"].(string), true)

_, err = c.UpdateWorkflow(wf["id"].(string), map[string]any{"name": "renamed"})
err = c.DeactivateWorkflow(wf["id"].(string))
if err != nil { log.Fatal(err) }`;

const GO_LDS = `_, err := c.ListLDSLicenses()
ds, err := c.CreateLDSDatasource(map[string]any{
    "name": "Business Registry", "entityType": "Organization", "license": "CC-BY-4.0",
})
_, err = c.SetLDSAttributes(ds["id"].(string), []any{
    map[string]any{"name": "name", "ngsiLdType": "Property", "visibility": "public"},
})
_, err = c.IngestLDSRecords(ds["id"].(string), []any{map[string]any{"id": "55001", "name": "ABC"}})
_, err = c.ListLDSEntities(ds["id"].(string),
    map[string]string{"visibility": "public", "limit": "100"})
_, err = c.GetLDSStats(ds["id"].(string))
if err != nil { log.Fatal(err) }`;

const GO_BASE = `type Park struct {
    Name     string \`json:"name"\`
    Capacity int    \`json:"capacity"\`
}

mapping := synapsedx.NewBaseMapping(map[string]string{
    "name": "profile.name", "capacity": "profile.capacity",
})
parks := synapsedx.NewBaseCollection[Park](c, "parks", mapping)

park, err := parks.Create(Park{Name: "Central", Capacity: 120}, "park-1")
page, err := parks.Query(synapsedx.BaseQuery{
    Where:   map[string]any{"capacity": map[string]any{"gte": 100}},
    OrderBy: []synapsedx.BaseOrderBy{{Field: "name", Direction: "asc"}},
    Limit:   20,
})
park, err = parks.Set("park-1", Park{Name: "Central Park", Capacity: 200}, 1, false)
park, err = parks.Increment("park-1", "profile.capacity", 10, 0)
changes, err := parks.Changes("2026-10-01T00:00:00Z", 100)
fmt.Println(park.Name, page.Total, changes["nextSince"])
if err != nil { log.Fatal(err) }`;

const GO_FASTSTORE = `_, err := c.FaststoreSet("session:42", map[string]any{"userId": 42},
    synapsedx.FaststoreSetOptions{TTLSeconds: 900})
item, err := c.FaststoreGet("session:42")
fmt.Println(item["value"])
_, err = c.FaststoreIncr("visits", 1, 0)
_, err = c.FaststoreExpire("visits", 3600)

_, err = c.FaststoreHashSet("user:42", map[string]any{"name": "Alice"}, 600)
_, err = c.FaststoreListPush("events", []any{"login"},
    synapsedx.FaststoreListPushOptions{Side: "right"})
_, err = c.FaststoreSetAdd("roles", []any{"admin", "editor"}, 0)
_, err = c.FaststoreZSetAdd("leaderboard",
    []synapsedx.FaststoreZSetMember{{Member: "alice", Score: 100}}, 0)

lock, err := c.FaststoreLockAcquire("cron:nightly",
    synapsedx.FaststoreLockOptions{TTLSeconds: 60, WaitMS: 5000})
if acquired, _ := lock["acquired"].(bool); acquired {
    defer c.FaststoreLockRelease("cron:nightly", lock["token"].(string))
    // critical section
}
if err != nil { log.Fatal(err) }`;

const GO_QUEUE = `_, err := c.CreateQueue("emails", synapsedx.QueueConfig{
    MaxAttempts: 5, VisibilityTimeoutSeconds: 30,
})
msg, err := c.PublishMessage("emails", map[string]any{"to": "alice@acme.test"},
    synapsedx.QueuePublishOptions{DedupeKey: "welcome:alice"})
fmt.Println(msg["id"])

out, err := c.ConsumeMessages("emails", synapsedx.QueueConsumeOptions{
    MaxMessages: 10, VisibilityTimeoutSeconds: 30, Consumer: "mailer-1",
})
// handle is your message processor: func handle(payload any) error
for _, raw := range out["messages"].([]any) {
    m := raw.(map[string]any)
    if err := handle(m["payload"]); err != nil {
        _, _ = c.NackMessage("emails", m["receipt"].(string),
            synapsedx.QueueNackOptions{Error: err.Error()})
        continue
    }
    _, _ = c.AckMessage("emails", m["receipt"].(string))
}

dead, err := c.DeadMessages("emails", 50)
first := dead["messages"].([]any)[0].(map[string]any)
_, err = c.ReplayDeadMessage("emails", first["id"].(string), 0, true)
if err != nil { log.Fatal(err) }`;

const GO_ERRORS = `// Every call returns (result, error). HTTP failures carry status + body text.
result, err := c.GetBaseDocument("parks", "missing", "object")
if err != nil {
    log.Printf("base call failed: %v", err)
}

// Forward-compat escape hatch:
result, err = c.Call("GET", "/v1/base/collections", nil)
fmt.Println(result)`;

const CLI_INSTALL = `# one-line installer (recommended)
curl -fsSL https://synapsedx.sbs/install.sh | sh

# the Docker Console serves the same installer locally
curl -fsSL http://localhost:3000/install.sh | sh

# npm registry
npm install -g @synapsedx/cli@latest

# run without installing
npx -y @synapsedx/cli@latest --help

# from source
node tools/cli/bin/synapsedx.js --help`;

const CLI_CONFIG = `# Base URL resolution (first match wins):
#   --base <URL> > $SYNAPSEDX_BASE_URL > ~/.synapsedx/config.json > http://localhost:8080
#
# Auth resolution (first match wins):
#   --token/--apikey > $SYNAPSEDX_TOKEN/$SYNAPSEDX_API_KEY > config file
#
# Global flags:
#   --base URL   --token T   --apikey K   --json
#   --context k=v (repeatable)   --file path
#   --limit N   --actor ID   --name N   --template T
#   --email E   --org SLUG   --label L`;

const CLI_AUTH = `synapsedx login --email demo@acme.local [--org acme]
synapsedx refresh [refresh-token]
synapsedx logout-all [refresh-token]
synapsedx logout
synapsedx verify
synapsedx use-key <api-key>
synapsedx whoami
synapsedx config`;

const CLI_IAM = `synapsedx orgs
synapsedx orgs create <slug> [name]
synapsedx accounts [org]
synapsedx accounts create [org] <slug> [name]
synapsedx users [org]
synapsedx users create <org> <email> [name]

synapsedx roles <account>
synapsedx roles create <account> <slug>
synapsedx policies <account>
synapsedx policies create <account> <slug> --file policy.json
synapsedx attach <role-id> <policy-id>
synapsedx detach <role-id> <policy-id>
synapsedx assign <user-id> <role-id>
synapsedx unassign <user-id> <role-id>
synapsedx roles delete <id>
synapsedx policies delete <id>
synapsedx authz <user-id> <action> <resource> [--context k=v]
synapsedx sim --file policy.json <action> <resource> [--context k=v]
synapsedx audit [--limit N] [--actor ID]`;

const CLI_ACCESS = `synapsedx keys create <account> [--name N]
synapsedx keys list <account>
synapsedx keys revoke <key-id>
synapsedx keys verify <api-key>

synapsedx sa <account>
synapsedx sa create <account> <slug>
synapsedx sa token <sa-id>

# Account credentials are secret-write-only.
synapsedx credentials create <account> --name N --type bearer|basic|apiKey|oauth2 \\
  (--secret S | --secret-file F) [--expires-at ISO]
synapsedx credentials list <account>
synapsedx credentials get|delete <id>
synapsedx credentials rotate <id> (--secret S | --secret-file F)`;

const CLI_WORKFLOWS = `synapsedx workflows
synapsedx workflows create --template <name> [--name N]
synapsedx workflows create --file definition.json [--name N]
synapsedx workflows get <id>
synapsedx workflows activate <id>
synapsedx workflows deactivate <id>
synapsedx workflows exec <id> [--data '{...}']
synapsedx workflows test-run --file def.json --input input.json

synapsedx templates
synapsedx templates <name>
synapsedx executions list [--limit N] [--workflow-id ID] [--status success|error]
synapsedx executions <id> [--include-data]`;

const CLI_LDS = `synapsedx lds licenses
synapsedx lds datasources [list] [--org <orgId>] [--account <accountId>]
synapsedx lds datasources create --name N --entity-type T --license SPDX
synapsedx lds datasources get|delete <id>
synapsedx lds attributes list <id>
synapsedx lds attributes set <id> --file attrs.json
synapsedx lds ingest <id> --file record.json
synapsedx lds entities <id> [--limit N] [--visibility public|restricted]
synapsedx lds entity <id> <entity-id>
synapsedx lds stats <id>`;

const CLI_CALL = `# Base, Faststore and Queue are available through the generic gateway call:
synapsedx call POST /v1/base/collections --data '{"name":"parks"}'
synapsedx call GET /v1/base/collections
synapsedx call PUT /v1/faststore/keys/cache:demo --data '{"value":{"ok":true},"ttlSeconds":300}'
synapsedx call POST /v1/queue/queues/emails/messages --data '{"payload":{"to":"a@b.c"}}'

# Raw paths include gateway prefixes; use --file for larger JSON payloads.`;

const JS_INSTALL = `npm install @synapsedx/sdk
# or: yarn add @synapsedx/sdk
# or: pnpm add @synapsedx/sdk

# The package exposes per-service subpaths:
#   @synapsedx/sdk/base, /faststore, /queue, /iam, /workflow, /lds`;

const JS_SECTIONS = [
  { title: 'Install', code: JS_INSTALL },
  { title: 'Quick start', code: JS_QUICKSTART },
  { title: 'Auth, client options & tenancy', code: JS_AUTH },
  { title: 'IAM: orgs, roles, policies, keys', code: JS_IAM },
  { title: 'Workflows & executions', code: JS_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: JS_LDS },
  { title: 'SynapseBase', code: JS_BASE },
  { title: 'Synapse Faststore', code: JS_FASTSTORE },
  { title: 'SynapseQueue', code: JS_QUEUE },
  { title: 'Errors, escape hatch & deprecations', code: JS_ERRORS },
];

const PYTHON_INSTALL = `pip install synapsedx-sdk

# or with a virtualenv
python -m venv .venv
source .venv/bin/activate
pip install synapsedx-sdk

# Optional per-service imports:
from synapsedx_sdk.base import BaseService, BaseCollection
from synapsedx_sdk.faststore import FaststoreService
from synapsedx_sdk.queue import QueueService`;

const PYTHON_SECTIONS = [
  { title: 'Install', code: PYTHON_INSTALL },
  { title: 'Quick start', code: PYTHON_QUICKSTART },
  { title: 'Auth, client options & tenancy', code: PYTHON_AUTH },
  { title: 'IAM: orgs, roles, policies, keys', code: PYTHON_IAM },
  { title: 'Workflows & executions', code: PYTHON_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: PYTHON_LDS },
  { title: 'SynapseBase', code: PYTHON_BASE },
  { title: 'Synapse Faststore', code: PYTHON_FASTSTORE },
  { title: 'SynapseQueue', code: PYTHON_QUEUE },
  { title: 'Errors, escape hatch & deprecations', code: PYTHON_ERRORS },
];

const GO_INSTALL = `go get github.com/synapsedx/synapsedx-sdk-go@latest

# then import it:
#   import synapsedx "github.com/synapsedx/synapsedx-sdk-go"

# Go 1.22+; the client is a thin wrapper over net/http.`;

const GO_SECTIONS = [
  { title: 'Install', code: GO_INSTALL },
  { title: 'Quick start', code: GO_QUICKSTART },
  { title: 'Auth, client options & tenancy', code: GO_AUTH },
  { title: 'IAM: orgs, roles, policies, keys', code: GO_IAM },
  { title: 'Workflows & executions', code: GO_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: GO_LDS },
  { title: 'SynapseBase', code: GO_BASE },
  { title: 'Synapse Faststore', code: GO_FASTSTORE },
  { title: 'SynapseQueue', code: GO_QUEUE },
  { title: 'Errors, escape hatch & deprecations', code: GO_ERRORS },
];

const CLI_SECTIONS = [
  { title: 'Install', code: CLI_INSTALL },
  { title: 'Configuration', code: CLI_CONFIG },
  { title: 'Auth commands', code: CLI_AUTH },
  { title: 'Orgs, accounts, users, roles & policies', code: CLI_IAM },
  { title: 'API keys, service accounts & credentials', code: CLI_ACCESS },
  { title: 'Workflows, templates & executions', code: CLI_WORKFLOWS },
  { title: 'Linked Data (LDS)', code: CLI_LDS },
  { title: 'Base, Faststore & Queue (generic call)', code: CLI_CALL },
];

const BASE_COLLECTION_ENDPOINTS = [
  ['GET', '/v1/base/collections', 'List collections (?orgId / ?accountId narrows)'],
  ['POST', '/v1/base/collections', 'Create a collection and optional mapping'],
  ['GET', '/v1/base/collections/:collection', 'Collection details + stats'],
  ['PATCH', '/v1/base/collections/:collection', 'Rename / description / replace mapping'],
  ['DELETE', '/v1/base/collections/:collection', 'Delete collection and every document'],
  ['GET', '/v1/base/collections/:collection/stats', '{documents, bytes, lastUpdatedAt}'],
];

const BASE_DOCUMENT_ENDPOINTS = [
  ['POST', '/v1/base/collections/:collection/documents', 'Create (exactly one of data / object)'],
  ['GET', '/v1/base/collections/:collection/documents/:id', 'Read (?as=data|object)'],
  ['PUT', '/v1/base/collections/:collection/documents/:id', 'Upsert / replace / merge (ifVersion)'],
  ['PATCH', '/v1/base/collections/:collection/documents/:id', 'Deep merge + unset dot paths'],
  ['DELETE', '/v1/base/collections/:collection/documents/:id', 'Delete (ifVersion / If-Match)'],
  ['GET', '/v1/base/collections/:collection/documents', 'List raw data view (limit/offset)'],
];

const BASE_ADVANCED_ENDPOINTS = [
  ['POST', '/v1/base/collections/:collection/query', 'Filters, groups, orderBy, cursor, projection'],
  ['POST', '/v1/base/collections/:collection/documents/:id/increment', 'Atomic counter on a raw dot path'],
  ['POST', '/v1/base/collections/:collection/documents:batch', '1..100 ordered create/set/update/delete/increment'],
  ['GET', '/v1/base/collections/:collection/changes', 'Change feed (upserts only; use nextSince)'],
];

const BASE_OPERATORS = [
  ['eq / ne', 'Deep JSON equality / inequality (missing counts as not equal)'],
  ['gt / gte / lt / lte', 'Number/string/boolean comparison; incomparable values never match'],
  ['in / nin', 'Value is / is not in a non-empty array (<=1000 items)'],
  ['contains', 'Substring for strings, membership for arrays'],
  ['startsWith / endsWith', 'String prefix / suffix'],
  ['exists', 'Presence check (true when the path exists, including null)'],
];

const FASTSTORE_KEY_ENDPOINTS = [
  ['GET', '/v1/faststore/stats', 'Backend, tenant, key count and type breakdown'],
  ['GET', '/v1/faststore/keys', 'Scan keys (?prefix&limit&cursor)'],
  ['GET', '/v1/faststore/keys/:key', 'Read value + type + ttlSeconds'],
  ['PUT/POST', '/v1/faststore/keys/:key', 'Set value (ttlSeconds, ifNotExists, ifExists)'],
  ['DELETE', '/v1/faststore/keys/:key', 'Delete a key'],
  ['GET', '/v1/faststore/keys/:key/ttl', 'Remaining TTL (-1 = no expiry)'],
  ['POST', '/v1/faststore/keys/:key/expire', 'Set/clear TTL (0 clears)'],
  ['POST', '/v1/faststore/keys/:key/incr', 'Atomic counter (by, ttlSeconds)'],
  ['POST', '/v1/faststore/batch', '1..100 set/get/delete/incr/expire operations'],
];

const FASTSTORE_STRUCTURE_ENDPOINTS = [
  ['GET · PUT · DELETE', '/v1/faststore/hashes/:key', 'Hash value; /length, /:field and /incr sub-routes'],
  ['GET · POST · DELETE', '/v1/faststore/lists/:key', 'Range, push, pop, trim, length'],
  ['GET · POST · DELETE', '/v1/faststore/sets/:key', 'Members, add, remove, contains, card'],
  ['GET · POST · DELETE', '/v1/faststore/zsets/:key', 'Range, add, incr, remove, score, rank, card'],
  ['POST', '/v1/faststore/locks/:name/acquire', 'Acquire a distributed lock (ttlSeconds, waitMs, token)'],
  ['POST', '/v1/faststore/locks/:name/release', 'Release only with the owner token'],
  ['POST', '/v1/faststore/locks/:name/extend', 'Extend the lease with the owner token'],
];

const QUEUE_CONFIG_ENDPOINTS = [
  ['GET', '/v1/queue/queues', 'List queue configurations for the tenant'],
  ['PUT', '/v1/queue/queues/:queue', 'Idempotent create/update (maxAttempts, visibility)'],
  ['GET', '/v1/queue/queues/:queue', 'Configuration + stats'],
  ['DELETE', '/v1/queue/queues/:queue', 'Delete the queue and all messages'],
  ['POST', '/v1/queue/queues/:queue/purge', 'Clear ready + delayed + in-flight + dead messages'],
  ['GET', '/v1/queue/queues/:queue/stats', 'pending, inflight, dead and counters'],
];

const QUEUE_MESSAGE_ENDPOINTS = [
  ['POST', '/v1/queue/queues/:queue/messages', 'Publish (payload, delay, headers, id, dedupeKey)'],
  ['POST', '/v1/queue/queues/:queue/messages:batch', 'Publish 1..100 messages'],
  ['POST', '/v1/queue/queues/:queue/consume', 'Lease up to 100 messages (returns receipts)'],
  ['POST', '/v1/queue/queues/:queue/ack', 'Ack one receipt or a receipts batch'],
  ['POST', '/v1/queue/queues/:queue/nack', 'Requeue or dead-letter, with optional delay/error'],
  ['POST', '/v1/queue/queues/:queue/heartbeat', 'Extend an active visibility lease'],
];

const QUEUE_INSPECT_ENDPOINTS = [
  ['GET', '/v1/queue/queues/:queue/messages', 'Peek pending (ready + delayed; excludes in-flight)'],
  ['GET', '/v1/queue/queues/:queue/dead', 'Dead letters, newest first'],
  ['POST', '/v1/queue/queues/:queue/dead/:id/replay', 'Replay to pending (delaySeconds, resetAttempts)'],
  ['DELETE', '/v1/queue/queues/:queue/dead/:id', 'Delete a dead letter permanently'],
];

const SERVICE_MAP = [
  ['Gateway', '8080', '—', 'JWT/API-key auth, principal headers, rate limits, routing, /metrics'],
  ['IAM', '4001', '/v1/auth, /v1/orgs, …', 'Orgs, accounts, users, roles, policies, keys, OIDC'],
  ['Workflow', '4002', '/v1/workflows, /v1/templates', 'Built-in workflow engine, executions, webhooks'],
  ['AI', '4003', '/v1/ai', 'Documentation assistant and model gateway'],
  ['LDS', '4004', '/v1/lds', 'NGSI-LD datasources, attribute registry, licensed exports'],
  ['SynapseBase', '4005', '/v1/base', 'Documents, object ↔ data mapping, queries, change feed'],
  ['Faststore', '4006', '/v1/faststore', 'Redis-backed cache/KV, structures, distributed locks'],
  ['SynapseQueue', '4007', '/v1/queue', 'At-least-once messaging, retries, dead letters, replay'],
];

function Overview({ setTab }) {
  return (
    <div className="space-y-4">
      <Card className="bg-gradient-to-br from-main-start to-main-end text-white">
        <p className="text-xs font-semibold uppercase tracking-widest text-white/70 mb-2">SynapseDX platform</p>
        <h3 className="text-2xl font-semibold mb-2">Documents, cache and messaging — self-managed.</h3>
        <p className="text-sm text-white/85 max-w-3xl">
          SynapseBase, Synapse Faststore and SynapseQueue run next to IAM, the workflow engine and SynapseLDS.
          The gateway is the single public API; every client sees the same tenant-scoped data services.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            ['base', 'SynapseBase guide'],
            ['faststore', 'Faststore guide'],
            ['queue', 'Queue guide'],
            ['javascript', 'JavaScript SDK'],
            ['python', 'Python SDK'],
            ['go', 'Go SDK'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className="px-3 py-1.5 rounded-2xl text-xs font-medium bg-white/15 text-white hover:bg-white/25"
            >
              {label} →
            </button>
          ))}
          <Link to="/api-docs" className="px-3 py-1.5 rounded-2xl text-xs font-medium bg-white text-main-blue hover:bg-white/90">
            Try the API live →
          </Link>
        </div>
      </Card>

      <DocSection title="Service map" kicker="Architecture">
        <Table head={['Service', 'Port', 'Gateway prefix', 'Responsibility']}>
          {SERVICE_MAP.map(([service, port, prefix, desc]) => (
            <tr key={service} className="border-t border-slate-100 align-top">
              <td className="py-2 pr-4 text-xs font-medium text-main-text whitespace-nowrap">{service}</td>
              <td className="py-2 pr-4 text-xs tabular-nums">{port}</td>
              <td className="py-2 pr-4 text-xs">
                <code className="text-main-text break-all">{prefix}</code>
              </td>
              <td className="py-2 text-xs">{desc}</td>
            </tr>
          ))}
        </Table>
        <Text>
          Only the gateway is public in production. Direct service calls additionally require
          <code className="mx-1 text-main-text">x-synapsedx-internal</code>
          when <code className="text-main-text">SYNAPSEDX_INTERNAL_SECRET</code> is configured.
        </Text>
      </DocSection>

      <DocSection title="Run the stack with Docker" kicker="Getting started">
        <Text>
          The repository ships a complete Compose stack. SynapseBase persists to Postgres, while
          Faststore and SynapseQueue use Redis; each service falls back to in-memory storage only when
          its backend URL is absent (dev/tests).
        </Text>
        <DocCode data={OVERVIEW_RUN} />
        <Bullets
          items={[
            'Replace every *_change_me_* secret in .env before exposing the stack.',
            'docker compose up -d --build rebuilds the Console, gateway and services after source changes.',
            'Production: use docker-compose.prod.yml with the infra/prod TLS overlay; see docs/production.md in the repository.',
            'Console: http://localhost:3000 — sign in with demo@acme.local / org acme, or an API key.',
          ]}
        />
      </DocSection>

      <DocSection title="One request per data service" kicker="First flow">
        <DocCode data={OVERVIEW_FLOW} />
        <Text>
          All snippets use the gateway at <code className="text-main-text">:8080</code>. Swap in your own
          token (or an API key) and the examples work unchanged against a Docker deployment.
        </Text>
      </DocSection>

      <DocSection title="Authentication and tenancy" kicker="Security model">
        <Bullets
          items={[
            'Call the gateway with Authorization: Bearer <JWT> or X-API-Key. /v1/auth/* and the public LDS export routes are the only unauthenticated endpoints.',
            'The gateway strips client-sent x-synapsedx-* headers and re-stamps them from the verified principal, so services never re-verify the JWT.',
            'Principal callers are scoped automatically: org → org:<id>, otherwise account → account:<id>, otherwise user → user:<sub>.',
            'Platform callers (no principal) select a tenant with x-synapsedx-tenant or ?tenant=. Missing tenant is 400 tenant_required.',
            'SDKs expose the same switch: tenant in the constructor (JavaScript/Python) or SetTenant (Go).',
            'Never send the internal secret from a browser; it is for service-to-service calls only.',
          ]}
        />
      </DocSection>

      <DocSection title="SDK namespaces at a glance" kicker="Clients">
        <Table head={['Namespace', 'Covers']}>
          {[
            ['client.iam', 'Auth/OIDC, orgs, accounts, users, roles, policies, keys, service accounts, credentials'],
            ['client.workflow', 'Templates, workflow CRUD/lifecycle, executions, test runs'],
            ['client.lds', 'Datasources, attribute registry, ingest, NGSI-LD entities, licenses'],
            ['client.base', 'Collections, documents, mapped objects, queries, counters, batch, changes'],
            ['client.faststore', 'Strings/counters, hashes, lists, sets, sorted sets, scans, locks'],
            ['client.queue', 'Queues, publish/consume, ack/nack/heartbeat, dead letters, replay'],
          ].map(([name, covers]) => (
            <tr key={name} className="border-t border-slate-100">
              <td className="py-2 pr-4"><code className="text-xs text-main-text">{name}</code></td>
              <td className="py-2 text-xs">{covers}</td>
            </tr>
          ))}
        </Table>
        <Text>
          Python and JavaScript use the namespaces above. Go exposes flat methods on one
          <code className="mx-1 text-main-text">Client</code>
          (for example <code className="text-main-text">CreateBaseCollection</code>,
          <code className="mx-1 text-main-text">FaststoreSet</code>
          and <code className="text-main-text">PublishMessage</code>) plus generic typed
          <code className="mx-1 text-main-text">BaseCollection[T]</code>.
        </Text>
      </DocSection>
    </div>
  );
}

function BaseDoc() {
  return (
    <div className="space-y-4">
      <DocSection title="SynapseBase" kicker="Documents · port 4005 · /v1/base">
        <Text>
          A self-managed document database with server-side validation and a first-class
          object ↔ data mapping. Write logical objects, store raw JSON, and query either view.
        </Text>
        <Bullets
          items={[
            'Collections are scoped to the caller tenant; names are unique within that scope.',
            'Documents carry id, version, createdAt and updatedAt; writes bump version.',
            'Postgres is the production store; tests and local runs use an in-memory fallback.',
            'Full endpoint reference with try-it forms: open the API Docs page.',
          ]}
        />
      </DocSection>

      <DocSection title="Mapping objects to stored data" kicker="Core concept">
        <DocCode data={BASE_MAPPING} />
        <Bullets
          items={[
            'Send exactly one of data or object on writes. object keys are logical names; the service stores each one at its mapped dot path.',
            'Read with ?as=object (or "as": "object" in a query) to project the stored data back onto logical names.',
            'The mapping is a validation/view contract, not a migration: changing it never rewrites stored documents.',
            'Types are string | number | boolean | date | array | object | any. required is enforced on POST/PUT and object writes, not on PATCH.',
            'additional:false rejects undeclared object keys; additional:true stores them at their own path. Raw data writes keep unmapped keys either way.',
          ]}
        />
      </DocSection>

      <DocSection title="Quick start" kicker="Write and read">
        <DocCode data={BASE_QUICKSTART} />
      </DocSection>

      <DocSection title="Collections" kicker="API reference">
        <EndpointTable rows={BASE_COLLECTION_ENDPOINTS} />
      </DocSection>

      <DocSection title="Documents" kicker="API reference">
        <EndpointTable rows={BASE_DOCUMENT_ENDPOINTS} />
        <Text>
          Document ids allow <code className="text-main-text">[A-Za-z0-9_@.:+-]</code> up to 256
          characters; <code className="text-main-text">/</code>, <code className="text-main-text">\\</code>,
          <code className="mx-1 text-main-text">.</code> and <code className="text-main-text">..</code> are rejected.
          A duplicate create is <code className="text-main-text">409 document_exists</code>.
        </Text>
      </DocSection>

      <DocSection title="Queries, counters, batch and change feed" kicker="API reference">
        <EndpointTable rows={BASE_ADVANCED_ENDPOINTS} />
        <DocCode data={BASE_QUERY} />
        <OperatorTable rows={BASE_OPERATORS} />
        <Text>
          <code className="text-main-text">where</code> accepts logical mapping names or dot paths,
          shorthand <code className="text-main-text">{'{"capacity":{"gte":100}}'}</code>, and groups
          <code className="mx-1 text-main-text">and/or/not</code>. Document metadata is addressable as
          <code className="mx-1 text-main-text">$id/$version/$createdAt/$updatedAt</code>.
          Query responses return <code className="text-main-text">{'{items,total,limit,offset,nextCursor}'}</code>.
        </Text>
        <DocCode data={BASE_WRITES} />
        <Bullets
          items={[
            'ifVersion gives compare-and-set semantics; ifVersion:0 means create-only. If-Match: "<version>" is also accepted.',
            'Increment uses a raw dot path (not a logical name), creates a missing document at version 1, and accepts ifVersion:0 for that create.',
            'Batch operations run in order; the response reports per-op results and ok only when every operation succeeded.',
            'The change feed emits upserts only; deleted is always false. Poll with the returned nextSince and follow hasMore.',
          ]}
        />
      </DocSection>

      <DocSection title="Limits and errors" kicker="Operations">
        <DocCode data={BASE_LIMITS} />
        <Text>
          Common errors: <code className="text-main-text">400 mapping_error</code> (missing/typed/unknown field),
          <code className="mx-1 text-main-text">409 version_conflict</code>,
          <code className="mx-1 text-main-text">409 ambiguous_collection</code> (platform caller must pass ?orgId/?accountId),
          <code className="mx-1 text-main-text">413 collection_too_large</code> (narrow the query or raise BASE_QUERY_SCAN_LIMIT).
        </Text>
      </DocSection>
    </div>
  );
}

function FaststoreDoc() {
  return (
    <div className="space-y-4">
      <DocSection title="Synapse Faststore" kicker="Cache · port 4006 · /v1/faststore">
        <Text>
          A tenant-scoped Redis-backed cache and key/value service: TTL strings, counters,
          hashes, lists, sets, sorted sets, scans, batches and distributed locks. Without a
          Redis URL the service falls back to in-memory storage for local development.
        </Text>
        <Bullets
          items={[
            'Keys are strings of 1..512 characters and may not contain "/" or "\\".',
            'Tenant scoping comes from the principal; platform callers pass x-synapsedx-tenant or ?tenant=.',
            'Reads return ttlSeconds:null when the key has no expiry; /ttl returns -1 for no expiry and 404 when absent.',
            '0 TTL clears an existing expiry; valid TTLs are 1..2,592,000 seconds (30 days).',
          ]}
        />
      </DocSection>

      <DocSection title="Keys, TTL and counters" kicker="Quick start">
        <DocCode data={FASTSTORE_QUICKSTART} />
      </DocSection>

      <DocSection title="Key/value API" kicker="API reference">
        <EndpointTable rows={FASTSTORE_KEY_ENDPOINTS} />
      </DocSection>

      <DocSection title="Hashes, collections and locks" kicker="API reference">
        <EndpointTable rows={FASTSTORE_STRUCTURE_ENDPOINTS} />
        <DocCode data={FASTSTORE_LOCK} />
        <Bullets
          items={[
            'Lock acquire always returns 200: acquired:true with a token, or acquired:false when the wait budget expires.',
            'Release and extend require the owner token; a stolen/expired lock can never be released by a stale owner.',
            'Scans return {keys, cursor, truncated}; pass cursor back to continue. Batch supports set/get/delete/incr/expire.',
          ]}
        />
      </DocSection>

      <DocSection title="Limits" kicker="Operations">
        <DocCode data={FASTSTORE_LIMITS} />
      </DocSection>
    </div>
  );
}

function QueueDoc() {
  return (
    <div className="space-y-4">
      <DocSection title="SynapseQueue" kicker="Messaging · port 4007 · /v1/queue">
        <Text>
          At-least-once queues with delayed and deduplicated publishing, visibility-timeout
          leases, explicit ack/nack/heartbeat, retries, dead letters and replay. Redis is the
          production backend; the in-memory fallback is for local development and tests.
        </Text>
        <Bullets
          items={[
            'publish → ready or delayed → consume creates a lease and increments attempts.',
            'ack deletes the message; nack requeues it or moves it to the dead-letter set.',
            'Expired leases are reclaimed to pending regardless of attempts, so consumers must be idempotent.',
            'Queues are tenant-scoped; platform callers pass x-synapsedx-tenant or ?tenant=.',
          ]}
        />
      </DocSection>

      <DocSection title="Publish, consume and ack" kicker="Quick start">
        <DocCode data={QUEUE_QUICKSTART} />
      </DocSection>

      <DocSection title="Queues" kicker="API reference">
        <EndpointTable rows={QUEUE_CONFIG_ENDPOINTS} />
      </DocSection>

      <DocSection title="Messages and leases" kicker="API reference">
        <EndpointTable rows={QUEUE_MESSAGE_ENDPOINTS} />
        <DocCode data={QUEUE_RETRY} />
      </DocSection>

      <DocSection title="Inspection and dead letters" kicker="API reference">
        <EndpointTable rows={QUEUE_INSPECT_ENDPOINTS} />
      </DocSection>

      <DocSection title="Delivery semantics and limits" kicker="Operations">
        <DocCode data={QUEUE_SEMANTICS} />
        <Text>
          Nack returns <code className="text-main-text">{'{state:"retry"|"dead", attempts, availableAt|deadAt}'}</code>.
          Replay moves a dead letter back to ready (or delayed) and optionally resets attempts.
          Purge is destructive: it also clears in-flight and dead messages, while preserving the queue config.
        </Text>
      </DocSection>
    </div>
  );
}

function SdkDoc({ sections }) {
  return (
    <div className="space-y-4">
      {sections.map((s) => (
        <Card key={s.title}>
          <h3 className="font-semibold text-main-text mb-2">{s.title}</h3>
          <DocCode data={s.code} limit={4000} />
        </Card>
      ))}
    </div>
  );
}

export default function Docs() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = TABS.some((t) => t.id === requested) ? requested : 'overview';
  const setTab = (id) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', id);
      return next;
    }, { replace: true });
  };

  let content;
  if (tab === 'overview') content = <Overview setTab={setTab} />;
  else if (tab === 'base') content = <BaseDoc />;
  else if (tab === 'faststore') content = <FaststoreDoc />;
  else if (tab === 'queue') content = <QueueDoc />;
  else if (tab === 'javascript') content = <SdkDoc sections={JS_SECTIONS} />;
  else if (tab === 'python') content = <SdkDoc sections={PYTHON_SECTIONS} />;
  else if (tab === 'go') content = <SdkDoc sections={GO_SECTIONS} />;
  else content = <SdkDoc sections={CLI_SECTIONS} />;

  return (
    <>
      <PageTitle
        title="Docs"
        sub="Platform, data services, SDKs and CLI — organized for the running Docker stack"
        right={
          <Link
            to="/api-docs"
            className="px-4 py-2 rounded-2xl text-sm font-medium bg-white text-main-blue shadow-sm hover:bg-background"
          >
            API explorer →
          </Link>
        }
      />
      <div className="flex gap-2 mb-4 flex-wrap" role="tablist" aria-label="Documentation sections">
        {TABS.map((t) => (
          <TabButton key={t.id} tab={t.id} active={tab === t.id} onClick={setTab}>
            {t.label}
          </TabButton>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
        {content}
      </div>
    </>
  );
}
