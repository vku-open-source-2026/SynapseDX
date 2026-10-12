# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Smoke example for synapsedx-sdk."""

import os

from synapsedx_sdk import SynapseDXClient

base = os.environ.get("SYNAPSEDX_BASE_URL", "http://localhost:8080")
c = SynapseDXClient(base)
login = c.login("demo@acme.local")
print("login:", login["user"]["email"])
c.token = login["accessToken"]
print(c.list_orgs())
