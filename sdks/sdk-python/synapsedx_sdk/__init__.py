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
        # scopes omitted -> the server delegates the caller's own scopes (never
        # widens to '*'). Pass an explicit list to narrow the minted token.
        body = {} if scopes is None else {"scopes": scopes}
        return self._req(
            "POST",
            f"/v1/service-accounts/{quote(sa_id, safe='')}/token",
            body,
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

    # ---- LDS (linked-data service) ----
    def list_lds_licenses(self) -> list:
        """List licenses available for datasources ({id, name, url, openData})."""
        return self._req("GET", "/v1/lds/licenses")

    def list_lds_datasources(
        self, org_id: str | None = None, account_id: str | None = None
    ) -> list:
        """List datasources, optionally filtered by org and/or account."""
        params: dict[str, Any] = {}
        if org_id:
            params["orgId"] = org_id
        if account_id:
            params["accountId"] = account_id
        qs = f"?{urlencode(params)}" if params else ""
        return self._req("GET", f"/v1/lds/datasources{qs}")

    def create_lds_datasource(
        self,
        name: str,
        entity_type: str,
        license: str,
        slug: str | None = None,
        license_url: str | None = None,
        contexts: list | None = None,
        default_visibility: str | None = None,
        description: str | None = None,
        org_id: str | None = None,
        account_id: str | None = None,
    ) -> dict:
        """Create a datasource (name/entityType/license required).

        Only the optional fields passed (not None) are sent to the API.
        """
        body: dict = {"name": name, "entityType": entity_type, "license": license}
        if slug is not None:
            body["slug"] = slug
        if license_url is not None:
            body["licenseUrl"] = license_url
        if contexts is not None:
            body["contexts"] = contexts
        if default_visibility is not None:
            body["defaultVisibility"] = default_visibility
        if description is not None:
            body["description"] = description
        if org_id is not None:
            body["orgId"] = org_id
        if account_id is not None:
            body["accountId"] = account_id
        return self._req("POST", "/v1/lds/datasources", body)

    def get_lds_datasource(self, ds_id: str) -> dict:
        """Fetch a datasource with its attributes and stats."""
        return self._req("GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}")

    def update_lds_datasource(
        self,
        ds_id: str,
        name: str | None = None,
        slug: str | None = None,
        entity_type: str | None = None,
        license: str | None = None,
        license_url: str | None = None,
        contexts: list | None = None,
        default_visibility: str | None = None,
        description: str | None = None,
        org_id: str | None = None,
        account_id: str | None = None,
    ) -> dict:
        """Patch a datasource; only the fields passed (not None) are sent."""
        patch: dict = {}
        if name is not None:
            patch["name"] = name
        if slug is not None:
            patch["slug"] = slug
        if entity_type is not None:
            patch["entityType"] = entity_type
        if license is not None:
            patch["license"] = license
        if license_url is not None:
            patch["licenseUrl"] = license_url
        if contexts is not None:
            patch["contexts"] = contexts
        if default_visibility is not None:
            patch["defaultVisibility"] = default_visibility
        if description is not None:
            patch["description"] = description
        if org_id is not None:
            patch["orgId"] = org_id
        if account_id is not None:
            patch["accountId"] = account_id
        return self._req("PATCH", f"/v1/lds/datasources/{quote(ds_id, safe='')}", patch)

    def delete_lds_datasource(self, ds_id: str) -> dict:
        """Delete a datasource."""
        return self._req("DELETE", f"/v1/lds/datasources/{quote(ds_id, safe='')}")

    def get_lds_datasource_attributes(self, ds_id: str) -> list:
        """List a datasource's attribute definitions."""
        return self._req(
            "GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}/attributes"
        )

    def set_lds_datasource_attributes(self, ds_id: str, attributes: list) -> Any:
        """Replace a datasource's attribute definitions.

        Each attribute is {name, ngsiLdType?, visibility?, description?,
        sourceField?} (passed through, not validated client-side).
        """
        return self._req(
            "PUT",
            f"/v1/lds/datasources/{quote(ds_id, safe='')}/attributes",
            {"attributes": attributes},
        )

    def ingest_lds_records(self, ds_id: str, records: Any) -> dict:
        """Ingest one record or many into a datasource.

        ``records`` may be a single record dict, a bare list of records
        (wrapped as ``{"records": [...]}``), or a pre-wrapped
        ``{"records": [...]}`` body. Returns
        {ingested, created, updated, quarantined, entities}.
        """
        body = {"records": records} if isinstance(records, list) else records
        return self._req(
            "POST", f"/v1/lds/datasources/{quote(ds_id, safe='')}/records", body
        )

    def list_lds_entities(
        self,
        ds_id: str,
        limit: int | None = None,
        offset: int | None = None,
        visibility: str | None = None,
    ) -> list:
        """List a datasource's NGSI-LD entities.

        limit is 1..500; visibility is 'public' or 'restricted' (both
        passed through, not validated client-side).
        """
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        if visibility:
            params["visibility"] = visibility
        qs = f"?{urlencode(params)}" if params else ""
        return self._req(
            "GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}/entities{qs}"
        )

    def get_lds_entity(self, ds_id: str, entity_id: str) -> dict:
        """Fetch one NGSI-LD entity of a datasource."""
        return self._req(
            "GET",
            f"/v1/lds/datasources/{quote(ds_id, safe='')}/entities/"
            f"{quote(entity_id, safe='')}",
        )

    def get_lds_datasource_stats(self, ds_id: str) -> dict:
        """Fetch a datasource's ingestion stats."""
        return self._req("GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}/stats")


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
