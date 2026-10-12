# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Offline SDK tests — stdlib echo server, no platform needed."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from synapsedx_sdk import SynapseDXClient, SynapseDXError

_seen: dict = {}


class Echo(BaseHTTPRequestHandler):
    def _send(self):
        _seen["auth"] = self.headers.get("Authorization")
        _seen["key"] = self.headers.get("X-API-Key")
        _seen["path"] = self.path
        _seen["method"] = self.command
        # List endpoints return arrays like the real API.
        is_list = self.command == "GET" and (
            self.path == "/v1/orgs"
            or self.path.startswith("/v1/executions")
            or self.path in ("/v1/templates", "/v1/workflows", "/v1/audit")
            or self.path.endswith(
                ("/accounts", "/users", "/roles", "/policies", "/service-accounts")
            )
        )
        payload = b"[]" if is_list else json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _send
    do_POST = _send
    do_DELETE = _send

    def log_message(self, *a):  # silent
        pass


def _server():
    srv = HTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_trim_and_headers():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base + "/")
        assert c.base_url == base
        c.token = "t1"
        c.list_orgs()
        assert _seen["auth"] == "Bearer t1", _seen
        assert _seen["path"] == "/v1/orgs"
        c2 = SynapseDXClient(base, api_key="k1")
        c2.list_templates()
        assert _seen["key"] == "k1", _seen
    finally:
        srv.shutdown()


def test_network_error_wrapped():
    c = SynapseDXClient("http://127.0.0.1:1", timeout=2)
    try:
        c.list_orgs()
    except SynapseDXError as e:
        assert "synapsedx" in str(e)
        return
    raise AssertionError("expected SynapseDXError")


def test_import():
    from synapsedx_sdk import SynapseDXClient

    c = SynapseDXClient("http://localhost:8080")
    assert c.base_url == "http://localhost:8080"


def test_full_coverage_paths():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        c.login("a@b.c")
        assert _seen["path"] == "/v1/auth/login"
        c.refresh("rt")
        assert _seen["path"] == "/v1/auth/refresh"
        c.list_accounts("org1")
        assert _seen["path"] == "/v1/orgs/org1/accounts"
        c.user_policies("u1")
        assert _seen["path"] == "/v1/users/u1/policies"
        c.get_template("webhook-to-log")
        assert _seen["path"] == "/v1/templates/webhook-to-log"
        c.get_workflow("a/b")
        assert _seen["path"] == "/v1/workflows/a%2Fb"
        c.deactivate_workflow("w1")
        assert _seen["path"] == "/v1/workflows/w1/deactivate"
        c.execute_workflow("w1", {})
        assert _seen["path"] == "/v1/workflows/w1/execute"
        c.list_executions("limit=5")
        assert _seen["path"] == "/v1/executions?limit=5"
        c.get_execution("e1")
        assert _seen["path"] == "/v1/executions/e1"
        c.verify_api_key("k")
        assert _seen["path"] == "/v1/keys/verify"
        c.list_audit(actor="u@x")
        assert "actor=u%40x" in _seen["path"], _seen
        c.set_token("t")
        c.set_api_key("k")
        assert c.token == "t" and c.api_key == "k"
        doc = {"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}
        c.create_workflow("n", doc)
        assert _seen["path"] == "/v1/workflows"
    finally:
        srv.shutdown()
