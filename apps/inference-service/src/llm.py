import asyncio
import json
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from pydantic import BaseModel, Field

from .config import Settings, settings


class ChatMessage(BaseModel):
    role: str
    # Assistant tool-call turns have no content; tool results are also allowed
    # to be structured. Keep this permissive and forward exactly what came in.
    content: Optional[Any] = None
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    messages: List[ChatMessage]
    model: Optional[str] = None
    temperature: Optional[float] = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=1024, ge=1, le=32768)
    stream: Optional[bool] = False
    top_p: Optional[float] = Field(default=1.0, ge=0.0, le=1.0)
    # OpenAI-compatible tool calling: the workflow AI Agent depends on these
    # fields surviving the inference hop.
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Any] = None
    parallel_tool_calls: Optional[bool] = None
    response_format: Optional[Dict[str, Any]] = None


class ChatCompletionChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: Optional[str] = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: Optional[Dict[str, int]] = None


class LlmError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _is_retryable(status_code: int) -> bool:
    return status_code >= 500 or status_code in (429, 408)


def _tool_fields(req: ChatCompletionRequest) -> Dict[str, Any]:
    """Only forward optional fields the caller actually supplied."""
    out: Dict[str, Any] = {}
    if req.tools is not None:
        out["tools"] = req.tools
    if req.tool_choice is not None:
        out["tool_choice"] = req.tool_choice
    if req.parallel_tool_calls is not None:
        out["parallel_tool_calls"] = req.parallel_tool_calls
    if req.response_format is not None:
        out["response_format"] = req.response_format
    return out


async def call_chat_completion(
    req: ChatCompletionRequest,
    cfg: Optional[Settings] = None,
) -> Dict[str, Any]:
    """Execute non-streaming chat completion through OpenRouter."""
    config = cfg or settings
    if not config.OPENROUTER_API_KEY:
        raise LlmError(503, "OPENROUTER_API_KEY is not configured on the server")

    url = f"{config.OPENROUTER_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://synapsedx.dev",
        "X-Title": "SynapseDX Inference Engine",
    }

    target_model = req.model or config.OPENROUTER_MODEL
    payload: Dict[str, Any] = {
        "model": target_model,
        "messages": [m.model_dump(exclude_none=True) for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "stream": False,
        **_tool_fields(req),
    }

    timeout_seconds = config.OPENROUTER_TIMEOUT_MS / 1000.0
    attempts = max(1, config.OPENROUTER_RETRIES + 1)
    last_err: Optional[Exception] = None

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        for attempt in range(attempts):
            try:
                resp = await client.post(url, headers=headers, json=payload)
                if resp.status_code == 200:
                    return resp.json()

                body_text = resp.text[:1000]
                if _is_retryable(resp.status_code) and attempt + 1 < attempts:
                    await asyncio.sleep(0.5 * (2**attempt))
                    continue

                raise LlmError(
                    resp.status_code,
                    f"OpenRouter upstream returned status {resp.status_code}: {body_text}",
                )
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                last_err = e
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.5 * (2**attempt))
                    continue
                raise LlmError(504, f"OpenRouter upstream connection failed: {str(e)}")

    raise last_err or LlmError(500, "Unknown LLM upstream failure")


async def stream_chat_completion(
    req: ChatCompletionRequest,
    cfg: Optional[Settings] = None,
) -> AsyncGenerator[str, None]:
    """Stream chat completion tokens from OpenRouter using Server-Sent Events (SSE)."""
    config = cfg or settings
    if not config.OPENROUTER_API_KEY:
        error_chunk = {
            "error": {
                "message": "OPENROUTER_API_KEY is not configured on the server",
                "type": "server_error",
                "code": 503,
            }
        }
        yield f"data: {json.dumps(error_chunk)}\n\n"
        yield "data: [DONE]\n\n"
        return

    url = f"{config.OPENROUTER_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://synapsedx.dev",
        "X-Title": "SynapseDX Inference Engine",
    }

    target_model = req.model or config.OPENROUTER_MODEL
    payload: Dict[str, Any] = {
        "model": target_model,
        "messages": [m.model_dump(exclude_none=True) for m in req.messages],
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "stream": True,
        **_tool_fields(req),
    }

    timeout_seconds = config.OPENROUTER_TIMEOUT_MS / 1000.0

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        try:
            async with client.stream(
                "POST", url, headers=headers, json=payload
            ) as response:
                if response.status_code != 200:
                    err_body = await response.aread()
                    err_msg = err_body.decode("utf-8", errors="replace")[:1000]
                    err_payload = {
                        "error": {
                            "message": f"Upstream error {response.status_code}: {err_msg}",
                            "code": response.status_code,
                        }
                    }
                    yield f"data: {json.dumps(err_payload)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data:"):
                        yield f"{line}\n\n"
                    else:
                        yield f"data: {line}\n\n"
        except Exception as e:
            err_payload = {
                "error": {"message": f"Streaming failed: {str(e)}", "code": 500}
            }
            yield f"data: {json.dumps(err_payload)}\n\n"
            yield "data: [DONE]\n\n"
