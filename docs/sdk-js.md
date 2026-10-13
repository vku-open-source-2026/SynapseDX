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
const { accessToken, user } = await c.login('demo@acme.local');
c.setToken(accessToken);

// Create org, authorize user, deploy workflow
await c.createOrg('acme-2', 'ACME 2');
await c.authorize(user.id, 'workflow:Execute', '*');
await c.createWorkflowFromTemplate('webhook-to-log', 'demo');
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
| `timeoutMs` | `number` | `15000` | Per-request timeout in milliseconds |

### Auth methods

```ts
c.setToken(jwt)    // set/replace Bearer token
c.setApiKey(key)   // set/replace API key
```

Both can also be set via constructor options. When both are present, both headers are sent.

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
Mints a short-lived JWT for a service account. `scopes` defaults to `['*']`.

```ts
const { accessToken } = await c.serviceAccountToken(saId, ['workflow:Execute']);
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
Creates a workflow from a raw n8n definition.

```ts
await c.createWorkflow('my-wf', n8nDefinition);
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

#### `listExecutions(query?)`
```ts
listExecutions(query?: string): Promise<any>
```
Proxies the engine execution list. `query` is an optional query string like `'limit=20'`.

```ts
const recent = await c.listExecutions('limit=10');
```

#### `getExecution(id)`
```ts
getExecution(id: string): Promise<any>
```
Gets a single execution by ID.

## Error handling

All methods throw `Error` on failure. The error message includes the HTTP status and path:

```ts
try {
  await c.authorize(userId, 'workflow:Execute', '*');
} catch (e) {
  console.error(e.message); // e.g. "synapsedx 403 /v1: ..."
}
```

Network errors are also thrown as `Error` with a descriptive message.

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
