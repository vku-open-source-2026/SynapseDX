# `@synapsedx/sdk` — SynapseDX SDK for JavaScript/TypeScript

Apache-2.0. Part of [SynapseDX](../README.md) Tier-1 PaaS.

Zero runtime dependencies. Works in Node 18+ and browsers (fetch-based).

## Install

```bash
npm install @synapsedx/sdk
```

Or with yarn / pnpm:

```bash
yarn add @synapsedx/sdk
pnpm add @synapsedx/sdk
```

## Quick start

```ts
import { SynapseDXClient } from '@synapsedx/sdk';

const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });

// Login (dev login or seed)
const { accessToken, user } = await c.iam.login('demo@acme.local');
c.setToken(accessToken);

// Create org, authorize user, deploy workflow
await c.iam.createOrg('acme-2', 'ACME 2');
await c.iam.authorize(user.id, 'workflow:Execute', '*');
await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
```

## Constructor

```ts
new SynapseDXClient(opts: SynapseDXClientOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | — | Gateway URL, e.g. `http://localhost:8080` |
| `token` | `string` | — | Bearer JWT (from login or service account) |
| `apiKey` | `string` | — | API key sent as `X-API-Key` header |
| `tenant` | `string` | — | `x-synapsedx-tenant`; platform callers only (Faststore/Queue) |
| `timeoutMs` | `number` | `15000` | Per-request timeout in milliseconds |

### Auth methods

```ts
c.setToken(jwt)            // set/replace Bearer token
c.setApiKey(key)           // set/replace API key
c.setTenant('acme')        // set/replace x-synapsedx-tenant (undefined clears)
```

Both credentials can also be set via constructor options. When both are present,
both headers are sent. `tenant` is ignored for principal callers — the service
always uses their verified org/account/user scope.

## Service namespaces

The SDK is split per service and also ships subpath entry points. `SynapseDXClient`
shares one `HttpClient` across:

| Namespace | Service | Subpath import |
|---|---|---|
| `c.iam` | IAM | `@synapsedx/sdk/iam` |
| `c.workflow` | Workflow engine | `@synapsedx/sdk/workflow` |
| `c.lds` | SynapseLDS | `@synapsedx/sdk/lds` |
| `c.base` | SynapseBase | `@synapsedx/sdk/base` |
| `c.faststore` | Synapse Faststore | `@synapsedx/sdk/faststore` |
| `c.queue` | SynapseQueue | `@synapsedx/sdk/queue` |

```ts
import { SynapseDXClient } from '@synapsedx/sdk';
import { BaseService } from '@synapsedx/sdk/base';
import { QueueService } from '@synapsedx/sdk/queue';
```

The legacy flat methods (`c.login(...)`, `c.listTemplates(...)`,
`c.ldsLicenses(...)`, ...) still work but emit a `DeprecationWarning` through
`process.emitWarning` (or `console.warn` in browsers) and forward to the
namespaced call. The LDS namespace **drops the `lds` prefix**:
`c.ldsLicenses()` → `c.lds.licenses()`.

The API reference below documents the legacy flat surface (kept for existing
code); new code should use the namespace equivalents. The new services are
documented below in their own sections.

## API reference

### Auth

#### `login(email, orgSlug?)`
```ts
login(email: string, orgSlug?: string): Promise<{ accessToken: string; refreshToken: string; user: any }>
```
Authenticates via dev login. `orgSlug` defaults to `'acme'`.

```ts
const { accessToken, refreshToken, user } = await c.login('demo@acme.local', 'acme');
```

#### `refresh(refreshToken)`
```ts
refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>
```
Rotates a refresh token (atomic server-side; old token is revoked).

#### `logout(refreshToken)`
```ts
logout(refreshToken: string): Promise<any>
```
Revokes a single refresh token.

#### `logoutAll(refreshToken)`
```ts
logoutAll(refreshToken: string): Promise<{ ok: boolean; revoked: number }>
```
Revokes every session of the token owner.

#### `verify()`
```ts
verify(): Promise<any>
```
Checks the current Bearer token or API key without fetching the user.

#### `me()`
```ts
me(): Promise<any>
```
Returns the user record behind the current Bearer token.

### Organizations

#### `listOrgs()`
```ts
listOrgs(): Promise<any[]>
```
Lists all organizations.

#### `createOrg(slug, displayName)`
```ts
createOrg(slug: string, displayName: string): Promise<any>
```
Creates an organization.

```ts
await c.createOrg('acme-2', 'ACME 2');
```

### Accounts

#### `listAccounts(orgId)`
```ts
listAccounts(orgId: string): Promise<any[]>
```
Lists accounts in an organization.

#### `createAccount(orgId, slug, displayName)`
```ts
createAccount(orgId: string, slug: string, displayName: string): Promise<any>
```
Creates an account under an organization.

```ts
await c.createAccount(orgId, 'prod', 'Production');
```

### Users

#### `listUsers(orgId)`
```ts
listUsers(orgId: string): Promise<any[]>
```
Lists users in an organization.

#### `createUser(orgId, email, displayName?)`
```ts
createUser(orgId: string, email: string, displayName?: string): Promise<any>
```
Creates or updates a user in an organization.

```ts
await c.createUser(orgId, 'alice@acme.local', 'Alice');
```

#### `userPolicies(userId)`
```ts
userPolicies(userId: string): Promise<any[]>
```
Returns the effective policy documents of a user (debug helper for authorize).

### Roles

#### `createRole(accountId, slug, description?)`
```ts
createRole(accountId: string, slug: string, description?: string): Promise<any>
```
Creates a role in an account.

```ts
await c.createRole(accountId, 'etl-runner', 'Runs ETL workflows');
```

#### `listRoles(accountId)`
```ts
listRoles(accountId: string): Promise<any[]>
```
Lists roles in an account.

#### `deleteRole(roleId)`
```ts
deleteRole(roleId: string): Promise<any>
```
Deletes a role.

### Policies

#### `createPolicy(accountId, slug, document, description?)`
```ts
createPolicy(accountId: string, slug: string, document: any, description?: string): Promise<any>
```
Creates an IAM policy. `document` is a JSON policy document.

```ts
const doc = {
  Version: '2012-17-10',
  Statement: [{
    Effect: 'Allow',
    Action: ['workflow:Execute'],
    Resource: ['*'],
  }],
};
await c.createPolicy(accountId, 'wf-exec', doc, 'Allow workflow execution');
```

#### `listPolicies(accountId)`
```ts
listPolicies(accountId: string): Promise<any[]>
```
Lists policies in an account.

#### `deletePolicy(policyId)`
```ts
deletePolicy(policyId: string): Promise<any>
```
Deletes a policy.

### Role-policy attachment

#### `attachPolicy(roleId, policyId)`
```ts
attachPolicy(roleId: string, policyId: string): Promise<any>
```
Attaches a policy to a role.

```ts
await c.attachPolicy(roleId, policyId);
```

#### `assignRole(userId, roleId)`
```ts
assignRole(userId: string, roleId: string): Promise<any>
```
Assigns a role to a user.

```ts
await c.assignRole(userId, roleId);
```

### Authorization

#### `authorize(userId, action, resource, context?)`
```ts
authorize(userId: string, action: string, resource: string, context?: Record<string, unknown>): Promise<{ allowed: boolean }>
```
Checks whether a user is authorized to perform an action on a resource.

```ts
const { allowed } = await c.authorize(userId, 'workflow:Execute', '*', { team: 'etl' });
```

#### `simulate(documents, action, resource, context?)`
```ts
simulate(documents: any[], action: string, resource: string, context?: Record<string, unknown>): Promise<{ allowed: boolean }>
```
Dry-runs policy documents without a user (like AWS IAM Policy Simulator).

```ts
const { allowed } = await c.simulate([policyDoc], 'workflow:Execute', '*');
```

### Audit

#### `listAudit(limit?, actor?)`
```ts
listAudit(limit?: number, actor?: string): Promise<any[]>
```
Reads the audit log. `limit` defaults to 50.

```ts
const entries = await c.listAudit(20, userId);
```

### API keys

#### `createApiKey(accountId, name?, scopes?)`
```ts
createApiKey(accountId: string, name?: string, scopes?: string[]): Promise<{ apiKey: string }>
```
Creates an API key. `name` defaults to `'default'`, `scopes` defaults to `['*']`.

```ts
const { apiKey } = await c.createApiKey(accountId, 'ci-deploy', ['workflow:Execute']);
```

#### `revokeApiKey(keyId)`
```ts
revokeApiKey(keyId: string): Promise<any>
```

#### `listApiKeys(accountId)`
```ts
listApiKeys(accountId: string): Promise<any>
```
Lists key metadata (id/prefix only — never secret values).

Revokes an API key.

#### `verifyApiKey(apiKey)`
```ts
verifyApiKey(apiKey: string): Promise<any>
```
Checks a raw API key via the internal verify endpoint.

### Service accounts

#### `createServiceAccount(accountId, slug, description?)`
```ts
createServiceAccount(accountId: string, slug: string, description?: string): Promise<any>
```
Creates a service account.

```ts
await c.createServiceAccount(accountId, 'etl-bot', 'ETL service account');
```

#### `listServiceAccounts(accountId)`
```ts
listServiceAccounts(accountId: string): Promise<any[]>
```
Lists service accounts in an account.

#### `serviceAccountToken(saId, scopes?)`
```ts
serviceAccountToken(saId: string, scopes?: string[]): Promise<{ accessToken: string }>
```
Mints a short-lived JWT for a service account. When `scopes` is omitted the
server delegates the caller's own scopes (it never widens to `['*']`). Pass an
explicit list to narrow the minted token; it must be a subset of the caller's
scopes unless the caller holds `*`.

```ts
const { accessToken } = await c.serviceAccountToken(saId, ['workflow:Execute']);
```

### Credentials (PROPOSED — backend in progress)

Account-scoped secrets for workflow nodes (webhook auth, DB passwords, OAuth
tokens...). Secrets are encrypted at rest and **never returned**: `create`/`rotate`
accept a `secret` once; `list`/`get` return metadata only —
`{id, name, type, accountId, expiresAt, version}`.
`type` is one of `bearer`|`basic`|`apiKey`|`oauth2`.

```ts
// Copy-paste: store a bearer token, then list metadata (no secrets leak).
const cred = await c.createCredential(accountId, {
  name: 'stripe-live',
  type: 'bearer',
  secret: process.env.STRIPE_TOKEN!,
  expiresAt: '2027-01-01T00:00:00Z',
});
console.log(cred.id, cred.version); // secret is NOT in the response
const all = await c.listCredentials(accountId);
const one = await c.getCredential(cred.id);
const rotated = await c.rotateCredential(cred.id, process.env.STRIPE_TOKEN_V2!);
await c.deleteCredential(cred.id);
```

#### `createCredential(accountId, opts)`
```ts
createCredential(accountId: string, opts: { name: string; type: string; secret: string; expiresAt?: string }): Promise<any>
```

#### `listCredentials(accountId)`
```ts
listCredentials(accountId: string): Promise<any>
```
Lists credential metadata (never secret values).

#### `getCredential(id)` / `deleteCredential(id)` / `rotateCredential(id, secret)`
```ts
getCredential(id: string): Promise<any>
deleteCredential(id: string): Promise<any>
rotateCredential(id: string, secret: string): Promise<any>
```
`rotate` replaces the secret and bumps `version` (the old secret stops working).

### Generic call (escape hatch)

```ts
call(method: string, path: string, body?: unknown): Promise<any>
```
Calls any gateway endpoint directly — forward-compat with endpoints added after
this SDK (e.g. the proposed credentials API). Same auth + `status+path+body` errors.

```ts
const creds = await c.call('GET', `/v1/accounts/${accountId}/credentials`);
```

### Workflows

#### `listWorkflows()`
```ts
listWorkflows(): Promise<any[]>
```
Lists all workflows.

#### `getWorkflow(id)`
```ts
getWorkflow(id: string): Promise<any>
```
Gets a single workflow by ID.

#### `createWorkflowFromTemplate(template, name?)`
```ts
createWorkflowFromTemplate(template: string, name?: string): Promise<any>
```
Instantiates a built-in template on the engine.

```ts
await c.createWorkflowFromTemplate('webhook-to-log', 'my-webhook');
```

#### `createWorkflow(name, definition)`
```ts
createWorkflow(name: string, definition: any): Promise<any>
```
Creates a workflow from a raw workflow definition.

```ts
await c.createWorkflow('my-wf', definition);
```

#### `activateWorkflow(id)`
```ts
activateWorkflow(id: string): Promise<any>
```
Activates a workflow.

#### `deactivateWorkflow(id)`
```ts
deactivateWorkflow(id: string): Promise<any>
```
Deactivates a workflow.

#### `executeWorkflow(id, payload?)`
```ts
executeWorkflow(id: string, payload?: Record<string, unknown>): Promise<any>
```
Triggers a manual execution (proxied to the engine).

```ts
await c.executeWorkflow(wfId, { url: 'https://example.com/hook' });
```

#### `updateWorkflow(id, patch)`
```ts
updateWorkflow(id: string, patch: { name?: string; definition?: any }): Promise<any>
```
Updates a workflow's name and/or definition.

```ts
await c.updateWorkflow(wfId, { name: 'renamed' });
```

#### `testRun(definition, input?)`
```ts
testRun(definition: any, input?: Record<string, unknown>): Promise<any>
```
Tries a definition without saving (`POST /v1/workflows/test-run {definition, input}`).
Powers the editor's "try before Save". Returns `{ok, output, nodeRuns, executionId}`.

```ts
// Copy-paste: validate a code-transform definition before saving it.
const definition = {
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'transform', httpMethod: 'POST' } },
    { name: 'Transform', type: 'n8n-nodes-base.code', parameters: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2 };' } },
  ],
  connections: { Webhook: { main: [[{ node: 'Transform', type: 'main', index: 0 }]] } },
};
const r = await c.testRun(definition, { value: 21 });
console.log(r.ok, r.output); // true { value: 21, doubled: 42 }
```

#### `deleteWorkflow(id)`
```ts
deleteWorkflow(id: string): Promise<any>
```
Deletes a workflow on the engine.

```ts
await c.deleteWorkflow(wfId);
```

### Templates

#### `listTemplates()`
```ts
listTemplates(): Promise<any[]>
```
Lists all built-in workflow templates.

#### `getTemplate(name)`
```ts
getTemplate(name: string): Promise<any>
```
Fetches a single built-in template definition by name.

```ts
const tpl = await c.getTemplate('webhook-to-log');
```

### Executions

> The engine always returns the envelope `{data: [...]}` for `GET /v1/executions`
> (forward-compat with the old n8n proxy). `listExecutions()` unwraps it for you —
> you always get a plain array, and a bare array response is accepted too
> (see `unwrapExecutions()`).

#### `listExecutions(query?)`
```ts
listExecutions(query?: string | { limit?: number; offset?: number; workflowId?: string; status?: string; includeData?: boolean }): Promise<any[]>
```
Lists executions. Allowed query keys (server allowlist):
`limit`, `offset`, `workflowId`, `status` (`success`|`error`|`running`), `includeData`.
`limit`/`offset` are `0..9999` (`offset=0` = first page).

```ts
const recent = await c.listExecutions('limit=10');
const failed = await c.listExecutions({ workflowId: wfId, status: 'error', limit: 20 });
const withIO = await c.listExecutions({ limit: 5, includeData: true }); // per-node I/O
```

#### `getExecution(id, includeData?)`
```ts
getExecution(id: string, includeData?: boolean): Promise<any>
```
Gets a single execution by ID. Pass `includeData=true` for per-node input/output.

```ts
const exec = await c.getExecution(execId, true);
```

#### `unwrapExecutions(payload)`
```ts
unwrapExecutions(payload: any): any[]
```
Normalizes a raw `GET /v1/executions` payload (envelope `{data: []}` or bare
array) to an array. `listExecutions()` already applies it — use it when you
`fetch()` the endpoint yourself.

### Linked Data (SynapseLDS)

```ts
const licenses = await c.ldsLicenses();
const ds = await c.ldsCreateDatasource({ name: 'Business Registry', entityType: 'Organization', license: 'CC-BY-4.0' });
await c.ldsSetAttributes(ds.id, [
  { name: 'name', ngsiLdType: 'Property', visibility: 'public' },
  { name: 'taxCode', visibility: 'restricted' },
]);
const res = await c.ldsIngest(ds.id, { id: '55001', name: 'ACME' });  // object or array
const entities = await c.ldsEntities(ds.id, { limit: 50 });           // NGSI-LD JSON-LD
await c.ldsDatasource(ds.id);
await c.ldsStats(ds.id);
await c.ldsEntity(ds.id, entities[0].id);
await c.ldsUpdateDatasource(ds.id, { license: 'ODbL-1.0' });
await c.ldsDeleteDatasource(ds.id);
```

`_core` metadata is never serialized; attributes without a registry entry (or
not visible to the caller) are omitted from `ldsEntities`. The **public export
surface is anonymous**: `GET /v1/lds/licenses` and
`GET /v1/lds/datasources/:id/entities[/:entityId]` need no token (anyone can
consume the public projection, license surfacing included). A set token is
honoured as optional auth there — same-org callers may request
`{ visibility: 'restricted' }`; other-tenant callers only get `404`.
Management calls above still require a session or API key.

### SynapseBase (`c.base`)

Collections of JSON documents with a logical object↔data mapping, queries,
optimistic concurrency, counters, batches and a change feed. Full guide:
[synapsebase.md](synapsebase.md).

```ts
type Park = { name: string; capacity?: number };

await c.base.createCollection({
  name: 'parks',
  mapping: {
    name: { path: 'profile.name', type: 'string', required: true },
    capacity: { path: 'profile.capacity', type: 'number' },
  },
});
await c.base.createDocument('parks', { id: 'park-1', object: { name: 'Central', capacity: 120 } });
const doc = await c.base.getDocument<Park>('parks', 'park-1', 'object');
const page = await c.base.queryDocuments<Park>('parks', {
  where: { capacity: { gte: 100 } },
  orderBy: [{ field: 'name', direction: 'asc' }],
  as: 'object',
});
console.log(page.total, page.nextCursor);

// Typed collection
const parks = c.base.collection<Park>('parks', {
  mapping: { name: 'profile.name', capacity: 'profile.capacity' },
});
await parks.create({ name: 'Riverside', capacity: 80 }, { id: 'park-2' });
for (const park of await parks.query({ where: { capacity: { gte: 100 } } }).then((r) => r.items)) {
  console.log(park.name, park.capacity);
}
await parks.increment('park-1', { field: 'profile.capacity', by: 10 });
const feed = await parks.changes({ since: '2026-10-01T00:00:00Z' });
```

Collection methods: `listCollections`, `createCollection`, `getCollection`,
`updateCollection`, `deleteCollection`, `collectionStats`.
Document methods: `createDocument`, `getDocument` (`as: 'data' | 'object'`),
`setDocument`, `updateDocument`, `deleteDocument`, `listDocuments`,
`queryDocuments`, `increment`, `batch`, `changes`.

The typed `BaseCollection` takes `mapping` as `{logical: 'dot.path'}` for the
raw-data endpoints (list/increment/changes) and sends writes as `object`.

### Synapse Faststore (`c.faststore`)

Redis-backed strings, counters, hashes, lists, sets, sorted sets, scans, batches
and distributed locks. Full guide: [faststore.md](faststore.md).

```ts
await c.faststore.set('cache:park:1', { name: 'Central' }, { ttlSeconds: 300, ifNotExists: true });
const entry = await c.faststore.get('cache:park:1');
await c.faststore.incr('visits', { by: 1, ttlSeconds: 60 });

await c.faststore.hashSet('user:1', { name: 'Alice' }, { ttlSeconds: 3600 });
await c.faststore.hashIncr('user:1', 'logins', { by: 1 });
await c.faststore.listPush('jobs', [{ id: 1 }], { side: 'left' });
const popped = await c.faststore.listPop('jobs', { count: 10 });

await c.faststore.setAdd('tags', ['a', 'b']);
await c.faststore.zsetAdd('scores', [{ member: 'alice', score: 10 }]);
const top = await c.faststore.zsetRange('scores', { rev: true, withScores: true });

const lock = await c.faststore.lockAcquire('report', { ttlSeconds: 60, waitMs: 500 });
if (lock.acquired) await c.faststore.lockRelease('report', lock.token);

await c.faststore.batch([
  { op: 'set', key: 'a', value: 1, ttlSeconds: 60 },
  { op: 'incr', key: 'a', by: 2 },
  { op: 'get', key: 'a' },
]);
```

Method families: `get/set/delete/ttl/expire/incr/batch`, `hash*`, `list*`,
`set*`, `zset*`, `lockAcquire/lockRelease/lockExtend`, `stats`, `listKeys`,
`exists` (returns `false` on `404`).

### SynapseQueue (`c.queue`)

At-least-once queues with delays, deduplication, visibility-timeout leases,
ack/nack/heartbeat, retries, dead letters and replay. Full guide:
[queue.md](queue.md).

```ts
await c.queue.createQueue('emails', { maxAttempts: 5, visibilityTimeoutSeconds: 60 });
const published = await c.queue.publish(
  'emails',
  { to: 'alice@acme.test' },
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
await c.queue.ackMany('emails', ['receipt-1', 'receipt-2']);

const stats = await c.queue.queueStats('emails');
const dead = await c.queue.deadLetters('emails', { limit: 20 });
await c.queue.replayDead('emails', dead.messages[0].id, { resetAttempts: true });
```

Also: `listQueues`, `getQueue`, `deleteQueue`, `purgeQueue`,
`peek({ limit, ready })` and `deleteDead`.

### Webhooks (public, no auth)

`ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares
that `path`. The gateway does **not** proxy `/webhook/*` — call the
workflow-service origin directly (e.g. `http://localhost:4002`).

```ts
import { triggerWebhook } from '@synapsedx/sdk';

// Copy-paste: fire the code-transform template's webhook after activating it.
const out = await triggerWebhook('http://localhost:4002', 'transform', { value: 21 });
console.log(out.output);
```

Raw curl equivalent:

```bash
curl -X POST http://localhost:4002/webhook/transform \
  -H 'Content-Type: application/json' \
  -d '{"value":21}'
```

## Error handling

All methods throw `SynapseDXError` on failure (a subclass of `Error`). The
message includes the HTTP status and path, and the class exposes the parsed
response:

```ts
import { SynapseDXError } from '@synapsedx/sdk';

try {
  await c.iam.authorize(userId, 'workflow:Execute', '*');
} catch (e) {
  if (e instanceof SynapseDXError) {
    console.error(e.message); // e.g. "synapsedx 403 /v1/authorize: ..."
    console.error(e.status, e.body);
  }
}
```

Network errors are also `SynapseDXError`, with `status` undefined and a
descriptive message.

## Full example

```ts
import { SynapseDXClient } from '@synapsedx/sdk';

async function main() {
  const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });

  // 1. Login
  const { accessToken, user } = await c.login('demo@acme.local');
  c.setToken(accessToken);

  // 2. Create org + account
  const org = await c.createOrg('acme', 'ACME Corp');
  const account = await c.createAccount(org.id, 'prod', 'Production');

  // 3. Create role + policy
  const role = await c.createRole(account.id, 'wf-runner', 'Workflow runner');
  const policy = await c.createPolicy(account.id, 'wf-exec', {
    Version: '2012-17-10',
    Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: ['*'] }],
  });
  await c.attachPolicy(role.id, policy.id);
  await c.assignRole(user.id, role.id);

  // 4. Deploy + execute workflow
  const wf = await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
  await c.activateWorkflow(wf.id);
  const exec = await c.executeWorkflow(wf.id, { url: 'https://example.com' });

  console.log('Execution:', exec.id);
}

main().catch(console.error);
```
