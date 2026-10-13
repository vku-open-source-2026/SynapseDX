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
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);

await c.createOrg('acme-2', 'ACME 2');
await c.authorize(user.id, 'workflow:Execute', '*');
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
```

Auth: `setToken(jwt)` (Bearer) or `setApiKey(key)` (`X-API-Key`).
Optional `timeoutMs` (default 15000).

## Full documentation

See **[docs/sdk-js.md](../../docs/sdk-js.md)** for the complete API reference —
constructor, auth, all methods with signatures, parameters, return types, and examples.
