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


__all__ = ["SynapseDXClient", "SynapseDXError"]


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
        return r.json() if r.text else None

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

    def assign_role(self, user_id: str, role_id: str) -> dict:
        return self._req(
            "POST", f"/v1/users/{quote(user_id, safe='')}/assign", {"roleId": role_id}
        )

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

    def verify_api_key(self, api_key: str) -> dict:
        """Check a raw API key via the internal verify endpoint."""
        return self._req("POST", "/v1/keys/verify", {"apiKey": api_key})

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
        """Trigger a manual execution (proxied to the engine)."""
        return self._req(
            "POST", f"/v1/workflows/{quote(wf_id, safe='')}/execute", payload or {}
        )

    def list_workflows(self) -> Any:
        return self._req("GET", "/v1/workflows")

    def create_workflow_from_template(
        self, template: str, name: str | None = None
    ) -> Any:
        return self._req("POST", "/v1/workflows", {"template": template, "name": name})

    def create_workflow(self, name: str, definition: dict) -> Any:
        """Create a workflow from a raw n8n definition."""
        return self._req(
            "POST", "/v1/workflows", {"name": name, "definition": definition}
        )

    def list_executions(self, query: str = "") -> Any:
        """Proxy the engine execution list (e.g. query='limit=20')."""
        q = query if not query or query.startswith("?") else f"?{query}"
        return self._req("GET", f"/v1/executions{q}")

    def get_execution(self, exec_id: str) -> Any:
        return self._req("GET", f"/v1/executions/{quote(exec_id, safe='')}")
