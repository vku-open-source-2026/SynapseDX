"""Offline SDK tests — stdlib echo server, no platform needed."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from danax_sdk import DanaxClient, DanaxError

_seen: dict = {}


class Echo(BaseHTTPRequestHandler):
    def _send(self):
        _seen["auth"] = self.headers.get("Authorization")
        _seen["key"] = self.headers.get("X-API-Key")
        _seen["path"] = self.path
        body = json.dumps({"ok": True}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _send
    do_POST = _send

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
        c = DanaxClient(base + "/")
        assert c.base_url == base
        c.token = "t1"
        c.list_orgs()
        assert _seen["auth"] == "Bearer t1", _seen
        assert _seen["path"] == "/v1/orgs"
        c2 = DanaxClient(base, api_key="k1")
        c2.list_templates()
        assert _seen["key"] == "k1", _seen
    finally:
        srv.shutdown()


def test_network_error_wrapped():
    c = DanaxClient("http://127.0.0.1:1", timeout=2)
    try:
        c.list_orgs()
    except DanaxError as e:
        assert "danax" in str(e)
        return
    raise AssertionError("expected DanaxError")


def test_import():
    from danax_sdk import DanaxClient
    c = DanaxClient("http://localhost:8080")
    assert c.base_url == "http://localhost:8080"
