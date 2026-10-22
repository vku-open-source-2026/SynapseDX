import hashlib
import math
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel

from .config import Settings, settings


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: Optional[str] = None
    dimensions: Optional[int] = None


class EmbeddingItem(BaseModel):
    object: str = "embedding"
    index: int
    embedding: List[float]


class EmbeddingUsage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class EmbeddingResponse(BaseModel):
    object: str = "list"
    data: List[EmbeddingItem]
    model: str
    usage: EmbeddingUsage


class EmbeddingEngine:
    """Self-hosted lightweight embedding service (default: sentence-transformers/all-MiniLM-L6-v2)."""

    def __init__(self, cfg: Optional[Settings] = None):
        self.cfg = cfg or settings
        self.model_name = self.cfg.EMBEDDING_MODEL_NAME
        self.dimension = self.cfg.EMBEDDING_DIM
        self._model = None
        self._is_loaded = False
        self._load_error: Optional[str] = None

    def _determine_device(self) -> str:
        dev = self.cfg.INFERENCE_DEVICE.lower()
        if dev in ("cuda", "cpu"):
            return dev
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            return "cpu"

    def load_model(self) -> bool:
        """Attempt to load the model into memory. Returns True if real model is loaded."""
        if self._is_loaded:
            return True
        if self.cfg.INFERENCE_MOCK_MODELS:
            return False

        try:
            from sentence_transformers import SentenceTransformer

            device = self._determine_device()
            self._model = SentenceTransformer(self.model_name, device=device)
            self._is_loaded = True
            self._load_error = None
            return True
        except Exception as e:
            self._load_error = str(e)
            self._is_loaded = False
            return False

    def _generate_mock_embedding(self, text: str, dim: int = 384) -> List[float]:
        """Generate a deterministic 384-dimensional unit-normalized vector for testing/offline use."""
        # Seeded pseudo-random vector based on sha256 of text
        h = hashlib.sha256(text.encode("utf-8")).digest()
        vec = []
        for i in range(dim):
            byte_val = h[i % len(h)]
            # Mix with index to create variation across dimensions
            val = ((byte_val ^ ((i * 7) & 0xFF)) - 128) / 128.0
            vec.append(val)

        # L2 normalize
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [round(x / norm, 6) for x in vec]

    def embed(
        self, inputs: Union[str, List[str]], model_override: Optional[str] = None
    ) -> EmbeddingResponse:
        texts = [inputs] if isinstance(inputs, str) else inputs
        if not texts:
            texts = [""]

        model_to_report = model_override or self.model_name
        target_dim = self.dimension

        vectors: List[List[float]] = []
        prompt_tokens = 0

        # Try real model if available
        if not self._is_loaded and not self.cfg.INFERENCE_MOCK_MODELS:
            self.load_model()

        if self._is_loaded and self._model is not None:
            try:
                embeddings = self._model.encode(texts, convert_to_numpy=True)
                for emb in embeddings:
                    vec = [float(x) for x in emb.tolist()]
                    vectors.append(vec)
            except Exception as e:
                # Fallback to mock if runtime failure occurs
                self._load_error = str(e)
                vectors = [self._generate_mock_embedding(t, target_dim) for t in texts]
        else:
            vectors = [self._generate_mock_embedding(t, target_dim) for t in texts]

        # Calculate approximate token count (~4 chars per token)
        for t in texts:
            prompt_tokens += max(1, len(t) // 4)

        data = [
            EmbeddingItem(index=idx, embedding=vec) for idx, vec in enumerate(vectors)
        ]

        return EmbeddingResponse(
            data=data,
            model=model_to_report,
            usage=EmbeddingUsage(
                prompt_tokens=prompt_tokens, total_tokens=prompt_tokens
            ),
        )

    @property
    def status(self) -> Dict[str, Any]:
        return {
            "model": self.model_name,
            "dimension": self.dimension,
            "loaded": self._is_loaded,
            "device": self._determine_device(),
            "mock_mode": self.cfg.INFERENCE_MOCK_MODELS or not self._is_loaded,
            "error": self._load_error,
        }


# Global singleton instance
embedding_engine = EmbeddingEngine()
