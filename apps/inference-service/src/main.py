import secrets
import time
from datetime import datetime, timezone

from fastapi import FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .config import settings
from .decision import DecisionRequest, RouteRequest, decision_engine
from .embedding import EmbeddingRequest, embedding_engine
from .llm import (
    ChatCompletionRequest,
    LlmError,
    call_chat_completion,
    stream_chat_completion,
)

VERSION = "0.7.0"

app = FastAPI(
    title="Synapse Inference Engine",
    description="Multi-model inference microservice (OpenRouter LLM + Local Embedding + Decision-2.0-Eos-0.8B)",
    version=VERSION,
    docs_url="/docs",
    redoc_url=None,
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_and_telemetry_middleware(request: Request, call_next):
    # 1. Propagate or generate X-Request-ID
    req_id = request.headers.get("x-request-id")
    if not req_id:
        req_id = f"{int(time.time() * 1000):x}-{secrets.token_hex(4)}"

    # 2. Defense-in-depth: check SYNAPSEONE_INTERNAL_SECRET on /v1/*
    internal_secret = settings.SYNAPSEONE_INTERNAL_SECRET
    if request.url.path.startswith("/v1/"):
        if internal_secret:
            incoming_secret = request.headers.get("x-synapseone-internal", "")
            if not secrets.compare_digest(incoming_secret, internal_secret):
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={
                        "error": "unauthorized",
                        "message": "Missing or invalid internal credential",
                    },
                    headers={"x-request-id": req_id},
                )
        elif settings.is_production:
            return JSONResponse(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                content={
                    "error": "misconfigured",
                    "message": "internal secret required in production",
                },
                headers={"x-request-id": req_id},
            )

    response: Response = await call_next(request)

    # 3. Security headers
    response.headers["x-request-id"] = req_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"

    return response


@app.get("/health")
@app.get("/v1/inference/health")
async def health():
    """Health check endpoint reporting readiness of inference subsystems."""
    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "status": "ok",
        "service": "inference",
        "version": VERSION,
        "models": {
            "llm": settings.OPENROUTER_MODEL,
            "embedding": settings.EMBEDDING_MODEL_NAME,
            "decision": settings.DECISION_MODEL_NAME,
        },
        "components": {
            "llm": {
                "provider": "openrouter",
                "configured": bool(settings.OPENROUTER_API_KEY),
                "base_url": settings.OPENROUTER_BASE_URL,
            },
            "embedding": embedding_engine.status,
            "decision": decision_engine.status,
        },
        "time": now_iso,
    }


@app.post("/v1/chat/completions")
@app.post("/v1/inference/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """OpenAI-compatible LLM Chat Completions endpoint (proxied to OpenRouter)."""
    if req.stream:
        return StreamingResponse(
            stream_chat_completion(req),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        data = await call_chat_completion(req)
        return data
    except LlmError as e:
        return JSONResponse(
            status_code=e.status_code,
            content={"error": "llm_error", "message": e.message},
        )
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "internal_error", "message": str(e)},
        )


@app.post("/v1/embeddings")
@app.post("/v1/inference/embeddings")
async def create_embeddings(req: EmbeddingRequest):
    """OpenAI-compatible embeddings endpoint using self-hosted lightweight embedding model."""
    try:
        resp = embedding_engine.embed(inputs=req.input, model_override=req.model)
        return resp.model_dump()
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "embedding_error", "message": str(e)},
        )


@app.post("/v1/decision")
@app.post("/v1/inference/decision")
async def evaluate_decision(req: DecisionRequest):
    """Run structured question evaluation using self-hosted Decision-2.0-Eos-0.8B (system_one)."""
    try:
        resp = decision_engine.evaluate(state=req.state, questions=req.questions)
        return resp.model_dump()
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "decision_error", "message": str(e)},
        )


@app.post("/v1/decision/route")
@app.post("/v1/inference/decision/route")
async def route_decision(req: RouteRequest):
    """Workflow-friendly semantic router: pick the best branch among given candidates."""
    try:
        resp = decision_engine.route(
            input_text=req.input,
            choices=req.choices,
            instruction=req.instruction or "",
        )
        return resp.model_dump()
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "routing_error", "message": str(e)},
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
