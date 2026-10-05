# Copyright 2026 OLP Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""OLP Python SDK — gateway + IAM + workflow client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional
import requests


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
        r = requests.request(method, self.base_url + path, json=body, headers=self._headers(), timeout=self.timeout)
        r.raise_for_status()
        return r.json() if r.text else None

    # ---- auth ----
    def login(self, email: str, org_slug: str = "acme") -> dict:
        return self._req("POST", "/v1/auth/login", {"email": email, "orgSlug": org_slug})

    def verify(self) -> dict:
        return self._req("GET", "/v1/auth/verify")

    # ---- orgs ----
    def list_orgs(self) -> list:
        return self._req("GET", "/v1/orgs")

    def create_org(self, slug: str, display_name: str) -> dict:
        return self._req("POST", "/v1/orgs", {"slug": slug, "displayName": display_name})

    def create_account(self, org_id: str, slug: str, display_name: str) -> dict:
        return self._req("POST", f"/v1/orgs/{org_id}/accounts", {"slug": slug, "displayName": display_name})

    # ---- iam ----
    def authorize(self, user_id: str, action: str, resource: str) -> dict:
        return self._req("POST", "/v1/authorize", {"userId": user_id, "action": action, "resource": resource})

    def create_api_key(self, account_id: str, name: str = "default", scopes: list | None = None) -> dict:
        return self._req("POST", f"/v1/accounts/{account_id}/keys", {"name": name, "scopes": scopes or ["*"]})

    # ---- workflows ----
    def list_templates(self) -> Any:
        return self._req("GET", "/v1/templates")

    def list_workflows(self) -> Any:
        return self._req("GET", "/v1/workflows")

    def create_workflow_from_template(self, template: str, name: str | None = None) -> Any:
        return self._req("POST", "/v1/workflows", {"template": template, "name": name})
