"""Smoke example for olp-sdk."""
from olp_sdk import OlpClient
import os

base = os.environ.get("OLP_BASE_URL", "http://localhost:8080")
c = OlpClient(base)
login = c.login("demo@acme.local")
print("login:", login["user"]["email"])
c.token = login["accessToken"]
print(c.list_orgs())
