import math
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Ensure src is on python path for direct imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.config import settings
from src.main import app

client = TestClient(app)

TEST_SECRET = "test-internal-secret-999"


def auth_headers():
    secret = settings.SYNAPSEDX_INTERNAL_SECRET or TEST_SECRET
    return {"x-synapsedx-internal": secret, "Content-Type": "application/json"}


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["service"] == "inference"
    assert "models" in data
    assert data["models"]["decision"] == "vllm-sr/Decision-2.0-Eos-0.8B"
    assert "sentence-transformers" in data["models"]["embedding"]
    assert "time" in data


def test_internal_secret_auth():
    with patch.object(settings, "SYNAPSEDX_INTERNAL_SECRET", "super_secret_test_123"):
        # /health should still be public
        res_health = client.get("/health")
        assert res_health.status_code == 200

        # /v1/* without header -> 401
        res_no_auth = client.post("/v1/embeddings", json={"input": "hello"})
        assert res_no_auth.status_code == 401
        assert res_no_auth.json()["error"] == "unauthorized"

        # /v1/* with invalid header -> 401
        res_bad_auth = client.post(
            "/v1/embeddings",
            json={"input": "hello"},
            headers={"x-synapsedx-internal": "wrong_secret"},
        )
        assert res_bad_auth.status_code == 401

        # /v1/* with valid header -> 200
        res_ok = client.post(
            "/v1/embeddings",
            json={"input": "hello"},
            headers={"x-synapsedx-internal": "super_secret_test_123"},
        )
        assert res_ok.status_code == 200


def test_embeddings_single_and_batch():
    # 1. Single text
    res = client.post(
        "/v1/embeddings", json={"input": "Test embedding"}, headers=auth_headers()
    )
    assert res.status_code == 200
    body = res.json()
    assert body["object"] == "list"
    assert len(body["data"]) == 1
    emb0 = body["data"][0]["embedding"]
    assert len(emb0) == 384
    # Check L2 norm is ~1.0
    norm = math.sqrt(sum(x * x for x in emb0))
    assert abs(norm - 1.0) < 0.01

    # 2. Batch input
    res_batch = client.post(
        "/v1/embeddings",
        json={"input": ["First text", "Second text", "Third text"]},
        headers=auth_headers(),
    )
    assert res_batch.status_code == 200
    batch_body = res_batch.json()
    assert len(batch_body["data"]) == 3
    for idx, item in enumerate(batch_body["data"]):
        assert item["index"] == idx
        assert len(item["embedding"]) == 384


def test_decision_system_one():
    payload = {
        "state": "The order arrived damaged yesterday. The customer has a receipt and asks for a replacement today.",
        "questions": {
            "route": {
                "type": "choice",
                "instructions": "Which team should handle this request?",
                "criteria": {
                    "returns": "Refunds, replacements and damaged deliveries",
                    "billing": "Payments, invoices and charges",
                    "technical": "Product setup and faults",
                },
            },
            "has_receipt": {
                "type": "noul",
                "instructions": "Does the customer have a receipt?",
            },
        },
    }

    res = client.post("/v1/decision", json=payload, headers=auth_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["model"] == "vllm-sr/Decision-2.0-Eos-0.8B"
    assert "route" in data["results"]
    assert "has_receipt" in data["results"]
    # Check route question
    route_res = data["results"]["route"]
    assert route_res["best_choice"] == "returns"
    assert "returns" in route_res["probabilities"]
    # Probabilities should sum to approximately 1.0
    total_p = sum(route_res["probabilities"].values())
    assert abs(total_p - 1.0) < 0.05

    # Check noul question
    receipt_res = data["results"]["has_receipt"]
    assert receipt_res["answer"] == "yes"


def test_decision_route_helper():
    payload = {
        "input": "Where can I configure webhook nodes and trigger executions?",
        "instruction": "Route to the best service module.",
        "choices": {
            "workflow": "Creating, automating, and triggering DAG workflows",
            "iam": "User roles, permissions, and session tokens",
            "billing": "Invoices, pricing tiers, and credit cards",
        },
    }
    res = client.post("/v1/decision/route", json=payload, headers=auth_headers())
    assert res.status_code == 200
    data = res.json()
    assert data["best_choice"] == "workflow"
    assert data["confidence"] > 0.4
    assert "workflow" in data["probabilities"]
    assert "iam" in data["probabilities"]


def test_chat_completions_missing_key():
    with patch.object(settings, "OPENROUTER_API_KEY", ""):
        res = client.post(
            "/v1/chat/completions",
            json={
                "messages": [{"role": "user", "content": "Hello"}],
            },
            headers=auth_headers(),
        )
        assert res.status_code == 503
        assert "OPENROUTER_API_KEY" in res.json()["message"]


@pytest.mark.asyncio
async def test_chat_completions_mocked():
    mock_resp = {
        "id": "gen-12345",
        "object": "chat.completion",
        "created": 1700000000,
        "model": "liquid/lfm-2.5-2.6b:free",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "I am SynapseDX AI."},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18},
    }

    with patch.object(settings, "OPENROUTER_API_KEY", "mock_key"):
        with patch(
            "src.main.call_chat_completion", new=AsyncMock(return_value=mock_resp)
        ):
            res = client.post(
                "/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": "Who are you?"}],
                },
                headers=auth_headers(),
            )
            assert res.status_code == 200
            data = res.json()
            assert data["id"] == "gen-12345"
            assert data["choices"][0]["message"]["content"] == "I am SynapseDX AI."
