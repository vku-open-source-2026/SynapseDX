# synapsedx SDK for Python
Apache-2.0. See root LICENSE. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

```bash
pip install synapsedx-sdk
```

```python
from synapsedx_sdk import SynapseDXClient

c = SynapseDXClient("http://localhost:8080")
login = c.login("demo@acme.local")
c.set_token(login["accessToken"])

c.create_org("acme-2", "ACME 2")
c.authorize(login["user"]["id"], "workflow:Execute", "*")
c.create_workflow_from_template("webhook-to-log", "demo")
```

Auth: `SynapseDXClient(base_url, token=..., api_key=...)`, or `set_token(jwt)` /
`set_api_key(key)` after login. `timeout` configurable (default 15s).
See `synapsedx_sdk/example.py` and [docs/api.md](../../docs/api.md).

## Full method coverage (mirrors `docs/api.md`)

- Auth: `login`, `refresh`, `logout`, `logout_all`, `verify`, `me`
- Orgs/accounts/users: `list_orgs`, `create_org`, `list_accounts`, `create_account`,
  `list_users`, `create_user`, `user_policies`
- IAM: `create_role`, `list_roles`, `delete_role`, `create_policy`, `list_policies`,
  `delete_policy`, `attach_policy`, `assign_role`, `authorize`, `simulate`,
  `list_audit`, `create_api_key`, `revoke_api_key`, `verify_api_key`,
  `create_service_account`, `list_service_accounts`, `service_account_token`
- Workflows: `list_workflows`, `get_workflow`, `create_workflow_from_template`,
  `create_workflow`, `activate_workflow`, `deactivate_workflow`, `execute_workflow`,
  `list_templates`, `get_template`, `list_executions`, `get_execution`
