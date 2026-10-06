"""Smoke example for synapsedx-sdk."""
from synapsedx_sdk import SynapseDXClient
import os

base = os.environ.get("SYNAPSEDX_BASE_URL", "http://localhost:8080")
c = SynapseDXClient(base)
login = c.login("demo@acme.local")
print("login:", login["user"]["email"])
c.token = login["accessToken"]
print(c.list_orgs())
