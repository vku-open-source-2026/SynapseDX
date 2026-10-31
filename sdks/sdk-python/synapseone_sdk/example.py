# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Smoke example for synapseone-sdk (gateway on :8080).

Shows the namespaced services: iam / workflow / lds / base / faststore / queue.
"""

import os

from synapseone_sdk import SynapseOneClient

base = os.environ.get("SYNAPSEONE_BASE_URL", "http://localhost:8080")
c = SynapseOneClient(base)
login = c.iam.login("demo@acme.local")
print("login:", login["user"]["email"])
c.token = login["accessToken"]

print("orgs:", c.iam.list_orgs())
print("templates:", c.workflow.list_templates())

# SynapseBase: collections + logical object writes
c.base.create_collection("demo-park", mapping={"name": "profile.name"})
c.base.create_document("demo-park", object={"name": "Central Park"})
print("documents:", c.base.list_documents("demo-park"))

# Faststore: cache with TTL
c.faststore.set("demo:greeting", "hello", ttl_seconds=60)
print("cached:", c.faststore.get("demo:greeting"))

# Queue: publish + consume one message
c.queue.create_queue("demo-emails")
c.queue.publish("demo-emails", {"to": "a@b.c"})
batch = c.queue.consume("demo-emails", max_messages=1, consumer="example")
for msg in batch["messages"]:
    print("got:", msg["payload"])
    c.queue.ack("demo-emails", msg["receipt"])
