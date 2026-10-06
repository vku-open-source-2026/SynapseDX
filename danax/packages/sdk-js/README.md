# `@olp/sdk` — OLP SDK for JavaScript/TypeScript

Apache-2.0. Part of [OLP](../../README.md) Tier-1 PaaS.

```bash
npm install @olp/sdk
```

```ts
import { OlpClient } from '@olp/sdk';

const c = new OlpClient({ baseUrl: 'http://localhost:8080' });
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);

await c.createOrg('acme-2', 'ACME 2');
await c.authorize(user.id, 'workflow:Execute', '*');
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
```

Auth: `setToken(jwt)` (Bearer) hoặc `setApiKey(key)` (`X-API-Key`).
Xem thêm `src/example.ts` và [docs/api.md](../../docs/api.md).
