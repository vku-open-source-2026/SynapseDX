# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""SynapseQueue client: queues, publish (delay + dedupe), at-least-once
consumption with visibility-timeout leases, ack/nack/heartbeat, retry,
dead letters and replay.

Every operation is scoped to the caller's tenant (org / account / user).
Platform callers must set the tenant explicitly
(``SynapseDXClient(..., tenant="acme")`` -> ``x-synapsedx-tenant``).

Delivery model: :meth:`QueueService.consume` leases messages for a visibility
timeout and returns a ``receipt`` per message. Call :meth:`ack` when processing
succeeds, :meth:`nack` to requeue (optionally delayed) or dead-letter, and
:meth:`heartbeat` to extend long-running leases. Leases that expire without ack
are redelivered, so consumers must be idempotent.

Access the service through ``SynapseDXClient(...).queue`` or build it directly
with a :class:`~synapsedx_sdk._http.HttpClient`.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from ._http import HttpClient

_P = "/v1/queue/queues"


class QueueService:
    """Typed methods for every ``/v1/queue`` endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    @staticmethod
    def _q(queue: str) -> str:
        return quote(str(queue), safe="")

    # ---- queues ----
    def list_queues(self) -> list:
        """List the tenant's queues with their configuration."""
        return self._req("GET", _P)

    def create_queue(
        self,
        queue: str,
        max_attempts: int | None = None,
        visibility_timeout_seconds: int | None = None,
    ) -> dict:
        """Create a queue (idempotent) with optional config.

        ``max_attempts`` (1..100, default 5) caps delivery attempts before a
        message is dead-lettered. ``visibility_timeout_seconds`` (1..3600,
        default 30) is how long a consumed message stays leased before it is
        redelivered.
        """
        body: dict = {}
        if max_attempts is not None:
            body["maxAttempts"] = max_attempts
        if visibility_timeout_seconds is not None:
            body["visibilityTimeoutSeconds"] = visibility_timeout_seconds
        return self._req("PUT", f"{_P}/{self._q(queue)}", body)

    def get_queue(self, queue: str) -> dict:
        """Fetch a queue's config plus current stats."""
        return self._req("GET", f"{_P}/{self._q(queue)}")

    def delete_queue(self, queue: str) -> dict:
        """Delete a queue and everything in it (ready, leased, dead)."""
        return self._req("DELETE", f"{_P}/{self._q(queue)}")

    def purge_queue(self, queue: str) -> dict:
        """Purge all messages (ready, delayed, leased, dead) and reset counters."""
        return self._req("POST", f"{_P}/{self._q(queue)}/purge")

    def queue_stats(self, queue: str) -> dict:
        """Fetch queue counters (pending/in-flight/dead and lifetime totals)."""
        return self._req("GET", f"{_P}/{self._q(queue)}/stats")

    # ---- publish ----
    def publish(
        self,
        queue: str,
        payload: Any,
        delay_seconds: int | None = None,
        max_attempts: int | None = None,
        headers: dict | None = None,
        id: str | None = None,
        dedupe_key: str | None = None,
    ) -> dict:
        """Publish one message; returns ``{ok, queue, id, duplicate, message}``.

        ``payload`` is any JSON value. ``delay_seconds`` makes the message
        invisible until it elapses. ``dedupe_key`` suppresses duplicates while
        the first message with that key is pending (re-publish returns
        ``duplicate: true`` and the original id).
        """
        body: dict = {"payload": payload}
        if delay_seconds is not None:
            body["delaySeconds"] = delay_seconds
        if max_attempts is not None:
            body["maxAttempts"] = max_attempts
        if headers is not None:
            body["headers"] = headers
        if id is not None:
            body["id"] = id
        if dedupe_key is not None:
            body["dedupeKey"] = dedupe_key
        return self._req("POST", f"{_P}/{self._q(queue)}/messages", body)

    def publish_batch(self, queue: str, messages: list) -> dict:
        """Publish 1..100 messages in one call.

        Each entry takes the same fields as :meth:`publish`. The response
        reports per-message success in ``results``.
        """
        return self._req(
            "POST", f"{_P}/{self._q(queue)}/messages:batch", {"messages": messages}
        )

    # ---- consume / ack / nack / heartbeat ----
    def consume(
        self,
        queue: str,
        max_messages: int | None = None,
        visibility_timeout_seconds: int | None = None,
        consumer: str | None = None,
    ) -> dict:
        """Lease up to ``max_messages`` (1..100) ready messages.

        Returns ``{queue, count, visibilityTimeoutSeconds, messages}`` where
        each message carries a ``receipt`` and ``leaseExpiresAt``. Ack/nack
        each receipt before the lease expires (or call :meth:`heartbeat`).
        """
        body: dict = {}
        if max_messages is not None:
            body["maxMessages"] = max_messages
        if visibility_timeout_seconds is not None:
            body["visibilityTimeoutSeconds"] = visibility_timeout_seconds
        if consumer is not None:
            body["consumer"] = consumer
        return self._req("POST", f"{_P}/{self._q(queue)}/consume", body)

    def ack(self, queue: str, receipt: str) -> dict:
        """Acknowledge a lease — the message is deleted."""
        return self._req("POST", f"{_P}/{self._q(queue)}/ack", {"receipt": receipt})

    def ack_many(self, queue: str, receipts: list) -> dict:
        """Acknowledge up to 100 receipts in one call (per-receipt results)."""
        return self._req("POST", f"{_P}/{self._q(queue)}/ack", {"receipts": receipts})

    def nack(
        self,
        queue: str,
        receipt: str,
        requeue: bool = True,
        delay_seconds: int | None = None,
        error: str | None = None,
    ) -> dict:
        """Reject a lease.

        ``requeue=True`` (default) makes the message available again (after
        ``delay_seconds`` when given). ``requeue=False`` dead-letters it
        immediately; otherwise a message that exceeds ``maxAttempts`` is
        dead-lettered automatically.
        """
        body: dict = {"receipt": receipt, "requeue": requeue}
        if delay_seconds is not None:
            body["delaySeconds"] = delay_seconds
        if error is not None:
            body["error"] = error
        return self._req("POST", f"{_P}/{self._q(queue)}/nack", body)

    def heartbeat(
        self, queue: str, receipt: str, visibility_timeout_seconds: int | None = None
    ) -> dict:
        """Extend a lease while a message is still being processed."""
        body: dict = {"receipt": receipt}
        if visibility_timeout_seconds is not None:
            body["visibilityTimeoutSeconds"] = visibility_timeout_seconds
        return self._req("POST", f"{_P}/{self._q(queue)}/heartbeat", body)

    # ---- inspection / dead letters ----
    def peek(self, queue: str, limit: int | None = None, ready: bool = False) -> dict:
        """Inspect messages without leasing them.

        ``ready=True`` filters out delayed and currently-leased messages.
        """
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if ready:
            params["ready"] = "true"
        qs = f"?{urlencode(params)}" if params else ""
        return self._req("GET", f"{_P}/{self._q(queue)}/messages{qs}")

    def dead_letters(self, queue: str, limit: int | None = None) -> dict:
        """List dead-lettered messages (most recent first)."""
        qs = f"?{urlencode({'limit': limit})}" if limit is not None else ""
        return self._req("GET", f"{_P}/{self._q(queue)}/dead{qs}")

    def replay_dead(
        self,
        queue: str,
        message_id: str,
        delay_seconds: int | None = None,
        reset_attempts: bool = False,
    ) -> dict:
        """Requeue a dead-lettered message, optionally after a delay.

        ``reset_attempts=True`` gives the message a fresh attempt budget.
        """
        body: dict = {}
        if delay_seconds is not None:
            body["delaySeconds"] = delay_seconds
        if reset_attempts:
            body["resetAttempts"] = True
        return self._req(
            "POST",
            f"{_P}/{self._q(queue)}/dead/{quote(str(message_id), safe='')}/replay",
            body,
        )

    def delete_dead(self, queue: str, message_id: str) -> dict:
        """Permanently delete one dead-lettered message."""
        return self._req(
            "DELETE", f"{_P}/{self._q(queue)}/dead/{quote(str(message_id), safe='')}"
        )
