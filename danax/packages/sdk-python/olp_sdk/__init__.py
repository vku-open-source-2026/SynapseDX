# Copyright 2026 OLP Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""OLP Python SDK — gateway + IAM + workflow client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional
import requests


class OlpError(Exception):
    """Mọi lỗi SDK đều là OlpError (network hoặc HTTP)."""


@dataclass
class OlpClient:
    base_url: str
    token: Optional[str] = None
    api_key: Optional[str] = None
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

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        try:
            r = requests.request(method, self.base_url + path, json=body, headers=self._headers(), timeout=self.timeout)
        except Exception as e:  # network, DNS, timeout...
            raise OlpError(f"OLP network {path}: {e}") from e
        try:
            r.raise_for_status()
        except Exception as e:
            raise OlpError(f"OLP {r.status_code} {path}: {r.text[:500]}") from e
        return r.json() if r.text else None

    # ---- auth ----
    def login(self, email: str, org_slug: str = "acme") -> dict:
        return self._req("POST", "/v1/auth/login", {"email": email, "orgSlug": org_slug})

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
        return self._req("POST", "/v1/orgs", {"slug": slug, "displayName": display_name})

    def create_account(self, org_id: str, slug: str, display_name: str) -> dict:
        return self._req("POST", f"/v1/orgs/{org_id}/accounts", {"slug": slug, "displayName": display_name})

    def create_user(self, org_id: str, email: str, display_name: str | None = None) -> dict:
        return self._req("POST", f"/v1/orgs/{org_id}/users", {"email": email, "displayName": display_name})

    def list_users(self, org_id: str) -> list:
        return self._req("GET", f"/v1/orgs/{org_id}/users")

    # ---- iam ----
    def authorize(self, user_id: str, action: str, resource: str, context: dict | None = None) -> dict:
        return self._req("POST", "/v1/authorize", {"userId": user_id, "action": action, "resource": resource, "context": context})

    def attach_policy(self, role_id: str, policy_id: str) -> dict:
        return self._req("POST", f"/v1/roles/{role_id}/attach", {"policyId": policy_id})

    def assign_role(self, user_id: str, role_id: str) -> dict:
        return self._req("POST", f"/v1/users/{user_id}/assign", {"roleId": role_id})

    def simulate(self, documents: list, action: str, resource: str, context: dict | None = None) -> dict:
        return self._req("POST", "/v1/authorize/dry-run", {"documents": documents, "action": action, "resource": resource, "context": context})

    def list_audit(self, limit: int = 50, actor: str | None = None) -> list:
        qs = f"?limit={limit}" + (f"&actor={actor}" if actor else "")
        return self._req("GET", f"/v1/audit{qs}")

    def create_api_key(self, account_id: str, name: str = "default", scopes: list | None = None) -> dict:
        return self._req("POST", f"/v1/accounts/{account_id}/keys", {"name": name, "scopes": scopes or ["*"]})

    def revoke_api_key(self, key_id: str) -> dict:
        return self._req("DELETE", f"/v1/keys/{key_id}")

    def create_service_account(self, account_id: str, slug: str, description: str = "") -> dict:
        return self._req("POST", f"/v1/accounts/{account_id}/service-accounts", {"slug": slug, "description": description})

    def list_service_accounts(self, account_id: str) -> list:
        return self._req("GET", f"/v1/accounts/{account_id}/service-accounts")

    def list_roles(self, account_id: str) -> list:
        return self._req("GET", f"/v1/accounts/{account_id}/roles")

    def create_role(self, account_id: str, slug: str, description: str = "") -> dict:
        return self._req("POST", f"/v1/accounts/{account_id}/roles", {"slug": slug, "description": description})

    def delete_role(self, role_id: str) -> dict:
        return self._req("DELETE", f"/v1/roles/{role_id}")

    def list_policies(self, account_id: str) -> list:
        return self._req("GET", f"/v1/accounts/{account_id}/policies")

    def create_policy(self, account_id: str, slug: str, document: dict, description: str = "") -> dict:
        return self._req("POST", f"/v1/accounts/{account_id}/policies", {"slug": slug, "document": document, "description": description})

    def delete_policy(self, policy_id: str) -> dict:
        return self._req("DELETE", f"/v1/policies/{policy_id}")

    def service_account_token(self, sa_id: str, scopes: list | None = None) -> dict:
        return self._req("POST", f"/v1/service-accounts/{sa_id}/token", {"scopes": scopes or ["*"]})

    # ---- workflows ----
    def list_templates(self) -> Any:
        return self._req("GET", "/v1/templates")

    def get_workflow(self, wf_id: str) -> Any:
        return self._req("GET", f"/v1/workflows/{wf_id}")

    def activate_workflow(self, wf_id: str) -> Any:
        return self._req("POST", f"/v1/workflows/{wf_id}/activate")

    def list_workflows(self) -> Any:
        return self._req("GET", "/v1/workflows")

    def create_workflow_from_template(self, template: str, name: str | None = None) -> Any:
        return self._req("POST", "/v1/workflows", {"template": template, "name": name})
