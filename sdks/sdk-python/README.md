# synapsedx SDK for Python

Apache-2.0. See root LICENSE. Part of [SynapseDX](../../README.md) Tier-1 PaaS.

Requires Python 3.10+. Single runtime dependency: `requests>=2.28`.

## Install

```bash
pip install synapsedx-sdk
```

## Quick start

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

## Full documentation

See **[docs/sdk-python.md](../../docs/sdk-python.md)** for the complete API reference —
constructor, auth, all methods with signatures, parameters, return types, and examples.
