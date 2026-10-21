import os
from typing import Optional
from dotenv import load_dotenv

load_dotenv()


def _get_env_str(keys: list[str], default: str) -> str:
    for k in keys:
        v = os.getenv(k)
        if v is not None and v.strip() != "":
            return v.strip()
    return default


def _get_env_int(keys: list[str], default: int, min_val: int = 1, max_val: int = 300000) -> int:
    for k in keys:
        v = os.getenv(k)
        if v is not None:
            try:
                val = int(v)
                return max(min_val, min(val, max_val))
            except ValueError:
                pass
    return default


def _get_env_bool(keys: list[str], default: bool) -> bool:
    for k in keys:
        v = os.getenv(k)
        if v is not None:
            return v.strip().lower() in ("true", "1", "yes", "on")
    return default


class Settings:
    """Central configuration for Synapse Inference Engine."""

    PORT: int = _get_env_int(["PORT", "INFERENCE_PORT"], 4008, 1024, 65535)
    HOST: str = _get_env_str(["INFERENCE_HOST", "HOST"], "0.0.0.0")
    ENVIRONMENT: str = _get_env_str(["NODE_ENV", "ENVIRONMENT", "ENV"], "development")
    SYNAPSEDX_INTERNAL_SECRET: str = _get_env_str(["SYNAPSEDX_INTERNAL_SECRET"], "")

    # LLM (OpenRouter)
    OPENROUTER_BASE_URL: str = _get_env_str(
        ["OPENROUTER_BASE_URL", "AI_BASE_URL"], "https://openrouter.ai/api/v1"
    ).rstrip("/")
    OPENROUTER_API_KEY: str = _get_env_str(["OPENROUTER_API_KEY", "AI_API_KEY"], "")
    OPENROUTER_MODEL: str = _get_env_str(
        ["OPENROUTER_MODEL", "AI_LLM_MODEL"], "apodex/apodex-1.1-mini:free"
    )
    OPENROUTER_FALLBACK_MODEL: str = _get_env_str(
        ["OPENROUTER_FALLBACK_MODEL", "AI_LLM_FALLBACK_MODEL"], "inception/mercury-2.5"
    )
    OPENROUTER_TIMEOUT_MS: int = _get_env_int(
        ["OPENROUTER_TIMEOUT_MS", "AI_TIMEOUT_MS"], 30000, 1000, 300000
    )
    OPENROUTER_RETRIES: int = _get_env_int(["OPENROUTER_RETRIES", "AI_RETRIES"], 2, 0, 5)

    # Embedding Model (Self-hosted Lightweight)
    EMBEDDING_MODEL_NAME: str = _get_env_str(
        ["EMBEDDING_MODEL_NAME"], "sentence-transformers/all-MiniLM-L6-v2"
    )
    EMBEDDING_DIM: int = _get_env_int(["EMBEDDING_DIM"], 384, 16, 4096)

    # Decision Model (Self-hosted Decision-2.0-Eos-0.8B)
    DECISION_MODEL_NAME: str = _get_env_str(
        ["DECISION_MODEL_NAME"], "vllm-sr/Decision-2.0-Eos-0.8B"
    )

    # Device & Mocking
    INFERENCE_DEVICE: str = _get_env_str(["INFERENCE_DEVICE"], "auto")
    INFERENCE_MOCK_MODELS: bool = _get_env_bool(["INFERENCE_MOCK_MODELS"], False)

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() == "production"


settings = Settings()
