# `@synapsedx/sdk` — synapsedx SDK for JavaScript/TypeScript

Apache-2.0. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

```bash
npm install @synapsedx/sdk
```

```ts
import { SynapseDXClient } from '@synapsedx/sdk';

const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080' });
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);

await c.createOrg('acme-2', 'ACME 2');
await c.authorize(user.id, 'workflow:Execute', '*');
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
```

Auth: `setToken(jwt)` (Bearer) hoặc `setApiKey(key)` (`X-API-Key`).
Xem thêm `src/example.ts` và [docs/api.md](../../docs/api.md).
