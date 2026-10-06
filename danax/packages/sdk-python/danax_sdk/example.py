"""Smoke example for danax-sdk."""
from danax_sdk import DanaxClient
import os

base = os.environ.get("DANAX_BASE_URL", "http://localhost:8080")
c = DanaxClient(base)
login = c.login("demo@acme.local")
print("login:", login["user"]["email"])
c.token = login["accessToken"]
print(c.list_orgs())
