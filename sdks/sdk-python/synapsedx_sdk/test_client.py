# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Offline SDK tests — stdlib echo server, no platform needed."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from synapsedx_sdk import (
    SynapseDXClient,
    SynapseDXError,
    trigger_webhook,
    unwrap_executions,
)

_seen: dict = {}


class Echo(BaseHTTPRequestHandler):
    def _send(self):
        _seen["auth"] = self.headers.get("Authorization")
        _seen["key"] = self.headers.get("X-API-Key")
        _seen["path"] = self.path
        _seen["method"] = self.command
        length = int(self.headers.get("Content-Length") or 0)
        _seen["body"] = self.rfile.read(length).decode() if length else ""
        # List endpoints return arrays like the real API.
        is_list = self.command == "GET" and (
            self.path == "/v1/orgs"
            or self.path.startswith("/v1/executions")
            or self.path in ("/v1/templates", "/v1/workflows", "/v1/audit")
            or self.path in ("/v1/lds/licenses", "/v1/lds/datasources")
            or self.path.startswith("/v1/lds/datasources?")
            or self.path.split("?")[0].endswith("/entities")
            or self.path.endswith(
                (
                    "/accounts",
                    "/users",
                    "/roles",
                    "/policies",
                    "/credentials",
                    "/service-accounts",
                    "/attributes",
                )
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
    do_PUT = _send
    do_PATCH = _send
    do_DELETE = _send

    def log_message(self, *a):  # silent
        pass


class Failing(BaseHTTPRequestHandler):
    """Always answers 500 with a JSON error body (HTTP error-mapping tests)."""

    def _send(self):
        payload = b'{"error":"boom"}'
        self.send_response(500)
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


def _failing_server():
    srv = HTTPServer(("127.0.0.1", 0), Failing)
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
        c.attach_policy("r1", "p1")
        assert _seen["path"] == "/v1/roles/r1/attach"
        c.detach_policy("r1", "p1")
        assert _seen["path"] == "/v1/roles/r1/policies/p1"
        assert _seen["method"] == "DELETE"
        c.role_policies("r1")
        assert _seen["path"] == "/v1/roles/r1/policies"
        c.assign_role("u1", "r1")
        assert _seen["path"] == "/v1/users/u1/assign"
        c.unassign_role("u1", "r1")
        assert _seen["path"] == "/v1/users/u1/roles/r1"
        c.user_roles("u1")
        assert _seen["path"] == "/v1/users/u1/roles"
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
        c.update_workflow("w1", name="renamed")
        assert _seen["path"] == "/v1/workflows/w1"
        c.delete_workflow("w1")
        assert _seen["path"] == "/v1/workflows/w1"
        assert _seen["method"] == "DELETE"
        c.list_api_keys("a1")
        assert _seen["path"] == "/v1/accounts/a1/keys"
    finally:
        srv.shutdown()


def test_test_run_posts_definition_and_input():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        definition = {"nodes": [], "connections": {}}
        c.test_run(definition, {"value": 21})
        assert _seen["path"] == "/v1/workflows/test-run"
        assert _seen["method"] == "POST"
        assert json.loads(_seen["body"]) == {
            "definition": definition,
            "input": {"value": 21},
        }
    finally:
        srv.shutdown()


def test_list_executions_dict_and_envelope():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        c.list_executions(
            {"workflowId": "w1", "status": "error", "limit": 20, "includeData": True}
        )
        assert _seen["path"].startswith("/v1/executions?"), _seen
        assert "workflowId=w1" in _seen["path"], _seen
        assert "status=error" in _seen["path"], _seen
        assert "limit=20" in _seen["path"], _seen
        # get_execution includeData flag
        c.get_execution("e1", include_data=True)
        assert _seen["path"] == "/v1/executions/e1?includeData=true", _seen
    finally:
        srv.shutdown()


def test_unwrap_executions_accepts_envelope_and_array():
    assert unwrap_executions({"data": [{"id": "e1"}]}) == [{"id": "e1"}]
    assert unwrap_executions([{"id": "e2"}]) == [{"id": "e2"}]
    assert unwrap_executions(None) == []


def test_trigger_webhook_posts_to_path_without_auth():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        out = trigger_webhook(base, "transform", {"value": 21})
        assert _seen["path"] == "/webhook/transform", _seen
        assert _seen["method"] == "POST", _seen
        assert json.loads(_seen["body"]) == {"value": 21}, _seen
        assert out == {"ok": True}, out
        assert _seen["auth"] is None, _seen
    finally:
        srv.shutdown()


def test_call_passes_any_method_path_body_through():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        c.call("POST", "/v1/accounts/a1/credentials", {"name": "x"})
        assert _seen["path"] == "/v1/accounts/a1/credentials", _seen
        assert _seen["method"] == "POST", _seen
        assert json.loads(_seen["body"]) == {"name": "x"}, _seen
        c.call("get", "v1/workflows")
        assert _seen["path"] == "/v1/workflows", _seen
        assert _seen["method"] == "GET", _seen
    finally:
        srv.shutdown()


def test_credentials_crud_proposed_contract():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        c.create_credential(
            "a1", "stripe-live", "bearer", "s3cr3t", "2027-01-01T00:00:00Z"
        )
        assert _seen["path"] == "/v1/accounts/a1/credentials", _seen
        assert _seen["method"] == "POST", _seen
        assert json.loads(_seen["body"]) == {
            "name": "stripe-live",
            "type": "bearer",
            "secret": "s3cr3t",
            "expiresAt": "2027-01-01T00:00:00Z",
        }, _seen
        c.list_credentials("a1")
        assert _seen["path"] == "/v1/accounts/a1/credentials", _seen
        assert _seen["method"] == "GET", _seen
        c.get_credential("c1")
        assert _seen["path"] == "/v1/credentials/c1", _seen
        c.rotate_credential("c1", "n3w")
        assert _seen["path"] == "/v1/credentials/c1/rotate", _seen
        assert _seen["method"] == "POST", _seen
        assert json.loads(_seen["body"]) == {"secret": "n3w"}, _seen
        c.delete_credential("c1")
        assert _seen["path"] == "/v1/credentials/c1", _seen
        assert _seen["method"] == "DELETE", _seen
    finally:
        srv.shutdown()


def test_lds_list_licenses_returns_array():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        assert c.list_lds_licenses() == [], _seen
        assert _seen["path"] == "/v1/lds/licenses", _seen
        assert _seen["method"] == "GET", _seen
    finally:
        srv.shutdown()


def test_lds_create_datasource_body():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        c.create_lds_datasource("parks", "Park", "CC-BY-4.0")
        assert _seen["path"] == "/v1/lds/datasources", _seen
        assert _seen["method"] == "POST", _seen
        assert json.loads(_seen["body"]) == {
            "name": "parks",
            "entityType": "Park",
            "license": "CC-BY-4.0",
        }, _seen
        # Optional fields are only sent when passed.
        c.create_lds_datasource(
            "parks",
            "Park",
            "CC-BY-4.0",
            slug="parks",
            license_url="https://example.com/license",
            contexts=["https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld"],
            default_visibility="public",
            description="city parks",
            org_id="org1",
            account_id="acct1",
        )
        assert json.loads(_seen["body"]) == {
            "name": "parks",
            "entityType": "Park",
            "license": "CC-BY-4.0",
            "slug": "parks",
            "licenseUrl": "https://example.com/license",
            "contexts": ["https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld"],
            "defaultVisibility": "public",
            "description": "city parks",
            "orgId": "org1",
            "accountId": "acct1",
        }, _seen
    finally:
        srv.shutdown()


def test_lds_datasource_crud_paths():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        assert c.list_lds_datasources() == [], _seen
        assert _seen["path"] == "/v1/lds/datasources", _seen
        c.list_lds_datasources(org_id="o1", account_id="a1")
        assert _seen["path"] == "/v1/lds/datasources?orgId=o1&accountId=a1", _seen
        c.get_lds_datasource("d1")
        assert _seen["path"] == "/v1/lds/datasources/d1", _seen
        c.update_lds_datasource(
            "d1", description="updated", default_visibility="restricted"
        )
        assert _seen["path"] == "/v1/lds/datasources/d1", _seen
        assert _seen["method"] == "PATCH", _seen
        assert json.loads(_seen["body"]) == {
            "description": "updated",
            "defaultVisibility": "restricted",
        }, _seen
        assert c.get_lds_datasource_stats("d1") == {"ok": True}, _seen
        assert _seen["path"] == "/v1/lds/datasources/d1/stats", _seen
        c.delete_lds_datasource("d1")
        assert _seen["path"] == "/v1/lds/datasources/d1", _seen
        assert _seen["method"] == "DELETE", _seen
    finally:
        srv.shutdown()


def test_lds_set_attributes_puts_attribute_list():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        assert c.get_lds_datasource_attributes("d1") == [], _seen
        assert _seen["path"] == "/v1/lds/datasources/d1/attributes", _seen
        assert _seen["method"] == "GET", _seen
        attrs = [
            {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
            {"name": "capacity", "sourceField": "capacity_total"},
        ]
        c.set_lds_datasource_attributes("d1", attrs)
        assert _seen["path"] == "/v1/lds/datasources/d1/attributes", _seen
        assert _seen["method"] == "PUT", _seen
        assert json.loads(_seen["body"]) == {"attributes": attrs}, _seen
    finally:
        srv.shutdown()


def test_lds_ingest_records_single_list_and_envelope():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        c.ingest_lds_records("d1", {"id": "Park:1", "name": "Central"})
        assert _seen["path"] == "/v1/lds/datasources/d1/records", _seen
        assert _seen["method"] == "POST", _seen
        assert json.loads(_seen["body"]) == {"id": "Park:1", "name": "Central"}, _seen
        c.ingest_lds_records("d1", [{"id": "Park:1"}, {"id": "Park:2"}])
        assert json.loads(_seen["body"]) == {
            "records": [{"id": "Park:1"}, {"id": "Park:2"}]
        }, _seen
        c.ingest_lds_records("d1", {"records": [{"id": "Park:3"}]})
        assert json.loads(_seen["body"]) == {
            "records": [{"id": "Park:3"}]
        }, _seen
    finally:
        srv.shutdown()


def test_lds_entities_with_query_params():
    srv = _server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        out = c.list_lds_entities("d1", limit=5, offset=10, visibility="public")
        assert isinstance(out, list), out
        assert (
            _seen["path"]
            == "/v1/lds/datasources/d1/entities?limit=5&offset=10&visibility=public"
        ), _seen
        c.list_lds_entities("d1")
        assert _seen["path"] == "/v1/lds/datasources/d1/entities", _seen
        c.list_lds_entities("d1", visibility="restricted")
        assert _seen["path"] == (
            "/v1/lds/datasources/d1/entities?visibility=restricted"
        ), _seen
        c.get_lds_entity("d1", "urn:ngsi-ld:Park:1")
        assert _seen["path"] == (
            "/v1/lds/datasources/d1/entities/urn%3Angsi-ld%3APark%3A1"
        ), _seen
    finally:
        srv.shutdown()


def test_lds_http_error_mapping():
    srv = _failing_server()
    try:
        base = f"http://127.0.0.1:{srv.server_port}"
        c = SynapseDXClient(base)
        try:
            c.list_lds_licenses()
        except SynapseDXError as e:
            assert "500" in str(e) and "boom" in str(e), e
            return
        raise AssertionError("expected SynapseDXError")
    finally:
        srv.shutdown()
