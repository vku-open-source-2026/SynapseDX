# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Shared HTTP plumbing for the synapseone SDK.

Every service module (iam, workflow, lds, base, faststore, queue) talks to the
platform through one :class:`HttpClient`, which adds auth headers, the optional
platform tenant header and maps every failure (network or HTTP) to
:class:`SynapseOneError`.
"""

from __future__ import annotations

from typing import Any

import requests

# Sentinel for "argument was not provided", distinct from None (an explicit
# null must be distinguishable from "leave untouched" in partial updates).
UNSET = object()


class SynapseOneError(Exception):
    """All SDK errors surface as SynapseOneError (network or HTTP).

    ``status`` carries the HTTP status code when the failure came from a JSON
    response (None for network errors) and ``body`` carries the parsed error
    body when one was returned, so callers can branch on codes such as
    ``not_found`` or ``version_conflict``.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class HttpClient:
    """Thin request layer shared by all SynapseOne services.

    ``base_url`` points at the gateway (defaults to ``https://synapseone.space`` or
    ``SYNAPSEONE_BASE_URL``) or directly at a service origin. ``tenant`` is only
    needed by platform callers of the tenant-scoped services (faststore/queue)
    and is sent as ``x-synapseone-tenant``.
    """

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        api_key: str | None = None,
        tenant: str | None = None,
        timeout: int = 15,
    ) -> None:
        import os

        url = (
            base_url
            or os.environ.get("SYNAPSEONE_BASE_URL")
            or os.environ.get("SYNAPSEDX_BASE_URL")
            or "https://synapseone.space"
        )
        self.base_url = url.rstrip("/")
        self.token = token
        self.api_key = api_key
        self.tenant = tenant
        self.timeout = timeout

    def headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if self.api_key:
            h["X-API-Key"] = self.api_key
        if self.tenant:
            h["x-synapseone-tenant"] = self.tenant
        return h

    def request(self, method: str, path: str, body: Any | None = None) -> Any:
        try:
            r = requests.request(
                (method or "GET").upper(),
                self.base_url + path,
                json=body,
                headers=self.headers(),
                timeout=self.timeout,
            )
        except Exception as e:  # network, DNS, timeout...
            raise SynapseOneError(f"synapseone network {path}: {e}") from e
        if r.status_code >= 400:
            raise SynapseOneError(
                f"synapseone {r.status_code} {path}: {r.text[:500]}",
                status=r.status_code,
                body=_try_json(r),
            )
        if not r.text:
            return None
        try:
            return r.json()
        except ValueError:
            return r.text  # non-JSON body (parity with JS SDK text fallback)


def _try_json(r: Any) -> Any:
    try:
        return r.json()
    except ValueError:
        return None
