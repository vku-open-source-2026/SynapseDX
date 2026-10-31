# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Synapse AI client: the guidance-only API assistant (``POST /v1/ai/agent``).

The agent maps a natural-language question to one catalogued SynapseOne
endpoint and returns the method/path plus a ready-to-try body. It never
executes the call itself — callers decide whether to run it.
"""

from __future__ import annotations

from typing import Any

from ._http import HttpClient


class AiService:
    """Methods for the SynapseOne AI Assistant service (``/v1/ai``)."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def agent(
        self, question: str, history: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        """Ask the API assistant a question (1..2000 chars).

        Parameters
        ----------
        question:
            Natural language question about SynapseOne APIs.
        history:
            Optional list of prior turns (``[{"role": "user"|"ai", "text": "..."}]``).

        Returns
        -------
        dict
            Result containing ``ok``, ``method``, ``path``, ``auth``, ``pathValues``,
            ``body``, ``explanation``, ``reason``, and optional ``guidance``.
        """
        body: dict[str, Any] = {"question": question}
        if history:
            body["history"] = history
        return self._http.request("POST", "/v1/ai/agent", body)
