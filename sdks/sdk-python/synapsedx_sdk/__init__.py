# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""synapsedx Python SDK — gateway + IAM + workflow client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

import requests


class SynapseDXError(Exception):
    """All SDK errors surface as SynapseDXError (network or HTTP)."""


__all__ = [
    "SynapseDXClient",
    "SynapseDXError",
    "trigger_webhook",
    "unwrap_executions",
]


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


@dataclass
class SynapseDXClient:
    base_url: str
    token: str | None = None
    api_key: str | None = None
    timeout: int = 15

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if self.api_key:
            h["X-API-Key"] = self.api_key
        return h

    def set_token(self, token: str) -> None:
        """Set/replace the Bearer JWT (mirrors JS setToken / Go SetToken)."""
        self.token = token

    def set_api_key(self, api_key: str) -> None:
        """Set/replace the X-API-Key (mirrors JS setApiKey / Go SetAPIKey)."""
        self.api_key = api_key

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        try:
            r = requests.request(
                method,
                self.base_url + path,
                json=body,
                headers=self._headers(),
                timeout=self.timeout,
            )
        except Exception as e:  # network, DNS, timeout...
            raise SynapseDXError(f"synapsedx network {path}: {e}") from e
        try:
            r.raise_for_status()
        except Exception as e:
            raise SynapseDXError(
                f"synapsedx {r.status_code} {path}: {r.text[:500]}"
            ) from e
        if not r.text:
            return None
        try:
            return r.json()
        except ValueError:
            return r.text  # non-JSON body (parity with JS SDK text fallback)

    # ---- auth ----
    def login(self, email: str, org_slug: str = "acme") -> dict:
        return self._req(
            "POST", "/v1/auth/login", {"email": email, "orgSlug": org_slug}
        )

    def refresh(self, refresh_token: str) -> dict:
        return self._req("POST", "/v1/auth/refresh", {"refreshToken": refresh_token})

    def logout(self, refresh_token: str) -> dict:
        return self._req("POST", "/v1/auth/logout", {"refreshToken": refresh_token})

    def logout_all(self, refresh_token: str) -> dict:
        return self._req("POST", "/v1/auth/logout-all", {"refreshToken": refresh_token})

    def verify(self) -> dict:
        return self._req("GET", "/v1/auth/verify")

    def me(self) -> dict:
        return self._req("GET", "/v1/auth/me")

    # ---- OIDC (SSO authorization-code flow) ----
    def oidc_config(self) -> dict:
        return self._req("GET", "/v1/auth/oidc/config")

    def oidc_start(self, org: str = "acme") -> dict:
        return self._req("GET", f"/v1/auth/oidc/start?org={quote(org, safe='')}")

    def oidc_callback(self, code: str, state: str) -> dict:
        return self._req(
            "POST", "/v1/auth/oidc/callback", {"code": code, "state": state}
        )

    # ---- orgs ----
    def list_orgs(self) -> list:
        return self._req("GET", "/v1/orgs")

    def create_org(self, slug: str, display_name: str) -> dict:
        return self._req(
            "POST", "/v1/orgs", {"slug": slug, "displayName": display_name}
        )

    def create_account(self, org_id: str, slug: str, display_name: str) -> dict:
        return self._req(
            "POST",
            f"/v1/orgs/{quote(org_id, safe='')}/accounts",
            {"slug": slug, "displayName": display_name},
        )

    def list_accounts(self, org_id: str) -> list:
        return self._req("GET", f"/v1/orgs/{quote(org_id, safe='')}/accounts")

    def create_user(
        self, org_id: str, email: str, display_name: str | None = None
    ) -> dict:
        return self._req(
            "POST",
            f"/v1/orgs/{quote(org_id, safe='')}/users",
            {"email": email, "displayName": display_name},
        )

    def list_users(self, org_id: str) -> list:
        return self._req("GET", f"/v1/orgs/{quote(org_id, safe='')}/users")

    def user_policies(self, user_id: str) -> list:
        """Effective policy documents of a user (debug helper for authorize)."""
        return self._req("GET", f"/v1/users/{quote(user_id, safe='')}/policies")

    # ---- iam ----
    def authorize(
        self, user_id: str, action: str, resource: str, context: dict | None = None
    ) -> dict:
        return self._req(
            "POST",
            "/v1/authorize",
            {
                "userId": user_id,
                "action": action,
                "resource": resource,
                "context": context,
            },
        )

    def attach_policy(self, role_id: str, policy_id: str) -> dict:
        return self._req(
            "POST",
            f"/v1/roles/{quote(role_id, safe='')}/attach",
            {"policyId": policy_id},
        )

    def detach_policy(self, role_id: str, policy_id: str) -> dict:
        return self._req(
            "DELETE",
            f"/v1/roles/{quote(role_id, safe='')}/policies/{quote(policy_id, safe='')}",
        )

    def role_policies(self, role_id: str) -> Any:
        return self._req("GET", f"/v1/roles/{quote(role_id, safe='')}/policies")

    def assign_role(self, user_id: str, role_id: str) -> dict:
        return self._req(
            "POST", f"/v1/users/{quote(user_id, safe='')}/assign", {"roleId": role_id}
        )

    def unassign_role(self, user_id: str, role_id: str) -> dict:
        return self._req(
            "DELETE",
            f"/v1/users/{quote(user_id, safe='')}/roles/{quote(role_id, safe='')}",
        )

    def user_roles(self, user_id: str) -> Any:
        return self._req("GET", f"/v1/users/{quote(user_id, safe='')}/roles")

    def simulate(
        self, documents: list, action: str, resource: str, context: dict | None = None
    ) -> dict:
        return self._req(
            "POST",
            "/v1/authorize/dry-run",
            {
                "documents": documents,
                "action": action,
                "resource": resource,
                "context": context,
            },
        )

    def list_audit(self, limit: int = 50, actor: str | None = None) -> list:
        params: dict[str, Any] = {"limit": limit}
        if actor:
            params["actor"] = actor
        return self._req("GET", f"/v1/audit?{urlencode(params)}")

    def create_api_key(
        self, account_id: str, name: str = "default", scopes: list | None = None
    ) -> dict:
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/keys",
            {"name": name, "scopes": scopes or ["*"]},
        )

    def revoke_api_key(self, key_id: str) -> dict:
        return self._req("DELETE", f"/v1/keys/{quote(key_id, safe='')}")

    def list_api_keys(self, account_id: str) -> Any:
        """List key metadata (id/prefix only — never secret values)."""
        return self._req("GET", f"/v1/accounts/{quote(account_id, safe='')}/keys")

    def verify_api_key(self, api_key: str) -> dict:
        """Check a raw API key via the internal verify endpoint."""
        return self._req("POST", "/v1/keys/verify", {"apiKey": api_key})

    def call(self, method: str, path: str, body: Any | None = None) -> Any:
        """Generic escape hatch (forward-compat with endpoints added after this SDK).

        method is e.g. 'GET'/'POST'/'PUT'/'DELETE'; path must start with '/'.
        """
        verb = (method or "GET").upper()
        if not path.startswith("/"):
            path = "/" + path
        if verb in ("GET", "HEAD"):
            return self._req(verb, path)
        return self._req(verb, path, body)

    # ---- credentials (account-scoped secrets; PROPOSED contract — backend in progress) ----
    # Backend contract (dev1, pending): secrets are encrypted at rest and NEVER
    # returned — create/rotate accept a ``secret`` once; list/get return metadata
    # only: {id, name, type, accountId, expiresAt, version}.
    # ``type`` is one of bearer|basic|apiKey|oauth2 (passed through, not validated
    # client-side, so future types keep working).
    def create_credential(
        self,
        account_id: str,
        name: str,
        type: str,
        secret: str,
        expires_at: str | None = None,
    ) -> dict:
        """Store an account credential (secret is write-only, never returned)."""
        body: dict = {"name": name, "type": type, "secret": secret}
        if expires_at:
            body["expiresAt"] = expires_at
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/credentials",
            body,
        )

    def list_credentials(self, account_id: str) -> list:
        """List credential metadata for an account (never secret values)."""
        return self._req(
            "GET", f"/v1/accounts/{quote(account_id, safe='')}/credentials"
        )

    def get_credential(self, cred_id: str) -> dict:
        """Fetch one credential's metadata (never the secret)."""
        return self._req("GET", f"/v1/credentials/{quote(cred_id, safe='')}")

    def delete_credential(self, cred_id: str) -> dict:
        """Delete a credential."""
        return self._req("DELETE", f"/v1/credentials/{quote(cred_id, safe='')}")

    def rotate_credential(self, cred_id: str, secret: str) -> dict:
        """Rotate a credential's secret (bumps version; old secret stops working)."""
        return self._req(
            "POST",
            f"/v1/credentials/{quote(cred_id, safe='')}/rotate",
            {"secret": secret},
        )

    def create_service_account(
        self, account_id: str, slug: str, description: str = ""
    ) -> dict:
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/service-accounts",
            {"slug": slug, "description": description},
        )

    def list_service_accounts(self, account_id: str) -> list:
        return self._req(
            "GET", f"/v1/accounts/{quote(account_id, safe='')}/service-accounts"
        )

    def list_roles(self, account_id: str) -> list:
        return self._req("GET", f"/v1/accounts/{quote(account_id, safe='')}/roles")

    def create_role(self, account_id: str, slug: str, description: str = "") -> dict:
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/roles",
            {"slug": slug, "description": description},
        )

    def delete_role(self, role_id: str) -> dict:
        return self._req("DELETE", f"/v1/roles/{quote(role_id, safe='')}")

    def list_policies(self, account_id: str) -> list:
        return self._req("GET", f"/v1/accounts/{quote(account_id, safe='')}/policies")

    def create_policy(
        self, account_id: str, slug: str, document: dict, description: str = ""
    ) -> dict:
        return self._req(
            "POST",
            f"/v1/accounts/{quote(account_id, safe='')}/policies",
            {"slug": slug, "document": document, "description": description},
        )

    def delete_policy(self, policy_id: str) -> dict:
        return self._req("DELETE", f"/v1/policies/{quote(policy_id, safe='')}")

    def service_account_token(self, sa_id: str, scopes: list | None = None) -> dict:
        return self._req(
            "POST",
            f"/v1/service-accounts/{quote(sa_id, safe='')}/token",
            {"scopes": scopes or ["*"]},
        )

    # ---- workflows ----
    def list_templates(self) -> Any:
        return self._req("GET", "/v1/templates")

    def get_template(self, name: str) -> Any:
        """Fetch a single built-in template definition by name."""
        return self._req("GET", f"/v1/templates/{quote(name, safe='')}")

    def get_workflow(self, wf_id: str) -> Any:
        return self._req("GET", f"/v1/workflows/{quote(wf_id, safe='')}")

    def activate_workflow(self, wf_id: str) -> Any:
        return self._req("POST", f"/v1/workflows/{quote(wf_id, safe='')}/activate")

    def deactivate_workflow(self, wf_id: str) -> Any:
        return self._req("POST", f"/v1/workflows/{quote(wf_id, safe='')}/deactivate")

    def execute_workflow(self, wf_id: str, payload: dict | None = None) -> Any:
        """Trigger a manual execution (local engine)."""
        return self._req(
            "POST", f"/v1/workflows/{quote(wf_id, safe='')}/execute", payload or {}
        )

    def list_workflows(self) -> Any:
        return self._req("GET", "/v1/workflows")

    def create_workflow_from_template(
        self, template: str, name: str | None = None
    ) -> Any:
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
        raise SynapseDXError("synapsedx webhook: path required")
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
        raise SynapseDXError(f"synapsedx network /webhook/{clean}: {e}") from e
    try:
        r.raise_for_status()
    except Exception as e:
        raise SynapseDXError(
            f"synapsedx {r.status_code} /webhook/{clean}: {r.text[:500]}"
        ) from e
    if not r.text:
        return None
    try:
        return r.json()
    except ValueError:
        return r.text
