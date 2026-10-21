# `@synapsedx/sdk` — SynapseDX SDK for JavaScript/TypeScript

Apache-2.0. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

Zero runtime dependencies. Works in Node 18+ and browsers (fetch-based).

## Install

```bash
npm install @synapsedx/sdk
```

## Quick start

```ts
import { SynapseDXClient } from '@synapsedx/sdk';

const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });
const { accessToken, user } = await c.iam.login('demo@acme.local');
c.setToken(accessToken);

await c.iam.createOrg('acme-2', 'ACME 2');
await c.iam.authorize(user.id, 'workflow:Execute', '*');
await c.workflow.createWorkflowFromTemplate('webhook-to-log', 'demo');
```

Auth: `setToken(jwt)` (Bearer) or `setApiKey(key)` (`X-API-Key`).
Optional `timeoutMs` (default 15000) and `tenant` (platform callers of
Faststore/Queue, sent as `x-synapsedx-tenant`; change with `setTenant()`).

## Services

The SDK is split per service, with matching subpath exports:

| Namespace | Service | Subpath |
| --- | --- | --- |
| `c.iam` | Synapse IAM | `@synapsedx/sdk/iam` |
| `c.workflow` | Workflow | `@synapsedx/sdk/workflow` |
| `c.lds` | SynapseLDS | `@synapsedx/sdk/lds` |
| `c.base` | SynapseBase | `@synapsedx/sdk/base` |
| `c.faststore` | Synapse Faststore | `@synapsedx/sdk/faststore` |
| `c.queue` | SynapseQueue | `@synapsedx/sdk/queue` |

```ts
await c.base.createCollection({ name: 'parks', mapping: { name: 'profile.name' } });
await c.base.createDocument('parks', { id: 'park-1', object: { name: 'Central' } });

await c.faststore.set('cache:park:1', { name: 'Central' }, { ttlSeconds: 300 });
const lock = await c.faststore.lockAcquire('report', { ttlSeconds: 60 });
if (lock.acquired) await c.faststore.lockRelease('report', lock.token);

await c.queue.publish('emails', { to: 'alice@acme.test' }, { dedupeKey: 'welcome:alice' });
const batch = await c.queue.consume('emails', { maxMessages: 10 });
for (const msg of batch.messages) await c.queue.ack('emails', msg.receipt);
```

Legacy flat methods (`c.login(...)`, `c.listTemplates(...)`, ...) still work but
emit a `DeprecationWarning` pointing at the namespaced replacement.

## Full documentation

See **[docs/sdk-js.md](../../docs/sdk-js.md)** for the complete API reference —
constructor, auth, all methods with signatures, parameters, return types, and examples.
