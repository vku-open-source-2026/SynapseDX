# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""LDS (linked-data service) client: datasources, attributes, records,
NGSI-LD entities and licenses.

Access it through ``SynapseOneClient(...).lds`` or build it directly with a
:class:`~synapseone_sdk._http.HttpClient`.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from ._http import HttpClient


class LdsService:
    """Typed methods for every ``/v1/lds`` endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    def list_licenses(self) -> list:
        """List licenses available for datasources ({id, name, url, openData})."""
        return self._req("GET", "/v1/lds/licenses")

    def list_datasources(
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

    def create_datasource(
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

    def get_datasource(self, ds_id: str) -> dict:
        """Fetch a datasource with its attributes and stats."""
        return self._req("GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}")

    def update_datasource(
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

    def delete_datasource(self, ds_id: str) -> dict:
        """Delete a datasource."""
        return self._req("DELETE", f"/v1/lds/datasources/{quote(ds_id, safe='')}")

    def get_datasource_attributes(self, ds_id: str) -> list:
        """List a datasource's attribute definitions."""
        return self._req(
            "GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}/attributes"
        )

    def set_datasource_attributes(self, ds_id: str, attributes: list) -> Any:
        """Replace a datasource's attribute definitions.

        Each attribute is {name, ngsiLdType?, visibility?, description?,
        sourceField?} (passed through, not validated client-side).
        """
        return self._req(
            "PUT",
            f"/v1/lds/datasources/{quote(ds_id, safe='')}/attributes",
            {"attributes": attributes},
        )

    def ingest_records(self, ds_id: str, records: Any) -> dict:
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

    def list_entities(
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

    def get_entity(self, ds_id: str, entity_id: str) -> dict:
        """Fetch one NGSI-LD entity of a datasource."""
        return self._req(
            "GET",
            f"/v1/lds/datasources/{quote(ds_id, safe='')}/entities/"
            f"{quote(entity_id, safe='')}",
        )

    def get_datasource_stats(self, ds_id: str) -> dict:
        """Fetch a datasource's ingestion stats."""
        return self._req("GET", f"/v1/lds/datasources/{quote(ds_id, safe='')}/stats")
