# Synapse Inference Engine (`@synapsedx/inference-service`)

Multi-model inference microservice for the SynapseDX ecosystem. Provides:
1. **LLM Proxy**: OpenAI-compatible chat completions endpoint (streaming + non-streaming) backed by OpenRouter.
2. **Embedding**: Self-hosted lightweight text embedding model (`sentence-transformers/all-MiniLM-L6-v2`, 384 dimensions).
3. **Decision Model**: Self-hosted `vllm-sr/Decision-2.0-Eos-0.8B` model (0.8B parameters) for single-forward-pass routing and structured evaluations (`system_one`).

---

## API Endpoints

### 1. Health & Subsystem Status
* `GET /health`
  Returns status of LLM provider, embedding engine, and decision engine.

### 2. LLM Chat Completions (OpenRouter)
* `POST /v1/chat/completions`
  OpenAI-compatible request body:
  ```json
  {
    "model": "apodex/apodex-1.1-mini:free",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Hello!" }
    ],
    "temperature": 0.7,
    "max_tokens": 512,
    "stream": false
  }
  ```
  Supports Server-Sent Events (SSE) when `stream: true`.

### 3. Embeddings (Self-hosted Lightweight Model)
* `POST /v1/embeddings`
  OpenAI-compatible embeddings request:
  ```json
  {
    "input": "Calculate embedding vector for this workflow node.",
    "model": "sentence-transformers/all-MiniLM-L6-v2"
  }
  ```
  Returns 384-dimensional unit-norm float vector.

### 4. Decision Engine (`Decision-2.0-Eos-0.8B`)
* `POST /v1/decision` (Advanced `system_one` structured questions):
  ```json
  {
    "state": "The order arrived damaged yesterday. The customer has a receipt and asks for a replacement today.",
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "Which team should handle this request?",
        "criteria": {
          "returns": "Refunds, replacements and damaged deliveries",
          "billing": "Payments, invoices and charges",
          "technical": "Product setup and faults"
        }
      },
      "has_receipt": {
        "type": "noul",
        "instructions": "Does the customer have a receipt?"
      }
    }
  }
  ```

* `POST /v1/decision/route` (Workflow-friendly simple branch router):
  ```json
  {
    "input": "How do I create a new API key in SynapseDX?",
    "instruction": "Pick the right service for this query.",
    "choices": {
      "iam": "Identity, user management, and API credentials",
      "workflow": "Creating and managing DAG execution workflows",
      "base": "Database collections and records storage"
    }
  }
  ```
  Response:
  ```json
  {
    "best_choice": "iam",
    "confidence": 0.92,
    "probabilities": {
      "iam": 0.92,
      "workflow": 0.05,
      "base": 0.03
    },
    "model": "vllm-sr/Decision-2.0-Eos-0.8B",
    "duration_ms": 14.2
  }
  ```

---

## Configuration

| Environment Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4008` | HTTP listening port |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `OPENROUTER_API_KEY` | `""` | OpenRouter API Key |
| `OPENROUTER_MODEL` | `apodex/apodex-1.1-mini:free` | Default LLM model |
| `EMBEDDING_MODEL_NAME` | `sentence-transformers/all-MiniLM-L6-v2` | Lightweight embedding model |
| `DECISION_MODEL_NAME` | `vllm-sr/Decision-2.0-Eos-0.8B` | Self-hosted 0.8B decision model |
| `INFERENCE_DEVICE` | `auto` | `cpu` or `cuda` |
| `INFERENCE_MOCK_MODELS` | `false` | Enable deterministic fallback for test/offline environments |
| `SYNAPSEDX_INTERNAL_SECRET` | `""` | Shared secret required on `/v1/*` when set |
