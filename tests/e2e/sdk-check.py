# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
import os
from synapsedx_sdk import SynapseDXClient

base = os.environ.get("SYNAPSEDX_BASE_URL", "http://127.0.0.1:18128")
c = SynapseDXClient(base)
login = c.login("pyfull@acme.local")
r = c.refresh(login["refreshToken"])
print("PY_REFRESH", bool(r["accessToken"]))
c.token = r["accessToken"]
org = c.list_orgs()[0]
acc = c.create_account(org["id"], "pyfull", "PY")
assert c.list_accounts(org["id"]), "list_accounts empty"
u = c.create_user(org["id"], "pynu@acme.local")
role = c.create_role(acc["id"], "r")
pol = c.create_policy(acc["id"], "p", {"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]})
c.attach_policy(role["id"], pol["id"])
c.assign_role(u["id"], role["id"])
print("PY_RBAC_OK")
assert c.user_policies(u["id"]) is not None
assert c.get_template("webhook-to-log")["name"]
assert c.list_templates()
c.logout_all(r["refreshToken"])
print("PY_LOGOUT_ALL_OK")
