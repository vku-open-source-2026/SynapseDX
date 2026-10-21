# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""SynapseBase client: collections, documents, queries, batch writes, atomic
counters, a change feed and typed object <-> data mapping.

The service stores raw JSON ``data``; a collection may declare a *mapping*
from logical field names to dot paths inside that data. Writes can send
``object`` (logical keys) and reads can ask ``as_view="object"`` — the service
converts in both directions. :class:`BaseCollection` is a small typed wrapper
that binds one collection to a dataclass/model so application code works with
objects instead of JSON.

Access the service through ``SynapseDXClient(...).base`` or build it directly
with a :class:`~synapsedx_sdk._http.HttpClient`.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

from ._http import UNSET, HttpClient

# ---------------------------------------------------------------------------
# mapping helpers (client-side mirror of the server's object<->data mapping)
# ---------------------------------------------------------------------------


def normalize_mapping(mapping: Any | None) -> dict[str, dict]:
    """Normalize a base mapping to ``{logical: {"path", "type", "required"}}``.

    Accepts the canonical ``{"fields": {...}}`` form as well as the shorthand
    ``{logical: "dot.path"}`` / ``{logical: {"path": ...}}`` maps.
    """
    if not mapping:
        return {}
    fields = (
        mapping.get("fields")
        if isinstance(mapping, dict) and isinstance(mapping.get("fields"), dict)
        else mapping
    )
    if not isinstance(fields, dict):
        return {}
    out: dict[str, dict] = {}
    for name, spec in fields.items():
        if isinstance(spec, str):
            out[str(name)] = {"path": spec}
        elif isinstance(spec, dict):
            out[str(name)] = dict(spec)
    return out


def _get_path(data: Any, path: str) -> Any:
    cur = data
    for key in str(path).split("."):
        if not isinstance(cur, dict) or key not in cur:
            return UNSET
        cur = cur[key]
    return cur


def _set_path(target: dict, path: str, value: Any) -> None:
    segments = str(path).split(".")
    cur = target
    for key in segments[:-1]:
        if not isinstance(cur.get(key), dict):
            cur[key] = {}
        cur = cur[key]
    cur[segments[-1]] = value


def data_to_object(data: dict | None, mapping: Any | None) -> dict:
    """Project stored ``data`` onto logical field names (empty mapping = copy)."""
    fields = normalize_mapping(mapping)
    if not fields:
        return dict(data or {})
    out: dict = {}
    for name, spec in fields.items():
        value = _get_path(data or {}, spec.get("path", ""))
        if value is not UNSET:
            out[name] = value
    return out


def object_to_data(obj: dict | None, mapping: Any | None) -> dict:
    """Project a logical object onto stored ``data`` (empty mapping = copy)."""
    fields = normalize_mapping(mapping)
    out: dict = {}
    for key, value in dict(obj or {}).items():
        spec = fields.get(key)
        _set_path(out, spec["path"] if spec else key, value)
    return out


def model_to_object(instance: Any) -> dict:
    """Convert a model instance (dataclass/class/dict) to a logical object."""
    if instance is None:
        raise ValueError("instance is required")
    if isinstance(instance, dict):
        return dict(instance)
    if dataclasses.is_dataclass(instance) and not isinstance(instance, type):
        return {
            f.name: getattr(instance, f.name)
            for f in dataclasses.fields(instance)
            if getattr(instance, f.name) is not None
        }
    if hasattr(instance, "__dict__"):
        return {
            k: v
            for k, v in vars(instance).items()
            if not k.startswith("_") and v is not None
        }
    raise TypeError("model instances must be dataclasses, plain classes or dicts")


def object_to_model(obj: dict | None, model: type | None) -> Any:
    """Build a model instance from a logical object (None model = pass through)."""
    data = dict(obj or {})
    if model is None:
        return data
    if dataclasses.is_dataclass(model):
        kwargs: dict = {}
        for f in dataclasses.fields(model):
            if f.name in data:
                kwargs[f.name] = data[f.name]
        return model(**kwargs)
    return model(**data)


# ---------------------------------------------------------------------------
# service
# ---------------------------------------------------------------------------


@dataclass
class QueryResult:
    """Result of :meth:`BaseService.query_documents` / :meth:`BaseCollection.query`."""

    items: list
    total: int
    limit: int
    offset: int
    next_cursor: str | None = None

    def __len__(self) -> int:
        return len(self.items)

    def __iter__(self):
        return iter(self.items)


class BaseService:
    """Typed methods for every ``/v1/base`` endpoint exposed by the gateway.

    The API accepts raw ``data`` (the stored JSON document) or logical
    ``object`` payloads; pass exactly one of the two on writes.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    def collection(
        self, name: str, *, model: type | None = None, mapping: Any | None = None
    ) -> BaseCollection:
        """Bind a collection name (plus optional model/mapping) for typed use."""
        return BaseCollection(self, name, model=model, mapping=mapping)

    # ---- collections ----
    def list_collections(
        self, org_id: str | None = None, account_id: str | None = None
    ) -> list:
        """List collections, optionally filtered by org and/or account."""
        params: dict[str, Any] = {}
        if org_id:
            params["orgId"] = org_id
        if account_id:
            params["accountId"] = account_id
        qs = f"?{urlencode(params)}" if params else ""
        return self._req("GET", f"/v1/base/collections{qs}")

    def create_collection(
        self,
        name: str,
        description: str | None = None,
        mapping: Any | None = None,
        org_id: str | None = None,
        account_id: str | None = None,
    ) -> dict:
        """Create a collection, optionally with an object<->data mapping."""
        body: dict = {"name": name}
        if description is not None:
            body["description"] = description
        if mapping is not None:
            body["mapping"] = mapping
        if org_id:
            body["orgId"] = org_id
        if account_id:
            body["accountId"] = account_id
        return self._req("POST", "/v1/base/collections", body)

    def get_collection(self, collection: str) -> dict:
        """Fetch a collection plus document stats."""
        return self._req("GET", f"/v1/base/collections/{quote(collection, safe='')}")

    def update_collection(
        self,
        collection: str,
        name: str | None = None,
        description: Any = UNSET,
        mapping: Any = UNSET,
    ) -> dict:
        """Patch a collection's name, description and/or mapping.

        ``description=None`` clears the description; omit it to keep the value.
        """
        patch: dict = {}
        if name is not None:
            patch["name"] = name
        if description is not UNSET:
            patch["description"] = description
        if mapping is not UNSET:
            patch["mapping"] = mapping
        return self._req(
            "PATCH", f"/v1/base/collections/{quote(collection, safe='')}", patch
        )

    def delete_collection(self, collection: str) -> dict:
        """Delete a collection and all its documents."""
        return self._req("DELETE", f"/v1/base/collections/{quote(collection, safe='')}")

    def collection_stats(self, collection: str) -> dict:
        """Fetch a collection's document stats."""
        return self._req(
            "GET", f"/v1/base/collections/{quote(collection, safe='')}/stats"
        )

    # ---- documents ----
    def create_document(
        self,
        collection: str,
        data: Any = UNSET,
        *,
        object: Any = UNSET,
        id: str | None = None,
    ) -> dict:
        """Create a document from raw ``data`` or a logical ``object``.

        Pass exactly one of ``data`` (stored JSON) and ``object`` (mapped
        logical keys); the server validates the payload against the mapping.
        """
        body = _write_body(data, object)
        if id is not None:
            body["id"] = id
        return self._req(
            "POST", f"/v1/base/collections/{quote(collection, safe='')}/documents", body
        )

    def get_document(self, collection: str, doc_id: str, as_view: str = "data") -> dict:
        """Fetch one document; ``as_view`` is 'data' or 'object'."""
        qs = f"?as={quote(as_view, safe='')}" if as_view != "data" else ""
        return self._req(
            "GET",
            f"/v1/base/collections/{quote(collection, safe='')}/documents/"
            f"{quote(doc_id, safe='')}{qs}",
        )

    def set_document(
        self,
        collection: str,
        doc_id: str,
        data: Any = UNSET,
        *,
        object: Any = UNSET,
        if_version: int | None = None,
        merge: bool = False,
    ) -> dict:
        """Create-or-replace a document (PUT).

        ``merge=True`` deep-merges ``data`` into the existing document instead
        of replacing it; ``if_version`` enables optimistic concurrency.
        """
        body = _write_body(data, object)
        if if_version is not None:
            body["ifVersion"] = if_version
        if merge:
            body["merge"] = True
        return self._req(
            "PUT",
            f"/v1/base/collections/{quote(collection, safe='')}/documents/"
            f"{quote(doc_id, safe='')}",
            body,
        )

    def update_document(
        self,
        collection: str,
        doc_id: str,
        data: Any = UNSET,
        *,
        object: Any = UNSET,
        unset: list | None = None,
        if_version: int | None = None,
    ) -> dict:
        """Patch a document (PATCH): deep-merge ``data``/``object`` and/or
        remove dot paths listed in ``unset``."""
        if data is UNSET and object is UNSET and not unset:
            raise ValueError("provide data/object and/or unset")
        body: dict = {}
        if data is not UNSET or object is not UNSET:
            body.update(_write_body(data, object))
        if unset:
            body["unset"] = list(unset)
        if if_version is not None:
            body["ifVersion"] = if_version
        return self._req(
            "PATCH",
            f"/v1/base/collections/{quote(collection, safe='')}/documents/"
            f"{quote(doc_id, safe='')}",
            body,
        )

    def delete_document(
        self, collection: str, doc_id: str, if_version: int | None = None
    ) -> dict:
        """Delete a document, optionally guarded by ``if_version``."""
        qs = f"?ifVersion={int(if_version)}" if if_version is not None else ""
        return self._req(
            "DELETE",
            f"/v1/base/collections/{quote(collection, safe='')}/documents/"
            f"{quote(doc_id, safe='')}{qs}",
        )

    # ---- query ----
    def query_documents(
        self,
        collection: str,
        where: Any = None,
        *,
        order_by: Any = None,
        limit: int | None = None,
        offset: int | None = None,
        cursor: str | None = None,
        select: list | None = None,
        as_view: str = "data",
    ) -> QueryResult:
        """Run a query: filter tree, ordering, cursor/offset pagination and
        projection.

        ``where`` accepts leaf ``{field, op, value}`` nodes, ``and``/``or``/
        ``not`` groups, arrays (implicit ``and``) and the shorthand
        ``{"status": "active", "age": {"gte": 18}}``. Metadata fields
        ``$id/$version/$createdAt/$updatedAt`` and mapping logical names are
        resolved by the service.
        """
        body: dict = {"as": as_view}
        if where is not None:
            body["where"] = where
        if order_by is not None:
            body["orderBy"] = order_by
        if limit is not None:
            body["limit"] = limit
        if offset is not None:
            body["offset"] = offset
        if cursor is not None:
            body["cursor"] = cursor
        if select is not None:
            body["select"] = select
        raw = self._req(
            "POST", f"/v1/base/collections/{quote(collection, safe='')}/query", body
        )
        return QueryResult(
            items=list(raw.get("items", [])),
            total=int(raw.get("total", 0)),
            limit=int(raw.get("limit", 0)),
            offset=int(raw.get("offset", 0)),
            next_cursor=raw.get("nextCursor"),
        )

    def list_documents(
        self, collection: str, limit: int | None = None, offset: int | None = None
    ) -> list:
        """Page through a collection's documents in id order."""
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        qs = f"?{urlencode(params)}" if params else ""
        return self._req(
            "GET",
            f"/v1/base/collections/{quote(collection, safe='')}/documents{qs}",
        )

    def increment(
        self,
        collection: str,
        doc_id: str,
        field: str,
        by: float = 1,
        if_version: int | None = None,
    ) -> dict:
        """Atomically add ``by`` to a numeric dot-path field."""
        body: dict = {"field": field, "by": by}
        if if_version is not None:
            body["ifVersion"] = if_version
        return self._req(
            "POST",
            f"/v1/base/collections/{quote(collection, safe='')}/documents/"
            f"{quote(doc_id, safe='')}/increment",
            body,
        )

    def batch(self, collection: str, operations: list) -> dict:
        """Run 1..100 create/set/update/delete/increment ops in one call.

        Each operation is ``{"op": ..., "id"?, "data"|"object"?, ...}``; the
        response reports per-op success and never fails the whole batch on a
        single bad op.
        """
        return self._req(
            "POST",
            f"/v1/base/collections/{quote(collection, safe='')}/documents:batch",
            {"operations": operations},
        )

    def changes(
        self,
        collection: str,
        since: str,
        limit: int | None = None,
        as_view: str = "data",
    ) -> dict:
        """Poll the change feed for documents updated since an ISO timestamp.

        Returns ``{changes, nextSince, hasMore}``; pass ``nextSince`` back in
        on the next call. Deletes are not emitted.
        """
        params: dict[str, Any] = {"since": since}
        if limit is not None:
            params["limit"] = limit
        if as_view != "data":
            params["as"] = as_view
        return self._req(
            "GET",
            f"/v1/base/collections/{quote(collection, safe='')}/changes?"
            f"{urlencode(params)}",
        )


def _write_body(data: Any, object: Any) -> dict:
    has_data = data is not UNSET
    has_object = object is not UNSET
    if has_data and has_object:
        raise ValueError("provide exactly one of data or object")
    if not has_data and not has_object:
        raise ValueError("provide exactly one of data or object")
    return {"data": data} if has_data else {"object": object}


# ---------------------------------------------------------------------------
# typed collection
# ---------------------------------------------------------------------------


class BaseCollection:
    """A collection bound to a service, optionally with a model + mapping.

    ``model`` is any dataclass (or plain class) whose attribute names match the
    mapping's logical field names. ``mapping`` mirrors the server-side mapping
    (``{logical: "dot.path"}`` or ``{logical: {path, type, required}}``) and is
    used for endpoints that return raw ``data`` (list/increment/changes).
    """

    def __init__(
        self,
        service: BaseService,
        name: str,
        *,
        model: type | None = None,
        mapping: Any | None = None,
    ) -> None:
        self.service = service
        self.name = name
        self.model = model
        self.mapping = normalize_mapping(mapping)

    # -- model conversion --
    def to_object(self, instance: Any) -> dict:
        """Convert a model instance (or dict) to a logical object payload."""
        return model_to_object(instance)

    def from_object(self, obj: dict | None) -> Any:
        """Convert a logical object response into a model instance."""
        return object_to_model(obj, self.model)

    def from_data(self, data: dict | None) -> Any:
        """Convert raw stored ``data`` into a model instance."""
        return object_to_model(data_to_object(data, self.mapping), self.model)

    def _doc_result(self, doc: dict) -> Any:
        """Convert a write response envelope into a model (falls back to raw)."""
        if "object" in doc:
            return self.from_object(doc.get("object"))
        if "data" in doc:
            return self.from_data(doc.get("data"))
        return doc

    # -- documents --
    def create(
        self,
        instance: Any = UNSET,
        *,
        id: str | None = None,
        data: Any = UNSET,
        object: Any = UNSET,
    ) -> Any:
        """Create a document from a model instance, logical object or raw data."""
        if instance is not UNSET:
            object = self.to_object(instance)
        doc = self.service.create_document(self.name, data, object=object, id=id)
        return self._doc_result(doc)

    def get(self, doc_id: str) -> Any:
        """Fetch one document as a model instance."""
        doc = self.service.get_document(self.name, doc_id, as_view="object")
        return self.from_object(doc.get("object"))

    def get_document(self, doc_id: str, as_view: str = "data") -> dict:
        """Fetch the raw document envelope (id/version/timestamps + data|object)."""
        return self.service.get_document(self.name, doc_id, as_view=as_view)

    def list(self, limit: int | None = None, offset: int | None = None) -> list:
        """Page through documents, converted to models via the mapping."""
        return [
            self.from_data(doc.get("data"))
            for doc in self.service.list_documents(
                self.name, limit=limit, offset=offset
            )
        ]

    def set(
        self,
        doc_id: str,
        instance: Any = UNSET,
        *,
        data: Any = UNSET,
        object: Any = UNSET,
        if_version: int | None = None,
        merge: bool = False,
    ) -> Any:
        """Create-or-replace a document from a model instance/object/data."""
        if instance is not UNSET:
            object = self.to_object(instance)
        doc = self.service.set_document(
            self.name, doc_id, data, object=object, if_version=if_version, merge=merge
        )
        return self._doc_result(doc)

    def update(
        self,
        doc_id: str,
        instance: Any = UNSET,
        *,
        data: Any = UNSET,
        object: Any = UNSET,
        unset: list | None = None,
        if_version: int | None = None,
    ) -> Any:
        """Patch a document (deep-merge instance/object/data and/or unset paths)."""
        if instance is not UNSET:
            object = self.to_object(instance)
        doc = self.service.update_document(
            self.name, doc_id, data, object=object, unset=unset, if_version=if_version
        )
        return self._doc_result(doc)

    def delete(self, doc_id: str, if_version: int | None = None) -> dict:
        """Delete a document, optionally guarded by ``if_version``."""
        return self.service.delete_document(self.name, doc_id, if_version=if_version)

    def increment(
        self,
        doc_id: str,
        field: str,
        by: float = 1,
        if_version: int | None = None,
    ) -> Any:
        """Atomically increment a numeric field, returning the updated model."""
        doc = self.service.increment(
            self.name, doc_id, field, by, if_version=if_version
        )
        return self.from_data(doc.get("data"))

    def query(
        self,
        where: Any = None,
        *,
        order_by: Any = None,
        limit: int | None = None,
        offset: int | None = None,
        cursor: str | None = None,
        select: list | None = None,
    ) -> QueryResult:
        """Query the collection and convert the page to model instances."""
        result = self.service.query_documents(
            self.name,
            where,
            order_by=order_by,
            limit=limit,
            offset=offset,
            cursor=cursor,
            select=select,
            as_view="object",
        )
        result.items = [self.from_object(item.get("object")) for item in result.items]
        return result

    def changes(self, since: str, limit: int | None = None) -> dict:
        """Poll the change feed and convert entries to model instances."""
        raw = self.service.changes(self.name, since, limit=limit, as_view="object")
        raw["changes"] = [
            {**ch, "document": self.from_object(ch.get("object"))}
            for ch in raw.get("changes", [])
        ]
        return raw

    def batch(self, operations: list) -> dict:
        """Run a batch of create/set/update/delete/increment operations."""
        return self.service.batch(self.name, operations)

    def stats(self) -> dict:
        """Fetch this collection's document stats."""
        return self.service.collection_stats(self.name)


__all__ = [
    "BaseCollection",
    "BaseService",
    "QueryResult",
    "data_to_object",
    "model_to_object",
    "normalize_mapping",
    "object_to_data",
    "object_to_model",
]
