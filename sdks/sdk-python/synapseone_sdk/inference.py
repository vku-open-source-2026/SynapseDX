# Copyright 2026 SynapseOne Contributors
# Licensed under the Apache License, Version 2.0 (the "License");
"""Synapse Inference Engine client for Python."""

from __future__ import annotations

from typing import Any

from ._http import HttpClient

_PREFIX = "/v1/inference"


class InferenceService:
    """Namespace for Synapse Inference Engine operations."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def health(self) -> dict[str, Any]:
        """Check health and subsystem readiness of the inference engine."""
        return self._http.get(f"{_PREFIX}/health")

    def chat(
        self,
        messages: list[dict[str, str]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        stream: bool = False,
        **extra: Any,
    ) -> dict[str, Any]:
        """Run chat completions through the OpenRouter-backed LLM proxy."""
        body: dict[str, Any] = {"messages": messages, "stream": stream, **extra}
        if model is not None:
            body["model"] = model
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        return self._http.post(f"{_PREFIX}/chat/completions", body)

    def embeddings(
        self,
        inputs: str | list[str],
        model: str | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """Generate text embeddings using the self-hosted lightweight model."""
        body: dict[str, Any] = {"input": inputs, **extra}
        if model is not None:
            body["model"] = model
        return self._http.post(f"{_PREFIX}/embeddings", body)

    def decision(
        self,
        state: str,
        questions: dict[str, Any],
    ) -> dict[str, Any]:
        """Evaluate structured questions via Decision-2.0-Eos-0.8B (system_one)."""
        body = {"state": state, "questions": questions}
        return self._http.post(f"{_PREFIX}/decision", body)

    def route(
        self,
        input_text: str,
        choices: dict[str, str],
        instruction: str = "",
    ) -> dict[str, Any]:
        """Semantic route an input text between candidate choices for workflow branching."""
        body: dict[str, Any] = {"input": input_text, "choices": choices}
        if instruction:
            body["instruction"] = instruction
        return self._http.post(f"{_PREFIX}/decision/route", body)
