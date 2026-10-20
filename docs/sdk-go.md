# `synapsedx-sdk-go` — SynapseDX SDK for Go

Apache-2.0. Part of [SynapseDX](../README.md) Tier-1 PaaS.

Zero external dependencies (standard library only). Requires Go >= 1.22.

## Install

### From the monorepo (replace directive)

```bash
go mod edit -replace github.com/synapsedx/synapsedx-sdk-go=./sdks/sdk-go
go mod tidy
```

### As a published module

```bash
go get github.com/synapsedx/synapsedx-sdk-go@latest
```

### Forks

Change the `github.com/synapsedx/synapsedx-sdk-go` module path in `go.mod` to your repo (Go resolves packages via git tags, no separate registry publish needed).

## Quick start

```go
package main

import (
    "fmt"
    synapsedx "github.com/synapsedx/synapsedx-sdk-go"
)

func main() {
    c := synapsedx.New("http://localhost:8080")

    // Login (dev login or seed)
    out, err := c.Login("demo@acme.local", "acme")
    if err != nil {
        panic(err)
    }
    c.SetToken(out["accessToken"].(string))

    // List orgs
    orgs, err := c.ListOrgs()
    if err != nil {
        panic(err)
    }
    fmt.Println("Orgs:", orgs)
}
```

## Client construction

### `New(baseURL string) *Client`
Creates a client with a 15-second timeout.

```go
c := synapsedx.New("http://localhost:8080")
```

### `NewWithClient(baseURL string, httpClient *http.Client) *Client`
Allows custom timeout / transport (tests, mTLS, tracing, etc.).

```go
c := synapsedx.NewWithClient("http://localhost:8080", &http.Client{
    Timeout: 30 * time.Second,
})
```

### Auth methods

```go
c.SetToken(jwt)    // set/replace Bearer token
c.SetAPIKey(key)   // set/replace API key
```

Both can be set at any time. When both are present, both headers are sent.

## API reference

### Auth

#### `Login(email, orgSlug string) (map[string]any, error)`
```go
func (c *Client) Login(email, orgSlug string) (map[string]any, error)
```
Authenticates via dev login. `orgSlug` defaults to `"acme"` if empty. Returns a map with `accessToken`, `refreshToken`, and `user`.

```go
out, err := c.Login("demo@acme.local", "acme")
token := out["accessToken"].(string)
```

#### `Refresh(refreshToken string) (map[string]any, error)`
```go
func (c *Client) Refresh(refreshToken string) (map[string]any, error)
```
Rotates a refresh token (atomic server-side; old token is revoked). Returns `accessToken` and `refreshToken`.

#### `Logout(refreshToken string) error`
```go
func (c *Client) Logout(refreshToken string) error
```
Revokes a single refresh token.

#### `LogoutAll(refreshToken string) (map[string]any, error)`
```go
func (c *Client) LogoutAll(refreshToken string) (map[string]any, error)
```
Revokes every session of the token owner.

#### `Verify() (map[string]any, error)`
```go
func (c *Client) Verify() (map[string]any, error)
```
Checks the current Bearer token or API key without fetching the user.

#### `Me() (map[string]any, error)`
```go
func (c *Client) Me() (map[string]any, error)
```
Returns the user record behind the current Bearer token.

### Organizations

#### `ListOrgs() ([]any, error)`
```go
func (c *Client) ListOrgs() ([]any, error)
```
Lists all organizations.

#### `CreateOrg(slug, displayName string) (map[string]any, error)`
```go
func (c *Client) CreateOrg(slug, displayName string) (map[string]any, error)
```
Creates an organization. If `displayName` is empty, it defaults to `slug`.

```go
org, err := c.CreateOrg("acme-2", "ACME 2")
```

### Accounts

#### `ListAccounts(orgID string) ([]any, error)`
```go
func (c *Client) ListAccounts(orgID string) ([]any, error)
```
Lists accounts in an organization.

#### `CreateAccount(orgID, slug, displayName string) (map[string]any, error)`
```go
func (c *Client) CreateAccount(orgID, slug, displayName string) (map[string]any, error)
```
Creates an account under an organization. If `displayName` is empty, it defaults to `slug`.

```go
acct, err := c.CreateAccount(orgID, "prod", "Production")
```

### Users

#### `ListUsers(orgID string) ([]any, error)`
```go
func (c *Client) ListUsers(orgID string) ([]any, error)
```
Lists users in an organization.

#### `CreateUser(orgID, email, displayName string) (map[string]any, error)`
```go
func (c *Client) CreateUser(orgID, email, displayName string) (map[string]any, error)
```
Creates or updates a user in an organization.

```go
user, err := c.CreateUser(orgID, "alice@acme.local", "Alice")
```

#### `UserPolicies(userID string) ([]any, error)`
```go
func (c *Client) UserPolicies(userID string) ([]any, error)
```
Returns the effective policy documents of a user (debug helper for authorize).

### Roles

#### `CreateRole(accountID, slug, description string) (map[string]any, error)`
```go
func (c *Client) CreateRole(accountID, slug, description string) (map[string]any, error)
```
Creates a role in an account.

```go
role, err := c.CreateRole(accountID, "etl-runner", "Runs ETL workflows")
```

#### `ListRoles(accountID string) ([]any, error)`
```go
func (c *Client) ListRoles(accountID string) ([]any, error)
```
Lists roles in an account.

#### `DeleteRole(roleID string) error`
```go
func (c *Client) DeleteRole(roleID string) error
```
Deletes a role.

### Policies

#### `CreatePolicy(accountID, slug string, document any, description string) (map[string]any, error)`
```go
func (c *Client) CreatePolicy(accountID, slug string, document any, description string) (map[string]any, error)
```
Creates an IAM policy. `document` is a JSON policy document (usually `map[string]any`).

```go
doc := map[string]any{
    "Version": "2012-17-10",
    "Statement": []any{
        map[string]any{
            "Effect":   "Allow",
            "Action":   []string{"workflow:Execute"},
            "Resource": []string{"*"},
        },
    },
}
policy, err := c.CreatePolicy(accountID, "wf-exec", doc, "Allow workflow execution")
```

#### `ListPolicies(accountID string) ([]any, error)`
```go
func (c *Client) ListPolicies(accountID string) ([]any, error)
```
Lists policies in an account.

#### `DeletePolicy(policyID string) error`
```go
func (c *Client) DeletePolicy(policyID string) error
```
Deletes a policy.

### Role-policy attachment

#### `AttachPolicy(roleID, policyID string) error`
```go
func (c *Client) AttachPolicy(roleID, policyID string) error
```
Attaches a policy to a role.

```go
err := c.AttachPolicy(roleID, policyID)
```

#### `AssignRole(userID, roleID string) error`
```go
func (c *Client) AssignRole(userID, roleID string) error
```
Assigns a role to a user.

```go
err := c.AssignRole(userID, roleID)
```

### Authorization

#### `Authorize(userID, action, resource string, context map[string]any) (map[string]any, error)`
```go
func (c *Client) Authorize(userID, action, resource string, context map[string]any) (map[string]any, error)
```
Checks whether a user is authorized to perform an action on a resource.

```go
result, err := c.Authorize(userID, "workflow:Execute", "*", map[string]any{"team": "etl"})
allowed := result["allowed"].(bool)
```

#### `Simulate(documents []any, action, resource string, context map[string]any) (map[string]any, error)`
```go
func (c *Client) Simulate(documents []any, action, resource string, context map[string]any) (map[string]any, error)
```
Dry-runs policy documents without a user (like AWS IAM Policy Simulator).

```go
result, err := c.Simulate([]any{policyDoc}, "workflow:Execute", "*", nil)
```

### Audit

#### `ListAudit(limit int, actor string) ([]any, error)`
```go
func (c *Client) ListAudit(limit int, actor string) ([]any, error)
```
Reads the audit log. `limit` defaults to 50 if <= 0. `actor` is optional filter.

```go
entries, err := c.ListAudit(20, userID)
```

### API keys

#### `CreateAPIKey(accountID, name string, scopes []string) (map[string]any, error)`
```go
func (c *Client) CreateAPIKey(accountID, name string, scopes []string) (map[string]any, error)
```
Creates an API key. `name` defaults to `"default"`, `scopes` defaults to `["*"]`.

```go
result, err := c.CreateAPIKey(accountID, "ci-deploy", []string{"workflow:Execute"})
apiKey := result["apiKey"].(string)
```

#### `RevokeAPIKey(keyID string) error`
```go
func (c *Client) RevokeAPIKey(keyID string) error
```
Revokes an API key.

#### `VerifyAPIKey(apiKey string) (map[string]any, error)`
```go
func (c *Client) VerifyAPIKey(apiKey string) (map[string]any, error)
```
Checks a raw API key via the internal verify endpoint.

#### `ListAPIKeys(accountID string) ([]any, error)`
```go
func (c *Client) ListAPIKeys(accountID string) ([]any, error)
```
Lists key metadata (id/prefix only — never secret values).

### Service accounts

#### `CreateServiceAccount(accountID, slug, description string) (map[string]any, error)`
```go
func (c *Client) CreateServiceAccount(accountID, slug, description string) (map[string]any, error)
```
Creates a service account.

```go
sa, err := c.CreateServiceAccount(accountID, "etl-bot", "ETL service account")
```

#### `ListServiceAccounts(accountID string) ([]any, error)`
```go
func (c *Client) ListServiceAccounts(accountID string) ([]any, error)
```
Lists service accounts in an account.

#### `ServiceAccountToken(saID string, scopes []string) (map[string]any, error)`
```go
func (c *Client) ServiceAccountToken(saID string, scopes []string) (map[string]any, error)
```
Mints a short-lived JWT for a service account. A `nil` `scopes` slice delegates
the caller's own scopes (it never widens to `["*"]`). Pass an explicit list to
narrow the minted token; it must be a subset of the caller's scopes unless the
caller holds `*`.

```go
result, err := c.ServiceAccountToken(saID, []string{"workflow:Execute"})
token := result["accessToken"].(string)
```

### Credentials (PROPOSED — backend in progress)

Account-scoped secrets for workflow nodes (webhook auth, DB passwords, OAuth
tokens...). Secrets are encrypted at rest and **never returned**: `Create`/`Rotate`
accept a secret once; `List`/`Get` return metadata only —
`{id, name, type, accountId, expiresAt, version}`.
The type is one of `bearer`|`basic`|`apiKey`|`oauth2`.

```go
// Copy-paste: store a bearer token, then list metadata (no secrets leak).
cred, err := c.CreateCredential(accountID, "stripe-live", "bearer", os.Getenv("STRIPE_TOKEN"), "2027-01-01T00:00:00Z")
fmt.Println(cred["id"], cred["version"]) // secret is NOT in the response
all, err := c.ListCredentials(accountID)
one, err := c.GetCredential(cred["id"].(string))
rotated, err := c.RotateCredential(cred["id"].(string), os.Getenv("STRIPE_TOKEN_V2"))
err = c.DeleteCredential(cred["id"].(string))
```

#### `CreateCredential(accountID, name, credType, secret, expiresAt string) (map[string]any, error)`
```go
func (c *Client) CreateCredential(accountID, name, credType, secret, expiresAt string) (map[string]any, error)
```
`expiresAt` is an ISO timestamp; pass `""` for no expiry.

#### `ListCredentials(accountID string) ([]any, error)`
```go
func (c *Client) ListCredentials(accountID string) ([]any, error)
```
Lists credential metadata (never secret values).

#### `GetCredential(id string) (map[string]any, error)` / `DeleteCredential(id string) error` / `RotateCredential(id, secret string) (map[string]any, error)`
```go
func (c *Client) GetCredential(id string) (map[string]any, error)
func (c *Client) DeleteCredential(id string) error
func (c *Client) RotateCredential(id, secret string) (map[string]any, error)
```
`RotateCredential` replaces the secret and bumps `version` (the old secret stops working).

### Generic Call (escape hatch)

```go
func (c *Client) Call(method, path string, body any) (any, error)
```
Calls any gateway endpoint directly — forward-compat with endpoints added after
this SDK (e.g. the proposed credentials API). Same auth + `status path: body` errors.

```go
creds, err := c.Call("GET", "/v1/accounts/"+accountID+"/credentials", nil)
```

### Workflows

#### `ListWorkflows() (any, error)`
```go
func (c *Client) ListWorkflows() (any, error)
```
Lists all workflows.

#### `GetWorkflow(id string) (map[string]any, error)`
```go
func (c *Client) GetWorkflow(id string) (map[string]any, error)
```
Gets a single workflow by ID.

#### `CreateWorkflowFromTemplate(template, name string) (map[string]any, error)`
```go
func (c *Client) CreateWorkflowFromTemplate(template, name string) (map[string]any, error)
```
Instantiates a built-in template on the engine.

```go
wf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "my-webhook")
```

#### `CreateWorkflowRaw(name string, definition any) (map[string]any, error)`
```go
func (c *Client) CreateWorkflowRaw(name string, definition any) (map[string]any, error)
```
Creates a workflow from a raw workflow definition.

```go
wf, err := c.CreateWorkflowRaw("my-wf", definition)
```

#### `ActivateWorkflow(id string) error`
```go
func (c *Client) ActivateWorkflow(id string) error
```
Activates a workflow.

#### `DeactivateWorkflow(id string) error`
```go
func (c *Client) DeactivateWorkflow(id string) error
```
Deactivates a workflow.

#### `ExecuteWorkflow(id string, payload any) (map[string]any, error)`
```go
func (c *Client) ExecuteWorkflow(id string, payload any) (map[string]any, error)
```
Triggers a manual execution (proxied to the engine). `payload` defaults to empty map if nil.

```go
exec, err := c.ExecuteWorkflow(wfID, map[string]any{"url": "https://example.com/hook"})
```

#### `UpdateWorkflow(id string, patch map[string]any) (map[string]any, error)`
```go
func (c *Client) UpdateWorkflow(id string, patch map[string]any) (map[string]any, error)
```
Updates a workflow's name and/or definition.

```go
updated, err := c.UpdateWorkflow(wfID, map[string]any{"name": "renamed"})
```

#### `DeleteWorkflow(id string) error`
```go
func (c *Client) DeleteWorkflow(id string) error
```
Deletes a workflow on the engine.

```go
err = c.DeleteWorkflow(wfID)
```

#### `TestRun(definition any, input any) (map[string]any, error)`
```go
func (c *Client) TestRun(definition any, input any) (map[string]any, error)
```
Tries a definition without saving (`POST /v1/workflows/test-run {definition, input}`).
Powers the editor's "try before Save". `input` defaults to an empty map if nil.

```go
// Copy-paste: validate a code-transform definition before saving it.
definition := map[string]any{
    "nodes": []any{
        map[string]any{"name": "Webhook", "type": "n8n-nodes-base.webhook",
            "parameters": map[string]any{"path": "transform", "httpMethod": "POST"}},
        map[string]any{"name": "Transform", "type": "n8n-nodes-base.code",
            "parameters": map[string]any{"code": "return { ...$input, doubled: ($input.value ?? 0) * 2 };"}),
    },
    "connections": map[string]any{
        "Webhook": map[string]any{"main": []any{[]any{
            map[string]any{"node": "Transform", "type": "main", "index": 0},
        }}},
    },
}
r, err := c.TestRun(definition, map[string]any{"value": 21})
fmt.Println(r["ok"], r["output"])
```

### Templates

#### `ListTemplates() ([]any, error)`
```go
func (c *Client) ListTemplates() ([]any, error)
```
Lists all built-in workflow templates.

#### `GetTemplate(name string) (map[string]any, error)`
```go
func (c *Client) GetTemplate(name string) (map[string]any, error)
```
Fetches a single built-in template definition by name.

```go
tpl, err := c.GetTemplate("webhook-to-log")
```

### Executions

> The engine always returns the envelope `{data: [...]}` for `GET /v1/executions`
> (forward-compat with the old n8n proxy). `ListExecutions()` /
> `ListExecutionsWithParams()` unwrap it for you — you always get a `[]any`,
> and a bare array response is accepted too (see `UnwrapExecutions()`).

#### `ListExecutions(query string) ([]any, error)`
```go
func (c *Client) ListExecutions(query string) ([]any, error)
```
Lists executions. `query` is an optional raw query string like `"limit=20"`.

```go
recent, err := c.ListExecutions("limit=10")
```

#### `ListExecutionsWithParams(params map[string]string) ([]any, error)`
```go
func (c *Client) ListExecutionsWithParams(params map[string]string) ([]any, error)
```
Lists executions with an allowlisted parameter map. Allowed keys (server
allowlist): `limit`, `offset`, `workflowId`, `status`
(`success`|`error`|`running`), `includeData`. Unknown keys are ignored.
`limit`/`offset` are `0..9999` (`offset=0` = first page).

```go
failed, err := c.ListExecutionsWithParams(map[string]string{
    "workflowId": wfID, "status": "error", "limit": "20",
})
withIO, err := c.ListExecutionsWithParams(map[string]string{
    "limit": "5", "includeData": "true", // per-node I/O
})
```

#### `GetExecution(id string) (map[string]any, error)`
```go
func (c *Client) GetExecution(id string) (map[string]any, error)
```
Gets a single execution by ID.

#### `GetExecutionWithData(id string, includeData bool) (map[string]any, error)`
```go
func (c *Client) GetExecutionWithData(id string, includeData bool) (map[string]any, error)
```
Gets a single execution by ID. Pass `includeData=true` for per-node input/output.

```go
exec, err := c.GetExecutionWithData(execID, true)
```

#### `UnwrapExecutions(b []byte) ([]any, error)`
```go
func UnwrapExecutions(b []byte) ([]any, error)
```
Normalizes a raw `GET /v1/executions` payload (envelope `{data: []}` or bare
array) to a slice. `ListExecutions()` already applies it.

### Linked Data (SynapseLDS)

```go
licenses, _ := c.ListLDSLicenses()
ds, _ := c.CreateLDSDatasource(map[string]any{
    "name": "Business Registry", "entityType": "Organization", "license": "CC-BY-4.0",
})
id := ds["id"].(string)
c.SetLDSAttributes(id, []any{
    map[string]any{"name": "name", "visibility": "public"},
    map[string]any{"name": "taxCode", "visibility": "restricted"},
})
c.IngestLDSRecords(id, map[string]any{"id": "55001", "name": "ACME"}) // map or slice
ents, _ := c.ListLDSEntities(id, map[string]string{"limit": "50"})    // NGSI-LD JSON-LD
one, _ := c.GetLDSEntity(id, "urn:ngsi-ld:Organization:55001")
stats, _ := c.GetLDSStats(id)
c.DeleteLDSDatasource(id)
_ = licenses
_ = one
_ = stats
```

`_core` metadata is never serialized; attributes without a registry entry (or
not visible to the caller) are omitted from entity listings. The public export
surface (`lds licenses`, `lds entities`, `lds entity`) reads anonymously — no
token required for the public projection; a token earns same-tenant
`restricted` reads (other tenants → `404`).

### Webhooks (public, no auth)

`ANY /webhook/:path` triggers the ACTIVE workflow whose webhook node declares
that `path`. The gateway does **not** proxy `/webhook/*` — call the
workflow-service origin directly (e.g. `http://localhost:4002`).

```go
// Copy-paste: fire the code-transform template's webhook after activating it.
out, err := synapsedx.TriggerWebhook("http://localhost:4002", "transform", map[string]any{"value": 21})
fmt.Println(out["output"])
```

Raw curl equivalent:

```bash
curl -X POST http://localhost:4002/webhook/transform \
  -H 'Content-Type: application/json' \
  -d '{"value":21}'
```

## Error handling

All methods return `error` as the second return value. Errors include the HTTP status and path:

```go
result, err := c.Authorize(userID, "workflow:Execute", "*", nil)
if err != nil {
    log.Fatalf("authorize failed: %v", err)
    // e.g. "synapsedx 403 /v1/authorize: ..."
}
```

Network errors are also returned as `error` with a descriptive message.

## Full example

```go
package main

import (
    "fmt"
    "log"

    synapsedx "github.com/synapsedx/synapsedx-sdk-go"
)

func main() {
    c := synapsedx.New("http://localhost:8080")

    // 1. Login
    login, err := c.Login("demo@acme.local", "acme")
    if err != nil {
        log.Fatal(err)
    }
    c.SetToken(login["accessToken"].(string))
    user := login["user"].(map[string]any)

    // 2. Create org + account
    org, err := c.CreateOrg("acme", "ACME Corp")
    if err != nil {
        log.Fatal(err)
    }
    acct, err := c.CreateAccount(org["id"].(string), "prod", "Production")
    if err != nil {
        log.Fatal(err)
    }

    // 3. Create role + policy
    role, err := c.CreateRole(acct["id"].(string), "wf-runner", "Workflow runner")
    if err != nil {
        log.Fatal(err)
    }
    policy, err := c.CreatePolicy(acct["id"].(string), "wf-exec", map[string]any{
        "Version": "2012-17-10",
        "Statement": []any{
            map[string]any{
                "Effect":   "Allow",
                "Action":   []string{"workflow:Execute"},
                "Resource": []string{"*"},
            },
        },
    }, "")
    if err != nil {
        log.Fatal(err)
    }
    if err := c.AttachPolicy(role["id"].(string), policy["id"].(string)); err != nil {
        log.Fatal(err)
    }
    if err := c.AssignRole(user["id"].(string), role["id"].(string)); err != nil {
        log.Fatal(err)
    }

    // 4. Deploy + execute workflow
    wf, err := c.CreateWorkflowFromTemplate("webhook-to-log", "demo")
    if err != nil {
        log.Fatal(err)
    }
    if err := c.ActivateWorkflow(wf["id"].(string)); err != nil {
        log.Fatal(err)
    }
    exec, err := c.ExecuteWorkflow(wf["id"].(string), map[string]any{
        "url": "https://example.com",
    })
    if err != nil {
        log.Fatal(err)
    }

    fmt.Println("Execution:", exec["id"])
}
```
