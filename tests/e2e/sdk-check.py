# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
import os
import time

from synapsedx_sdk import SynapseDXClient

base = os.environ.get("SYNAPSEDX_BASE_URL", "http://127.0.0.1:18128")
c = SynapseDXClient(base)
login = c.login("pyfull@acme.local")
r = c.refresh(login["refreshToken"])
print("PY_REFRESH", bool(r["accessToken"]))
c.token = r["accessToken"]
org = c.list_orgs()[0]
slug = f"pyfull-{int(time.time()) % 100000}"
acc = c.create_account(org["id"], slug, "PY")
assert c.list_accounts(org["id"]), "list_accounts empty"
u = c.create_user(org["id"], f"pynu-{int(time.time()) % 100000}@acme.local")
role = c.create_role(acc["id"], "r")
pol = c.create_policy(
    acc["id"], "p", {"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}
)
c.attach_policy(role["id"], pol["id"])
c.assign_role(u["id"], role["id"])
print("PY_RBAC_OK")
assert c.user_policies(u["id"]) is not None
assert c.get_template("webhook-to-log")["name"]
assert c.list_templates()

# SynapseBase Vector search check
vcol = f"pyvec-{int(time.time()) % 100000}"
c.base.create_collection(
    vcol,
    mapping={
        "fields": {
            "title": {"path": "title", "type": "string"},
            "embedding": {
                "path": "embedding",
                "type": "vector",
                "dimension": 3,
                "metric": "cosine",
            },
        }
    },
)
c.base.create_document(vcol, {"title": "Doc 1", "embedding": [1.0, 0.0, 0.0]}, id="d1")
c.base.create_document(vcol, {"title": "Doc 2", "embedding": [0.0, 1.0, 0.0]}, id="d2")
res = c.base.vector_search(vcol, field="embedding", vector=[1.0, 0.0, 0.0], limit=2)
assert len(res.items) == 2
assert res.items[0]["id"] == "d1"
assert res.items[0]["similarity"] >= 0.99
c.base.delete_collection(vcol)
print("PY_BASE_VECTOR_OK")

c.logout_all(r["refreshToken"])
print("PY_LOGOUT_ALL_OK")
