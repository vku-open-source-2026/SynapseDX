# Copyright 2026 SynapseDX Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""SynapseStream client: topics, produce (single & batch), consumer groups,
non-destructive reads, time-range queries and retention trimming.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

from ._http import HttpClient

_P = "/v1/stream/topics"


class StreamService:
    """Typed methods for every ``/v1/stream`` endpoint exposed by the gateway."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def _req(self, method: str, path: str, body: Any | None = None) -> Any:
        return self._http.request(method, path, body)

    @staticmethod
    def _t(topic: str) -> str:
        return quote(str(topic), safe="")

    @staticmethod
    def _g(group: str) -> str:
        return quote(str(group), safe="")

    # ---- topics ----
    def list_topics(self) -> dict:
        """List the tenant's stream topics."""
        return self._req("GET", _P)

    def create_topic(
        self,
        topic: str,
        max_len: int | None = None,
        min_id: str | None = None,
        retention_ms: int | None = None,
    ) -> dict:
        """Create or update a stream topic with optional retention caps."""
        body: dict = {}
        if max_len is not None:
            body["maxLen"] = max_len
        if min_id is not None:
            body["minId"] = min_id
        if retention_ms is not None:
            body["retentionMs"] = retention_ms
        return self._req("PUT", f"{_P}/{self._t(topic)}", body)

    def get_topic(self, topic: str) -> dict:
        """Fetch topic configuration."""
        return self._req("GET", f"{_P}/{self._t(topic)}")

    def delete_topic(self, topic: str) -> dict:
        """Delete a topic and all its events."""
        return self._req("DELETE", f"{_P}/{self._t(topic)}")

    def topic_stats(self, topic: str) -> dict:
        """Fetch topic stats (total length, first/last ID, consumer groups)."""
        return self._req("GET", f"{_P}/{self._t(topic)}/stats")

    # ---- publish ----
    def publish(
        self,
        topic: str,
        payload: Any,
        key: str | None = None,
        headers: dict | None = None,
        id: str | None = None,
    ) -> dict:
        """Publish one event to the stream topic."""
        body: dict = {"payload": payload}
        if key is not None:
            body["key"] = key
        if headers is not None:
            body["headers"] = headers
        if id is not None:
            body["id"] = id
        return self._req("POST", f"{_P}/{self._t(topic)}/events", body)

    def publish_batch(self, topic: str, events: list[dict]) -> dict:
        """Batch publish up to 100 events."""
        return self._req(
            "POST", f"{_P}/{self._t(topic)}/events:batch", {"events": events}
        )

    # ---- read / range ----
    def read(
        self,
        topic: str,
        from_id: str | None = None,
        count: int | None = None,
        block_ms: int | None = None,
    ) -> dict:
        """Non-destructive raw stream read (fan-out tailing)."""
        body: dict = {}
        if from_id is not None:
            body["fromId"] = from_id
        if count is not None:
            body["count"] = count
        if block_ms is not None:
            body["blockMs"] = block_ms
        return self._req("POST", f"{_P}/{self._t(topic)}/read", body)

    def range(
        self,
        topic: str,
        start: str | None = None,
        end: str | None = None,
        count: int | None = None,
    ) -> dict:
        """Time-range query between start and end IDs."""
        params: dict = {}
        if start is not None:
            params["start"] = start
        if end is not None:
            params["end"] = end
        if count is not None:
            params["count"] = count
        qs = urlencode(params)
        path = f"{_P}/{self._t(topic)}/range{f'?{qs}' if qs else ''}"
        return self._req("GET", path)

    # ---- consumer groups ----
    def create_group(self, topic: str, group: str, start_id: str | None = None) -> dict:
        """Create a consumer group."""
        body: dict = {}
        if start_id is not None:
            body["startId"] = start_id
        return self._req("PUT", f"{_P}/{self._t(topic)}/groups/{self._g(group)}", body)

    def destroy_group(self, topic: str, group: str) -> dict:
        """Destroy a consumer group."""
        return self._req("DELETE", f"{_P}/{self._t(topic)}/groups/{self._g(group)}")

    def read_group(
        self,
        topic: str,
        group: str,
        consumer: str = "default-worker",
        count: int | None = None,
        block_ms: int | None = None,
        auto_ack: bool | None = None,
    ) -> dict:
        """Read events through a consumer group lease."""
        body: dict = {"consumer": consumer}
        if count is not None:
            body["count"] = count
        if block_ms is not None:
            body["blockMs"] = block_ms
        if auto_ack is not None:
            body["autoAck"] = auto_ack
        return self._req(
            "POST", f"{_P}/{self._t(topic)}/groups/{self._g(group)}/read", body
        )

    def ack(self, topic: str, group: str, ids: list[str]) -> dict:
        """Acknowledge processed event IDs."""
        return self._req(
            "POST", f"{_P}/{self._t(topic)}/groups/{self._g(group)}/ack", {"ids": ids}
        )
