# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Offline tests for the split service SDKs — stdlib echo server, no platform.

Covers the new namespaces (base/faststore/queue), the typed BaseCollection
object<->data mapping and the deprecated flat facade wrappers.
"""

import dataclasses
import json
import threading
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer

from synapsedx_sdk import (
    BaseCollection,
    QueryResult,
    SynapseDXClient,
    SynapseDXError,
    data_to_object,
    object_to_data,
    trigger_webhook,
)

_seen: dict = {}


def _payload(method: str, path: str, body):
    """Endpoint-appropriate mock payloads (envelopes mirror the services)."""
    p = path.split("?")[0]
    if method == "GET" and p in ("/v1/base/collections", "/v1/lds/licenses"):
        return []
    if method == "GET" and p == "/v1/base/collections/parks/documents":
        return [
            {
                "id": "d1",
                "data": {"profile": {"name": "Central", "capacity": 10}},
                "version": 1,
                "createdAt": "t",
                "updatedAt": "t",
            }
        ]
    if method == "GET" and p == "/v1/base/collections/parks/documents/d1":
        return {
            "id": "d1",
            "object": {"name": "Central", "capacity": 10},
            "data": {"profile": {"name": "Central", "capacity": 10}},
            "version": 3,
            "createdAt": "t",
            "updatedAt": "t",
            "collection": "parks",
        }
    if p.endswith("/query"):
        return {
            "items": [
                {
                    "id": "p1",
                    "version": 1,
                    "data": {"profile": {"name": "Central", "capacity": 10}},
                    "object": {"name": "Central", "capacity": 10},
                    "createdAt": "t",
                    "updatedAt": "t",
                }
            ],
            "total": 1,
            "limit": 100,
            "offset": 0,
            "nextCursor": "abc",
        }
    if p.endswith("/changes"):
        return {
            "changes": [],
            "nextSince": "2026-01-01T00:00:00.000Z",
            "hasMore": False,
        }
    if (
        method in ("POST", "PUT", "PATCH")
        and p.startswith("/v1/base/collections/parks/documents")
        and not p.endswith(":batch")
    ):
        return {
            "id": "p1",
            "data": {"profile": {"name": "Central", "capacity": 10}},
            "version": 1,
            "createdAt": "t",
            "updatedAt": "t",
        }
    if method == "GET" and p == "/v1/faststore/keys":
        return {"keys": [], "cursor": None, "truncated": False}
    if (
        method == "GET"
        and p.startswith("/v1/faststore/keys/")
        and not p.endswith("/ttl")
    ):
        return {"key": "user:1", "type": "string", "value": "v", "ttlSeconds": 60}
    if p.endswith("/ttl"):
        return {"key": "user:1", "ttlSeconds": 42}
    if method == "GET" and p == "/v1/queue/queues":
        return []
    if p.endswith("/consume"):
        return {
            "queue": "emails",
            "count": 1,
            "visibilityTimeoutSeconds": 30,
            "messages": [
                {
                    "id": "m1",
                    "payload": {"to": "a@b.c"},
                    "attempts": 1,
                    "maxAttempts": 5,
                    "publishedAt": "t",
                    "receipt": "r1",
                    "leaseExpiresAt": "t2",
                }
            ],
        }
    if p.endswith("/ack"):
        if isinstance(body, dict) and "receipts" in body:
            return {
                "queue": "emails",
                "results": [
                    {"ok": True, "receipt": r, "id": "m1"} for r in body["receipts"]
                ],
                "ok": True,
            }
        return {
            "ok": True,
            "queue": "emails",
            "receipt": (body or {}).get("receipt"),
            "id": "m1",
        }
    if p.endswith("/nack"):
        return {
            "ok": True,
            "queue": "emails",
            "id": "m1",
            "state": "ready",
            "attempts": 2,
        }
    if p.endswith("/heartbeat"):
        return {
            "ok": True,
            "queue": "emails",
            "receipt": "r1",
            "leaseExpiresAt": "t3",
            "visibilityTimeoutSeconds": 30,
        }
    if method == "GET" and p.endswith(("/messages", "/dead")):
        return {"queue": "emails", "count": 0, "messages": []}
    if p.endswith("/replay"):
        return {"ok": True, "queue": "emails", "message": {"id": "m1", "attempts": 0}}
    return {"ok": True}


class Echo(BaseHTTPRequestHandler):
    def _send(self):
        _seen["auth"] = self.headers.get("Authorization")
        _seen["key"] = self.headers.get("X-API-Key")
        _seen["tenant"] = self.headers.get("x-synapsedx-tenant")
        _seen["path"] = self.path
        _seen["method"] = self.command
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode() if length else ""
        _seen["body"] = raw
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        payload = json.dumps(_payload(self.command, self.path, parsed)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _send
    do_POST = _send
    do_PUT = _send
    do_PATCH = _send
    do_DELETE = _send

    def log_message(self, *a):  # silent
        pass


class Failing(BaseHTTPRequestHandler):
    def _send(self):
        payload = b'{"error":"boom"}'
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _send
    do_POST = _send
    do_PUT = _send
    do_PATCH = _send
    do_DELETE = _send

    def log_message(self, *a):  # silent
        pass


def _server():
    srv = HTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _client(srv):
    return SynapseDXClient(f"http://127.0.0.1:{srv.server_port}")


# ---------------------------------------------------------------------------
# facade structure + deprecated wrappers
# ---------------------------------------------------------------------------


def test_facade_exposes_service_namespaces():
    c = SynapseDXClient("http://localhost:8080/")
    assert c.base_url == "http://localhost:8080"
    for name in ("iam", "workflow", "lds", "base", "faststore", "queue"):
        assert getattr(c, name) is not None, name
    assert isinstance(c.base.collection("parks"), BaseCollection)


def test_deprecated_wrappers_warn_and_forward():
    srv = _server()
    try:
        c = _client(srv)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            c.list_templates()
            c.list_lds_licenses()
        assert _seen["path"] == "/v1/lds/licenses", _seen
        messages = [str(w.message) for w in caught]
        assert any("client.workflow.list_templates()" in m for m in messages), messages
        assert any("client.lds.list_licenses()" in m for m in messages), messages
        assert all(w.category is DeprecationWarning for w in caught), caught
        # namespaced calls do not warn
        with warnings.catch_warnings(record=True) as caught2:
            warnings.simplefilter("always")
            c.workflow.list_templates()
            c.lds.list_licenses()
        assert caught2 == []
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# SynapseBase
# ---------------------------------------------------------------------------


def test_base_collection_lifecycle_paths_and_bodies():
    srv = _server()
    try:
        c = _client(srv)
        c.base.create_collection(
            "parks", "city parks", mapping={"name": "profile.name"}
        )
        assert _seen["path"] == "/v1/base/collections" and _seen["method"] == "POST"
        assert json.loads(_seen["body"]) == {
            "name": "parks",
            "description": "city parks",
            "mapping": {"name": "profile.name"},
        }, _seen
        c.base.update_collection("parks", name="parks2", description=None)
        assert _seen["method"] == "PATCH"
        assert json.loads(_seen["body"]) == {"name": "parks2", "description": None}, (
            _seen
        )
        c.base.get_collection("parks")
        assert _seen["path"] == "/v1/base/collections/parks"
        c.base.collection_stats("parks")
        assert _seen["path"] == "/v1/base/collections/parks/stats"
        c.base.delete_collection("parks")
        assert _seen["method"] == "DELETE"
    finally:
        srv.shutdown()


def test_base_documents_data_and_object_are_exclusive():
    srv = _server()
    try:
        c = _client(srv)
        c.base.create_document("parks", object={"name": "Central"}, id="p1")
        assert _seen["path"] == "/v1/base/collections/parks/documents"
        assert json.loads(_seen["body"]) == {
            "object": {"name": "Central"},
            "id": "p1",
        }, _seen
        c.base.create_document("parks", data={"profile": {"name": "Central"}})
        assert json.loads(_seen["body"]) == {
            "data": {"profile": {"name": "Central"}}
        }, _seen
        for call in (
            lambda: c.base.create_document("parks"),
            lambda: c.base.create_document("parks", {}, object={}),
        ):
            try:
                call()
                raise AssertionError("expected ValueError")
            except ValueError:
                pass
        c.base.get_document("parks", "p1", as_view="object")
        assert _seen["path"] == "/v1/base/collections/parks/documents/p1?as=object", (
            _seen
        )
        c.base.set_document("parks", "p1", data={"a": 1}, if_version=2, merge=True)
        assert _seen["method"] == "PUT"
        assert json.loads(_seen["body"]) == {
            "data": {"a": 1},
            "ifVersion": 2,
            "merge": True,
        }, _seen
        c.base.update_document(
            "parks", "p1", data={"b": 2}, unset=["profile.old"], if_version=3
        )
        assert _seen["method"] == "PATCH"
        assert json.loads(_seen["body"]) == {
            "data": {"b": 2},
            "unset": ["profile.old"],
            "ifVersion": 3,
        }, _seen
        try:
            c.base.update_document("parks", "p1")
            raise AssertionError("expected ValueError")
        except ValueError:
            pass
        c.base.delete_document("parks", "p1", if_version=2)
        assert _seen["path"] == "/v1/base/collections/parks/documents/p1?ifVersion=2", (
            _seen
        )
        assert _seen["method"] == "DELETE"
    finally:
        srv.shutdown()


def test_base_query_increment_batch_and_changes():
    srv = _server()
    try:
        c = _client(srv)
        result = c.base.query_documents(
            "parks",
            {"status": "active"},
            order_by=[{"field": "name", "direction": "desc"}],
            limit=10,
            offset=5,
            select=["name"],
            as_view="object",
        )
        assert _seen["path"] == "/v1/base/collections/parks/query"
        assert json.loads(_seen["body"]) == {
            "as": "object",
            "where": {"status": "active"},
            "orderBy": [{"field": "name", "direction": "desc"}],
            "limit": 10,
            "offset": 5,
            "select": ["name"],
        }, _seen
        assert isinstance(result, QueryResult)
        assert result.total == 1 and result.next_cursor == "abc"
        c.base.increment("parks", "p1", "counter", 3, if_version=2)
        assert _seen["path"] == "/v1/base/collections/parks/documents/p1/increment"
        assert json.loads(_seen["body"]) == {
            "field": "counter",
            "by": 3,
            "ifVersion": 2,
        }, _seen
        ops = [{"op": "create", "object": {"name": "x"}}]
        c.base.batch("parks", ops)
        assert _seen["path"] == "/v1/base/collections/parks/documents:batch"
        assert json.loads(_seen["body"]) == {"operations": ops}, _seen
        out = c.base.changes(
            "parks", "2026-01-01T00:00:00Z", limit=50, as_view="object"
        )
        assert _seen["path"].startswith("/v1/base/collections/parks/changes?"), _seen
        assert "since=2026-01-01T00%3A00%3A00Z" in _seen["path"], _seen
        assert "limit=50" in _seen["path"] and "as=object" in _seen["path"], _seen
        assert out["nextSince"] == "2026-01-01T00:00:00.000Z"
        c.base.list_documents("parks", limit=10, offset=20)
        assert (
            _seen["path"] == "/v1/base/collections/parks/documents?limit=10&offset=20"
        ), _seen
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# SynapseBase typed collection
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class Park:
    name: str
    capacity: int


def test_base_mapping_helpers():
    data = {"profile": {"name": "Central", "capacity": 10}}
    mapping = {
        "name": "profile.name",
        "capacity": {"path": "profile.capacity", "type": "number"},
    }
    assert data_to_object(data, mapping) == {"name": "Central", "capacity": 10}
    assert object_to_data({"name": "Central"}, mapping) == {
        "profile": {"name": "Central"}
    }
    assert data_to_object(data, None) == data
    assert object_to_data({"any": 1}, None) == {"any": 1}


def test_typed_collection_converts_models():
    srv = _server()
    try:
        c = _client(srv)
        col = c.base.collection(
            "parks",
            model=Park,
            mapping={"name": "profile.name", "capacity": "profile.capacity"},
        )
        assert col.to_object(Park("Central", 10)) == {"name": "Central", "capacity": 10}
        assert col.from_object({"name": "Central", "capacity": 10}) == Park(
            "Central", 10
        )
        created = col.create(Park("Central", 10), id="p1")
        assert json.loads(_seen["body"]) == {
            "object": {"name": "Central", "capacity": 10},
            "id": "p1",
        }, _seen
        assert created == Park("Central", 10), created
        fetched = col.get("d1")
        assert _seen["path"] == "/v1/base/collections/parks/documents/d1?as=object", (
            _seen
        )
        assert fetched == Park("Central", 10), fetched
        listed = col.list(limit=5)
        assert _seen["path"] == "/v1/base/collections/parks/documents?limit=5", _seen
        assert listed == [Park("Central", 10)], listed
        queried = col.query({"name": "Central"})
        assert queried.items == [Park("Central", 10)], queried
        updated = col.update("d1", Park("Central", 11), unset=["profile.old"])
        assert json.loads(_seen["body"]) == {
            "object": {"name": "Central", "capacity": 11},
            "unset": ["profile.old"],
        }, _seen
        assert updated == Park("Central", 10), updated
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# Synapse Faststore
# ---------------------------------------------------------------------------


def test_faststore_kv_and_tenant_header():
    srv = _server()
    try:
        c = _client(srv)
        c.tenant = "acme"
        c.faststore.set("user:1", {"a": 1}, ttl_seconds=60, if_not_exists=True)
        assert _seen["path"] == "/v1/faststore/keys/user%3A1", _seen
        assert _seen["method"] == "PUT"
        assert _seen["tenant"] == "acme", _seen
        assert json.loads(_seen["body"]) == {
            "value": {"a": 1},
            "ttlSeconds": 60,
            "ifNotExists": True,
        }, _seen
        assert c.faststore.get("user:1")["value"] == "v", _seen
        c.faststore.expire("user:1", 30)
        assert _seen["path"] == "/v1/faststore/keys/user%3A1/expire"
        assert json.loads(_seen["body"]) == {"ttlSeconds": 30}, _seen
        c.faststore.incr("counter", 2)
        assert json.loads(_seen["body"]) == {"by": 2}, _seen
        assert c.faststore.ttl("user:1")["ttlSeconds"] == 42, _seen
        c.faststore.list_keys(prefix="user:", limit=5, cursor="10")
        assert _seen["path"] == "/v1/faststore/keys?prefix=user%3A&limit=5&cursor=10", (
            _seen
        )
        ops = [{"op": "set", "key": "a", "value": 1}]
        c.faststore.batch(ops)
        assert json.loads(_seen["body"]) == {"operations": ops}, _seen
        c.faststore.delete("user:1")
        assert _seen["method"] == "DELETE"
        c.tenant = None
    finally:
        srv.shutdown()


def test_faststore_collections_and_locks():
    srv = _server()
    try:
        c = _client(srv)
        c.faststore.hash_set("h1", {"a": 1}, ttl_seconds=10)
        assert _seen["path"] == "/v1/faststore/hashes/h1"
        assert json.loads(_seen["body"]) == {"values": {"a": 1}, "ttlSeconds": 10}, (
            _seen
        )
        c.faststore.hash_get_field("h1", "a")
        assert _seen["path"] == "/v1/faststore/hashes/h1/a", _seen
        c.faststore.hash_incr("h1", "a", 2)
        assert _seen["path"] == "/v1/faststore/hashes/h1/incr"
        assert json.loads(_seen["body"]) == {"field": "a", "by": 2}, _seen
        c.faststore.hash_length("h1")
        assert _seen["path"] == "/v1/faststore/hashes/h1/length", _seen
        c.faststore.hash_delete_field("h1", "a")
        assert (
            _seen["method"] == "DELETE" and _seen["path"] == "/v1/faststore/hashes/h1/a"
        )
        c.faststore.list_push("l1", ["x", "y"], side="left")
        assert json.loads(_seen["body"]) == {"values": ["x", "y"], "side": "left"}, (
            _seen
        )
        c.faststore.list_pop("l1", side="right", count=2)
        assert json.loads(_seen["body"]) == {"side": "right", "count": 2}, _seen
        c.faststore.list_range("l1", 0, -1)
        assert _seen["path"] == "/v1/faststore/lists/l1?start=0&stop=-1", _seen
        c.faststore.list_trim("l1", 0, 9)
        assert json.loads(_seen["body"]) == {"start": 0, "stop": 9}, _seen
        c.faststore.set_add("s1", ["a"], ttl_seconds=5)
        assert json.loads(_seen["body"]) == {"members": ["a"], "ttlSeconds": 5}, _seen
        c.faststore.set_contains("s1", "a")
        assert json.loads(_seen["body"]) == {"member": "a"}, _seen
        c.faststore.set_remove("s1", ["a"])
        assert json.loads(_seen["body"]) == {"members": ["a"]}, _seen
        c.faststore.set_card("s1")
        assert _seen["path"] == "/v1/faststore/sets/s1/card", _seen
        c.faststore.zset_add("z1", [{"member": "a", "score": 2}])
        assert json.loads(_seen["body"]) == {
            "members": [{"member": "a", "score": 2}]
        }, _seen
        c.faststore.zset_range("z1", 0, -1, rev=True, with_scores=True)
        assert (
            _seen["path"]
            == "/v1/faststore/zsets/z1?start=0&stop=-1&rev=true&withScores=true"
        ), _seen
        c.faststore.zset_incr("z1", "a", 1.5)
        assert json.loads(_seen["body"]) == {"member": "a", "by": 1.5}, _seen
        c.faststore.zset_rank("z1", "a", rev=True)
        assert json.loads(_seen["body"]) == {"member": "a", "rev": True}, _seen
        c.faststore.lock_acquire("job", ttl_seconds=60, wait_ms=500, token="tok")
        assert _seen["path"] == "/v1/faststore/locks/job/acquire", _seen
        assert json.loads(_seen["body"]) == {
            "waitMs": 500,
            "ttlSeconds": 60,
            "token": "tok",
        }, _seen
        c.faststore.lock_extend("job", "tok", ttl_seconds=60)
        assert json.loads(_seen["body"]) == {"token": "tok", "ttlSeconds": 60}, _seen
        c.faststore.lock_release("job", "tok")
        assert json.loads(_seen["body"]) == {"token": "tok"}, _seen
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# SynapseQueue
# ---------------------------------------------------------------------------


def test_queue_config_and_publish():
    srv = _server()
    try:
        c = _client(srv)
        c.queue.create_queue("emails", max_attempts=7, visibility_timeout_seconds=45)
        assert _seen["path"] == "/v1/queue/queues/emails" and _seen["method"] == "PUT"
        assert json.loads(_seen["body"]) == {
            "maxAttempts": 7,
            "visibilityTimeoutSeconds": 45,
        }, _seen
        c.queue.list_queues()
        assert _seen["path"] == "/v1/queue/queues", _seen
        c.queue.publish(
            "emails",
            {"to": "a@b.c"},
            delay_seconds=30,
            max_attempts=3,
            headers={"trace": "t1"},
            id="m1",
            dedupe_key="welcome:a@b.c",
        )
        assert _seen["path"] == "/v1/queue/queues/emails/messages"
        assert json.loads(_seen["body"]) == {
            "payload": {"to": "a@b.c"},
            "delaySeconds": 30,
            "maxAttempts": 3,
            "headers": {"trace": "t1"},
            "id": "m1",
            "dedupeKey": "welcome:a@b.c",
        }, _seen
        msgs = [{"payload": 1}, {"payload": 2, "dedupeKey": "k"}]
        c.queue.publish_batch("emails", msgs)
        assert _seen["path"] == "/v1/queue/queues/emails/messages:batch"
        assert json.loads(_seen["body"]) == {"messages": msgs}, _seen
        c.queue.queue_stats("emails")
        assert _seen["path"] == "/v1/queue/queues/emails/stats", _seen
        c.queue.purge_queue("emails")
        assert _seen["path"] == "/v1/queue/queues/emails/purge", _seen
        c.queue.delete_queue("emails")
        assert _seen["method"] == "DELETE"
    finally:
        srv.shutdown()


def test_queue_consume_ack_nack_heartbeat():
    srv = _server()
    try:
        c = _client(srv)
        out = c.queue.consume(
            "emails", max_messages=5, visibility_timeout_seconds=20, consumer="w1"
        )
        assert _seen["path"] == "/v1/queue/queues/emails/consume"
        assert json.loads(_seen["body"]) == {
            "maxMessages": 5,
            "visibilityTimeoutSeconds": 20,
            "consumer": "w1",
        }, _seen
        receipt = out["messages"][0]["receipt"]
        assert receipt == "r1", out
        c.queue.ack("emails", receipt)
        assert json.loads(_seen["body"]) == {"receipt": "r1"}, _seen
        c.queue.ack_many("emails", ["r1", "r2"])
        assert json.loads(_seen["body"]) == {"receipts": ["r1", "r2"]}, _seen
        c.queue.nack("emails", "r1", requeue=False, delay_seconds=5, error="boom")
        assert _seen["path"] == "/v1/queue/queues/emails/nack"
        assert json.loads(_seen["body"]) == {
            "receipt": "r1",
            "requeue": False,
            "delaySeconds": 5,
            "error": "boom",
        }, _seen
        c.queue.heartbeat("emails", "r1", visibility_timeout_seconds=60)
        assert json.loads(_seen["body"]) == {
            "receipt": "r1",
            "visibilityTimeoutSeconds": 60,
        }, _seen
    finally:
        srv.shutdown()


def test_queue_inspection_and_dead_letters():
    srv = _server()
    try:
        c = _client(srv)
        c.queue.peek("emails", limit=10, ready=True)
        assert (
            _seen["path"] == "/v1/queue/queues/emails/messages?limit=10&ready=true"
        ), _seen
        c.queue.dead_letters("emails", limit=5)
        assert _seen["path"] == "/v1/queue/queues/emails/dead?limit=5", _seen
        c.queue.replay_dead("emails", "m1", delay_seconds=0, reset_attempts=True)
        assert _seen["path"] == "/v1/queue/queues/emails/dead/m1/replay"
        assert json.loads(_seen["body"]) == {
            "delaySeconds": 0,
            "resetAttempts": True,
        }, _seen
        c.queue.delete_dead("emails", "m1")
        assert _seen["method"] == "DELETE"
        assert _seen["path"] == "/v1/queue/queues/emails/dead/m1", _seen
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# error mapping + misc
# ---------------------------------------------------------------------------


def test_http_error_carries_status_and_body():
    srv = HTTPServer(("127.0.0.1", 0), Failing)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = _client(srv)
        try:
            c.base.get_collection("parks")
            raise AssertionError("expected SynapseDXError")
        except SynapseDXError as e:
            assert e.status == 404, e
            assert e.body == {"error": "boom"}, e
            assert "synapsedx 404" in str(e), e
    finally:
        srv.shutdown()


def test_webhook_still_module_level():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        assert trigger_webhook(base, "transform", {"value": 21}) == {"ok": True}
        assert _seen["path"] == "/webhook/transform", _seen
        assert _seen["auth"] is None, _seen
    finally:
        srv.shutdown()
