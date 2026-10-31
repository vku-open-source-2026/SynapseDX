# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Synapse Faststore client: Redis-backed cache/KV with strings, hashes,
lists, sets, sorted sets, TTLs, counters, scans, batches and distributed locks.

Every operation is scoped to the caller's tenant: org-wide when the caller has
an org, else account-wide, else per user. Platform callers must set the tenant
explicitly (``SynapseOneClient(..., tenant="acme")`` -> ``x-synapseone-tenant``).

Access the service through ``SynapseOneClient(...).faststore`` or build it
directly with a :class:`~synapseone_sdk._http.HttpClient`.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from ._http import HttpClient, SynapseOneError

_P = "/v1/faststore"


class FaststoreService:
    """Typed methods for every ``/v1/faststore`` endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    @staticmethod
    def _key(key: str) -> str:
        return quote(str(key), safe="")

    # ---- stats / scans ----
    def stats(self) -> dict:
        """Fetch tenant stats (key count and counts per value type)."""
        return self._req("GET", f"{_P}/stats")

    def list_keys(
        self,
        prefix: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict:
        """Scan the tenant's keys; returns ``{keys, cursor, truncated}``.

        ``keys`` entries carry ``{key, type, ttlSeconds}``. Pass the returned
        ``cursor`` back in to continue the scan (None = end).
        """
        params: dict[str, Any] = {}
        if prefix:
            params["prefix"] = prefix
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        qs = f"?{urlencode(params)}" if params else ""
        return self._req("GET", f"{_P}/keys{qs}")

    def exists(self, key: str) -> bool:
        """True when the key exists (404 is mapped to False, other errors raise)."""
        try:
            self.get(key)
            return True
        except SynapseOneError as e:
            if e.status == 404:
                return False
            raise

    # ---- key/value ----
    def get(self, key: str) -> dict:
        """Fetch a key: ``{key, type, value, ttlSeconds}``."""
        return self._req("GET", f"{_P}/keys/{self._key(key)}")

    def set(
        self,
        key: str,
        value: Any,
        ttl_seconds: int | None = None,
        if_not_exists: bool = False,
        if_exists: bool = False,
    ) -> dict:
        """Set a string value; ``ttl_seconds`` 0 clears the TTL.

        ``if_not_exists`` (NX) and ``if_exists`` (XX) make the write conditional
        and are mutually exclusive.
        """
        body: dict = {"value": value}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        if if_not_exists:
            body["ifNotExists"] = True
        if if_exists:
            body["ifExists"] = True
        return self._req("PUT", f"{_P}/keys/{self._key(key)}", body)

    def delete(self, key: str) -> dict:
        """Delete a key (any type); returns ``{key, deleted}``."""
        return self._req("DELETE", f"{_P}/keys/{self._key(key)}")

    def ttl(self, key: str) -> dict:
        """Fetch the remaining TTL: ``{key, ttlSeconds}`` (-1 = no expiry)."""
        return self._req("GET", f"{_P}/keys/{self._key(key)}/ttl")

    def expire(self, key: str, ttl_seconds: int) -> dict:
        """Set/replace a key's TTL in seconds (0 removes the TTL)."""
        return self._req(
            "POST", f"{_P}/keys/{self._key(key)}/expire", {"ttlSeconds": ttl_seconds}
        )

    def incr(self, key: str, by: int = 1, ttl_seconds: int | None = None) -> dict:
        """Atomically increment a numeric key; returns ``{key, value}``."""
        body: dict = {"by": by}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/keys/{self._key(key)}/incr", body)

    def batch(self, operations: list) -> dict:
        """Run 1..100 key/value ops (set/get/delete/incr/expire) in one call.

        Each op is ``{"op": ..., "key": ...}`` plus op-specific fields; the
        response reports per-op success.
        """
        return self._req("POST", f"{_P}/batch", {"operations": operations})

    # ---- hashes ----
    def hash_get(self, key: str) -> dict:
        """Fetch a whole hash: ``{key, values, ttlSeconds}``."""
        return self._req("GET", f"{_P}/hashes/{self._key(key)}")

    def hash_set(self, key: str, values: dict, ttl_seconds: int | None = None) -> dict:
        """Set 1..500 hash fields in one call."""
        body: dict = {"values": values}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("PUT", f"{_P}/hashes/{self._key(key)}", body)

    def hash_delete(self, key: str) -> dict:
        """Delete a whole hash."""
        return self._req("DELETE", f"{_P}/hashes/{self._key(key)}")

    def hash_length(self, key: str) -> dict:
        """Number of fields in a hash."""
        return self._req("GET", f"{_P}/hashes/{self._key(key)}/length")

    def hash_get_field(self, key: str, field: str) -> dict:
        """Fetch one hash field: ``{key, field, value, ttlSeconds}``."""
        return self._req(
            "GET", f"{_P}/hashes/{self._key(key)}/{quote(str(field), safe='')}"
        )

    def hash_set_field(
        self, key: str, field: str, value: Any, ttl_seconds: int | None = None
    ) -> dict:
        """Set one hash field (creates the hash when missing)."""
        body: dict = {"value": value}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req(
            "PUT", f"{_P}/hashes/{self._key(key)}/{quote(str(field), safe='')}", body
        )

    def hash_delete_field(self, key: str, field: str) -> dict:
        """Delete one hash field."""
        return self._req(
            "DELETE", f"{_P}/hashes/{self._key(key)}/{quote(str(field), safe='')}"
        )

    def hash_incr(
        self,
        key: str,
        field: str,
        by: int = 1,
        ttl_seconds: int | None = None,
    ) -> dict:
        """Atomically increment a numeric hash field."""
        body: dict = {"field": field, "by": by}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/hashes/{self._key(key)}/incr", body)

    # ---- lists ----
    def list_range(self, key: str, start: int = 0, stop: int = -1) -> dict:
        """Fetch a slice of a list (Redis semantics; -1 = last element)."""
        qs = urlencode({"start": start, "stop": stop})
        return self._req("GET", f"{_P}/lists/{self._key(key)}?{qs}")

    def list_delete(self, key: str) -> dict:
        """Delete a whole list."""
        return self._req("DELETE", f"{_P}/lists/{self._key(key)}")

    def list_push(
        self,
        key: str,
        values: list,
        side: str = "right",
        ttl_seconds: int | None = None,
    ) -> dict:
        """Push 1..1000 values to the left or right end of a list."""
        body: dict = {"values": values, "side": side}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/lists/{self._key(key)}/push", body)

    def list_pop(self, key: str, side: str = "left", count: int = 1) -> dict:
        """Pop 1..1000 values from one end; returns ``{key, side, values, length}``."""
        return self._req(
            "POST", f"{_P}/lists/{self._key(key)}/pop", {"side": side, "count": count}
        )

    def list_trim(self, key: str, start: int, stop: int) -> dict:
        """Trim a list to the [start, stop] inclusive range."""
        return self._req(
            "POST", f"{_P}/lists/{self._key(key)}/trim", {"start": start, "stop": stop}
        )

    def list_length(self, key: str) -> dict:
        """Number of elements in a list."""
        return self._req("GET", f"{_P}/lists/{self._key(key)}/length")

    # ---- sets ----
    def set_members(self, key: str) -> dict:
        """Fetch all set members: ``{key, members, card}``."""
        return self._req("GET", f"{_P}/sets/{self._key(key)}")

    def set_delete(self, key: str) -> dict:
        """Delete a whole set."""
        return self._req("DELETE", f"{_P}/sets/{self._key(key)}")

    def set_add(self, key: str, members: list, ttl_seconds: int | None = None) -> dict:
        """Add 1..1000 members; returns the number actually added + cardinality."""
        body: dict = {"members": members}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/sets/{self._key(key)}/add", body)

    def set_remove(self, key: str, members: list) -> dict:
        """Remove members; returns how many were removed + cardinality."""
        return self._req(
            "POST", f"{_P}/sets/{self._key(key)}/remove", {"members": members}
        )

    def set_contains(self, key: str, member: Any) -> dict:
        """Membership test: ``{key, member, contains}``."""
        return self._req(
            "POST", f"{_P}/sets/{self._key(key)}/contains", {"member": member}
        )

    def set_card(self, key: str) -> dict:
        """Number of set members."""
        return self._req("GET", f"{_P}/sets/{self._key(key)}/card")

    # ---- sorted sets ----
    def zset_range(
        self,
        key: str,
        start: int = 0,
        stop: int = -1,
        rev: bool = False,
        with_scores: bool = False,
    ) -> dict:
        """Fetch a score-ordered slice; ``with_scores`` returns {member, score} entries."""
        params: dict[str, Any] = {"start": start, "stop": stop}
        if rev:
            params["rev"] = "true"
        if with_scores:
            params["withScores"] = "true"
        return self._req("GET", f"{_P}/zsets/{self._key(key)}?{urlencode(params)}")

    def zset_delete(self, key: str) -> dict:
        """Delete a whole sorted set."""
        return self._req("DELETE", f"{_P}/zsets/{self._key(key)}")

    def zset_add(self, key: str, members: list, ttl_seconds: int | None = None) -> dict:
        """Add entries given as ``{"member": ..., "score": ...}`` objects."""
        body: dict = {"members": members}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/zsets/{self._key(key)}/add", body)

    def zset_incr(
        self,
        key: str,
        member: Any,
        by: float = 1,
        ttl_seconds: int | None = None,
    ) -> dict:
        """Atomically increment a member's score."""
        body: dict = {"member": member, "by": by}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/zsets/{self._key(key)}/incr", body)

    def zset_remove(self, key: str, members: list) -> dict:
        """Remove members from a sorted set."""
        return self._req(
            "POST", f"{_P}/zsets/{self._key(key)}/remove", {"members": members}
        )

    def zset_score(self, key: str, member: Any) -> dict:
        """Fetch one member's score (null score when absent)."""
        return self._req(
            "POST", f"{_P}/zsets/{self._key(key)}/score", {"member": member}
        )

    def zset_rank(self, key: str, member: Any, rev: bool = False) -> dict:
        """0-based rank of a member (rev=True for highest-score first)."""
        body: dict = {"member": member}
        if rev:
            body["rev"] = True
        return self._req("POST", f"{_P}/zsets/{self._key(key)}/rank", body)

    def zset_card(self, key: str) -> dict:
        """Number of sorted-set members."""
        return self._req("GET", f"{_P}/zsets/{self._key(key)}/card")

    # ---- distributed locks ----
    def lock_acquire(
        self,
        name: str,
        ttl_seconds: int | None = None,
        wait_ms: int = 0,
        token: str | None = None,
    ) -> dict:
        """Acquire a lock (optionally waiting up to ``wait_ms``).

        Returns ``{acquired, lock, token, ttlSeconds, expiresAt}`` on success;
        ``{acquired: False, retryAfterMs}`` when the lock is held. Keep the
        ``token`` — release/extend require it.
        """
        body: dict = {"waitMs": wait_ms}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        if token is not None:
            body["token"] = token
        return self._req(
            "POST", f"{_P}/locks/{quote(str(name), safe='')}/acquire", body
        )

    def lock_release(self, name: str, token: str) -> dict:
        """Release a lock; only the token owner can release it."""
        return self._req(
            "POST",
            f"{_P}/locks/{quote(str(name), safe='')}/release",
            {"token": token},
        )

    def lock_extend(
        self, name: str, token: str, ttl_seconds: int | None = None
    ) -> dict:
        """Extend a held lock's TTL."""
        body: dict = {"token": token}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self._req("POST", f"{_P}/locks/{quote(str(name), safe='')}/extend", body)
