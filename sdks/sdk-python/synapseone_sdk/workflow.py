# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Workflow service client: templates, workflow CRUD/lifecycle, executions,
test runs and public inbound webhooks.

Access it through ``SynapseOneClient(...).workflow`` or build it directly with a
:class:`~synapseone_sdk._http.HttpClient`.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

import requests

from ._http import HttpClient, SynapseOneError


def unwrap_executions(payload: Any) -> list:
    """Normalize GET /v1/executions: engine returns {data: []}, mocks may return [].

    Accepts both a bare list and the {data: [...]} envelope so callers
    always get a list.
    """
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if payload is None:
        return []
    return payload  # type: ignore[return-value]


class WorkflowService:
    """Typed methods for every ``/v1`` workflow endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    # ---- templates ----
    def list_templates(self) -> Any:
        """List built-in workflow templates."""
        return self._req("GET", "/v1/templates")

    def get_template(self, name: str) -> Any:
        """Fetch a single built-in template definition by name."""
        return self._req("GET", f"/v1/templates/{quote(name, safe='')}")

    # ---- workflows ----
    def list_workflows(self) -> Any:
        """List workflows."""
        return self._req("GET", "/v1/workflows")

    def get_workflow(self, wf_id: str) -> Any:
        """Fetch a workflow definition."""
        return self._req("GET", f"/v1/workflows/{quote(wf_id, safe='')}")

    def create_workflow_from_template(
        self, template: str, name: str | None = None
    ) -> Any:
        """Create a workflow from a built-in template."""
        return self._req("POST", "/v1/workflows", {"template": template, "name": name})

    def create_workflow(
        self, name: str, definition: dict, settings: dict | None = None
    ) -> Any:
        """Create a workflow from a raw workflow definition."""
        body: dict = {"name": name, "definition": definition}
        if settings is not None:
            body["settings"] = settings
        return self._req("POST", "/v1/workflows", body)

    def update_workflow(
        self,
        wf_id: str,
        name: str | None = None,
        definition: dict | None = None,
        settings: dict | None = None,
    ) -> Any:
        """Update a workflow's name, definition and/or settings."""
        patch: dict = {}
        if name is not None:
            patch["name"] = name
        if definition is not None:
            patch["definition"] = definition
        if settings is not None:
            patch["settings"] = settings
        return self._req("PUT", f"/v1/workflows/{quote(wf_id, safe='')}", patch)

    def delete_workflow(self, wf_id: str) -> Any:
        """Delete a workflow."""
        return self._req("DELETE", f"/v1/workflows/{quote(wf_id, safe='')}")

    def activate_workflow(self, wf_id: str) -> Any:
        """Activate a workflow (webhooks and triggers start firing)."""
        return self._req("POST", f"/v1/workflows/{quote(wf_id, safe='')}/activate")

    def deactivate_workflow(self, wf_id: str) -> Any:
        """Deactivate a workflow (triggers stop, history is kept)."""
        return self._req("POST", f"/v1/workflows/{quote(wf_id, safe='')}/deactivate")

    def execute_workflow(self, wf_id: str, payload: dict | None = None) -> Any:
        """Trigger a manual execution (local engine)."""
        return self._req(
            "POST", f"/v1/workflows/{quote(wf_id, safe='')}/execute", payload or {}
        )

    # ---- executions ----
    def list_executions(self, query: str | dict | None = "") -> Any:
        """List executions.

        query may be a raw string (e.g. 'limit=20') or a dict limited to the
        engine allowlist: limit/offset/workflowId/status/triggeredBy/includeData.
        Returns a plain list — accepts both the {data: []} envelope and a
        bare array (see unwrap_executions).
        """
        q = ""
        if isinstance(query, dict):
            allowed = (
                "limit",
                "offset",
                "workflowId",
                "status",
                "triggeredBy",
                "includeData",
            )
            params = {k: query[k] for k in allowed if query.get(k) not in (None, "")}
            qs = urlencode(params)
            q = f"?{qs}" if qs else ""
        elif query:
            q = query if query.startswith("?") else f"?{query}"
        raw = self._req("GET", f"/v1/executions{q}")
        return unwrap_executions(raw)

    def get_execution(self, exec_id: str, include_data: bool = False) -> Any:
        """Fetch one execution (optionally with its payload data)."""
        qs = "?includeData=true" if include_data else ""
        return self._req("GET", f"/v1/executions/{quote(exec_id, safe='')}{qs}")

    def test_run(
        self,
        definition: dict,
        input: dict | None = None,
        workflow_id: str | None = None,
    ) -> Any:
        """Try a definition without saving (POST /v1/workflows/test-run).

        Pass workflow_id to attach the run to a saved workflow's history.
        """
        body: dict = {"definition": definition, "input": input or {}}
        if workflow_id:
            body["workflowId"] = workflow_id
        return self._req("POST", "/v1/workflows/test-run", body)

    # ---- credentials (account-scoped secrets, encrypted at rest) ----
    def create_credential(
        self,
        account_id: str,
        name: str,
        kind: str = "bearer",
        secret: str = "",
        *,
        type: str | None = None,
        expires_at: str | None = None,
    ) -> dict:
        """Store an account credential (secret is write-only, encrypted at rest)."""
        body: dict[str, Any] = {
            "accountId": account_id,
            "name": name,
            "kind": kind or type or "bearer",
            "secret": secret,
        }
        return self._req("POST", "/v1/credentials", body)

    def list_credentials(self, account_id: str | None = None) -> list:
        """List credential metadata (never secrets)."""
        qs = f"?accountId={quote(account_id, safe='')}" if account_id else ""
        raw = self._req("GET", f"/v1/credentials{qs}")
        if isinstance(raw, dict) and isinstance(raw.get("data"), list):
            return raw["data"]
        return raw if isinstance(raw, list) else []

    def get_credential(self, cred_id: str) -> dict:
        """Fetch one credential's metadata (never the secret)."""
        return self._req("GET", f"/v1/credentials/{quote(cred_id, safe='')}")

    def rotate_credential(self, cred_id: str, secret: str) -> dict:
        """Rotate a credential's secret in place (write-only)."""
        return self._req(
            "POST",
            f"/v1/credentials/{quote(cred_id, safe='')}/rotate",
            {"secret": secret},
        )

    def delete_credential(self, cred_id: str) -> dict:
        """Delete a credential."""
        return self._req("DELETE", f"/v1/credentials/{quote(cred_id, safe='')}")

    def trigger_webhook(
        self,
        path: str,
        payload: Any | None = None,
        method: str | None = None,
    ) -> Any:
        """Fire a public inbound webhook through the gateway: ANY /webhook/:path."""
        clean = str(path or "").strip("/").split("?")[0]
        if not clean:
            raise SynapseOneError("synapseone webhook: path required")
        verb = (method or ("GET" if payload is None else "POST")).upper()
        return self._http.request(verb, f"/webhook/{clean}", payload)


def trigger_webhook(
    webhook_base_url: str,
    path: str,
    payload: Any | None = None,
    method: str | None = None,
    timeout: int = 15,
) -> Any:
    """Fire a public inbound webhook: ANY /webhook/:path (no auth).

    Triggers the ACTIVE workflow whose webhook node declares that ``path``.
    NOTE: the gateway does not proxy /webhook/* — pass the workflow-service
    origin (e.g. "http://localhost:4002"), not the gateway URL.
    """
    clean = str(path or "").strip("/").split("?")[0]
    if not clean:
        raise SynapseOneError("synapseone webhook: path required")
    verb = (method or ("GET" if payload is None else "POST")).upper()
    url = webhook_base_url.rstrip("/") + "/webhook/" + clean
    try:
        if verb == "GET":
            r = requests.request(verb, url, timeout=timeout)
        else:
            r = requests.request(
                verb,
                url,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=timeout,
            )
    except Exception as e:
        raise SynapseOneError(f"synapseone network /webhook/{clean}: {e}") from e
    try:
        r.raise_for_status()
    except Exception as e:
        raise SynapseOneError(
            f"synapseone {r.status_code} /webhook/{clean}: {r.text[:500]}",
            status=r.status_code,
        ) from e
    if not r.text:
        return None
    try:
        return r.json()
    except ValueError:
        return r.text
