import math
import time
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

from .config import Settings, settings


class DecisionQuestion(BaseModel):
    type: str = Field(
        description="Question type: 'choice', 'noul' (yes/no), or 'score'"
    )
    instructions: str = Field(description="Instructions or criteria for the question")
    criteria: Optional[Dict[str, str]] = Field(
        default=None,
        description="Mapping of choice key -> choice description (required for type='choice')",
    )


class DecisionRequest(BaseModel):
    state: str = Field(
        description="Context, user query, or request payload to evaluate"
    )
    questions: Dict[str, DecisionQuestion] = Field(
        description="Dictionary of question ID -> DecisionQuestion specification"
    )


class DecisionResponse(BaseModel):
    model: str
    results: Dict[str, Any]
    duration_ms: float


class RouteRequest(BaseModel):
    input: str = Field(description="The input text or query to route")
    choices: Dict[str, str] = Field(
        description="Available destination choices: { 'choice_id': 'semantic description of choice' }"
    )
    instruction: Optional[str] = Field(
        default="Select the best destination or category for this input.",
        description="Guiding instruction for the routing decision",
    )


class RouteResponse(BaseModel):
    best_choice: str
    confidence: float
    probabilities: Dict[str, float]
    model: str
    duration_ms: float


class DecisionEngine:
    """Self-hosted Decision model runner for vllm-sr/Decision-2.0-Eos-0.8B (0.8B parameters)."""

    def __init__(self, cfg: Optional[Settings] = None):
        self.cfg = cfg or settings
        self.model_name = self.cfg.DECISION_MODEL_NAME
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
        """Attempt to load the Decision-2.0-Eos-0.8B model via HuggingFace transformers."""
        if self._is_loaded:
            return True
        if self.cfg.INFERENCE_MOCK_MODELS:
            return False

        try:
            import torch
            from transformers import AutoModel

            device = self._determine_device()
            dtype = torch.bfloat16 if device == "cuda" else torch.float32

            self._model = AutoModel.from_pretrained(
                self.model_name,
                trust_remote_code=True,
                torch_dtype=dtype,
            )
            if device != "cpu" and hasattr(self._model, "to"):
                self._model = self._model.to(device)

            self._is_loaded = True
            self._load_error = None
            return True
        except Exception as e:
            self._load_error = str(e)
            self._is_loaded = False
            return False

    def _fallback_system_one(
        self, state: str, questions: Dict[str, DecisionQuestion]
    ) -> Dict[str, Any]:
        """Deterministic semantic fallback for Decision-2.0-Eos when model weights are not loaded."""
        import re

        state_lower = state.lower()
        state_tokens = set(re.findall(r"\w+", state_lower))
        results: Dict[str, Any] = {}

        for q_id, q_spec in questions.items():
            q_type = q_spec.type.lower()
            if q_type == "choice" and q_spec.criteria:
                raw_scores: Dict[str, float] = {}
                for choice_key, choice_desc in q_spec.criteria.items():
                    desc_tokens = set(re.findall(r"\w+", choice_desc.lower()))
                    # Direct token overlap
                    direct_overlap = len(
                        state_tokens.intersection(desc_tokens)
                        - {"and", "or", "the", "a", "an", "is", "of", "to", "in"}
                    )

                    # Stem/prefix overlap (e.g. trigger vs triggering, workflow vs workflows)
                    stem_overlap = 0
                    for st in state_tokens:
                        if len(st) >= 4:
                            for dt in desc_tokens:
                                if len(dt) >= 4 and (
                                    st.startswith(dt[:4]) or dt.startswith(st[:4])
                                ):
                                    stem_overlap += 1

                    # Check substring presence
                    substr_bonus = 2.5 if choice_key.lower() in state_lower else 0.0
                    raw_scores[choice_key] = (
                        1.0 + direct_overlap * 2.0 + stem_overlap * 1.5 + substr_bonus
                    )

                # Softmax normalization
                max_s = max(raw_scores.values()) if raw_scores else 1.0
                exp_scores = {k: math.exp(v - max_s) for k, v in raw_scores.items()}
                total_exp = sum(exp_scores.values()) or 1.0
                probs = {k: round(v / total_exp, 4) for k, v in exp_scores.items()}

                best_choice = max(probs, key=probs.get) if probs else ""
                results[q_id] = {
                    "type": "choice",
                    "best_choice": best_choice,
                    "probabilities": probs,
                    "confidence": probs.get(best_choice, 0.0),
                }

            elif q_type in ("noul", "yes_no", "bool"):
                positive_indicators = {
                    "yes",
                    "true",
                    "has",
                    "confirmed",
                    "verified",
                    "include",
                    "with",
                }
                negative_indicators = {
                    "no",
                    "false",
                    "none",
                    "without",
                    "missing",
                    "never",
                }
                pos_hits = sum(1 for w in positive_indicators if w in state_tokens)
                neg_hits = sum(1 for w in negative_indicators if w in state_tokens)

                prob_yes = round(0.5 + (pos_hits - neg_hits) * 0.2, 2)
                prob_yes = max(0.05, min(0.95, prob_yes))
                results[q_id] = {
                    "type": "noul",
                    "answer": "yes" if prob_yes >= 0.5 else "no",
                    "probabilities": {"yes": prob_yes, "no": round(1.0 - prob_yes, 2)},
                }
            else:
                # Default score or unsupported question type
                results[q_id] = {
                    "type": q_type,
                    "score": 0.5,
                    "note": "fallback evaluation",
                }

        return results

    def evaluate(
        self, state: str, questions: Dict[str, DecisionQuestion]
    ) -> DecisionResponse:
        t0 = time.time()

        if not self._is_loaded and not self.cfg.INFERENCE_MOCK_MODELS:
            self.load_model()

        if self._is_loaded and self._model is not None:
            try:
                # Model's native system_one interface
                # format questions dict into model's expected format
                q_dict = {
                    k: v.model_dump(exclude_none=True) for k, v in questions.items()
                }
                raw_out = self._model.system_one(state=state, questions=q_dict)
                duration = round((time.time() - t0) * 1000.0, 2)
                return DecisionResponse(
                    model=self.model_name,
                    results=raw_out
                    if isinstance(raw_out, dict)
                    else {"output": raw_out},
                    duration_ms=duration,
                )
            except Exception as e:
                self._load_error = str(e)
                # Fallback on runtime failure
                results = self._fallback_system_one(state, questions)
        else:
            results = self._fallback_system_one(state, questions)

        duration = round((time.time() - t0) * 1000.0, 2)
        return DecisionResponse(
            model=self.model_name,
            results=results,
            duration_ms=duration,
        )

    def route(
        self, input_text: str, choices: Dict[str, str], instruction: str = ""
    ) -> RouteResponse:
        """Helper to route an input text between candidate choices."""
        t0 = time.time()
        q_spec = DecisionQuestion(
            type="choice",
            instructions=instruction
            or "Select the most suitable category for the input.",
            criteria=choices,
        )
        resp = self.evaluate(state=input_text, questions={"route": q_spec})
        route_res = resp.results.get("route", {})
        probs = route_res.get("probabilities", {})

        if not probs and choices:
            # Equal uniform split
            n = len(choices)
            probs = {k: round(1.0 / n, 4) for k in choices}

        best = route_res.get("best_choice") or (
            max(probs, key=probs.get) if probs else ""
        )
        conf = probs.get(best, 0.0)

        duration = round((time.time() - t0) * 1000.0, 2)
        return RouteResponse(
            best_choice=best,
            confidence=conf,
            probabilities=probs,
            model=self.model_name,
            duration_ms=duration,
        )

    @property
    def status(self) -> Dict[str, Any]:
        return {
            "model": self.model_name,
            "architecture": "Qwen3.5-0.8B-hybrid-backbone",
            "loaded": self._is_loaded,
            "device": self._determine_device(),
            "mock_mode": self.cfg.INFERENCE_MOCK_MODELS or not self._is_loaded,
            "error": self._load_error,
        }


# Global singleton instance
decision_engine = DecisionEngine()
