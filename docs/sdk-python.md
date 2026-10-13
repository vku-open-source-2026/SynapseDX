# `synapsedx-sdk` — SynapseDX SDK for Python

Apache-2.0. Part of [SynapseDX](../README.md) Tier-1 PaaS.

Requires Python 3.10+. Single runtime dependency: `requests>=2.28`.

## Install

```bash
pip install synapsedx-sdk
```

Or with a virtual environment:

```bash
python -m venv .venv
source .venv/bin/activate
pip install synapsedx-sdk
```

For development (from the monorepo):

```bash
cd sdks/sdk-python
pip install -e .
```

## Quick start

```python
from synapsedx_sdk import SynapseDXClient

c = SynapseDXClient("http://localhost:8080")

# Login (dev login or seed)
login = c.login("demo@acme.local")
c.set_token(login["accessToken"])

# Create org, authorize user, deploy workflow
c.create_org("acme-2", "ACME 2")
c.authorize(login["user"]["id"], "workflow:Execute", "*")
c.create_workflow_from_template("webhook-to-log", "demo")
```

## Constructor

```python
SynapseDXClient(base_url, token=None, api_key=None, timeout=15)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `base_url` | `str` | — | Gateway URL, e.g. `http://localhost:8080` |
| `token` | `str \| None` | `None` | Bearer JWT (from login or service account) |
| `api_key` | `str \| None` | `None` | API key sent as `X-API-Key` header |
| `timeout` | `int` | `15` | Per-request timeout in seconds |

### Auth methods

```python
c.set_token(token)    # set/replace Bearer token
c.set_api_key(key)   # set/replace API key
```

Both can also be set via constructor arguments. When both are present, both headers are sent.

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
Mints a short-lived JWT for a service account. `scopes` defaults to `["*"]`.

```python
result = c.service_account_token(sa_id, ["workflow:Execute"])
token = result["accessToken"]
```

### Workflows

#### `list_workflows()`
```python
def list_workflows(self) -> list
```
Lists all workflows.

#### `get_workflow(wf_id)`
```python
def get_workflow(self, wf_id: str) -> dict
```
Gets a single workflow by ID.

#### `create_workflow_from_template(template, name=None)`
```python
def create_workflow_from_template(self, template: str, name: str | None = None) -> dict
```
Instantiates a built-in template on the engine.

```python
c.create_workflow_from_template("webhook-to-log", "my-webhook")
```

#### `create_workflow(name, definition)`
```python
def create_workflow(self, name: str, definition: dict) -> dict
```
Creates a workflow from a raw n8n definition.

```python
c.create_workflow("my-wf", n8n_definition)
```

#### `activate_workflow(wf_id)`
```python
def activate_workflow(self, wf_id: str) -> dict
```
Activates a workflow.

#### `deactivate_workflow(wf_id)`
```python
def deactivate_workflow(self, wf_id: str) -> dict
```
Deactivates a workflow.

#### `execute_workflow(wf_id, payload=None)`
```python
def execute_workflow(self, wf_id: str, payload: dict | None = None) -> dict
```
Triggers a manual execution (proxied to the engine).

```python
c.execute_workflow(wf_id, {"url": "https://example.com/hook"})
```

### Templates

#### `list_templates()`
```python
def list_templates(self) -> list
```
Lists all built-in workflow templates.

#### `get_template(name)`
```python
def get_template(self, name: str) -> dict
```
Fetches a single built-in template definition by name.

```python
tpl = c.get_template("webhook-to-log")
```

### Executions

#### `list_executions(query="")`
```python
def list_executions(self, query: str = "") -> list
```
Proxies the engine execution list. `query` is an optional query string like `"limit=20"`.

```python
recent = c.list_executions("limit=10")
```

#### `get_execution(exec_id)`
```python
def get_execution(self, exec_id: str) -> dict
```
Gets a single execution by ID.

## Error handling

All methods raise `SynapseDXError` on failure (network or HTTP errors):

```python
from synapsedx_sdk import SynapseDXClient, SynapseDXError

try:
    c.authorize(user_id, "workflow:Execute", "*")
except SynapseDXError as e:
    print(f"Error: {e}")
```

The error message includes the HTTP status and path, e.g. `"synapsedx 403 /v1/authorize: ..."`.

## Full example

```python
from synapsedx_sdk import SynapseDXClient

def main():
    c = SynapseDXClient("http://localhost:8080")

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
