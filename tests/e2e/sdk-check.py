import os
from olp_sdk import OlpClient

base = os.environ.get("OLP_BASE_URL", "http://127.0.0.1:18128")
c = OlpClient(base)
login = c.login("pyfull@acme.local")
r = c.refresh(login["refreshToken"])
print("PY_REFRESH", bool(r["accessToken"]))
c.token = r["accessToken"]
org = c.list_orgs()[0]
acc = c.create_account(org["id"], "pyfull", "PY")
u = c.create_user(org["id"], "pynu@acme.local")
role = c._req("POST", f"/v1/accounts/{acc['id']}/roles", {"slug": "r"})
pol = c._req("POST", f"/v1/accounts/{acc['id']}/policies", {"slug": "p", "document": {"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}})
c.attach_policy(role["id"], pol["id"])
c.assign_role(u["id"], role["id"])
print("PY_RBAC_OK")
c.logout(r["refreshToken"])
print("PY_LOGOUT_OK")
