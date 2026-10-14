# AI assistant (API testing guide)

The Console API Docs page has a floating chatbot bubble. It answers in natural
language, picks the right endpoint, and pre-fills the try-it form (path params +
JSON body) — or answers how-to questions with step-by-step guidance when no
single endpoint fits.

## How it works

Two-step agent in `apps/ai-service` (port 4003, zero-dep TypeScript like the
other services):

1. **Decision model** (`AI_DECISION_MODEL`, default `inception/mercury-2.5`)
   picks ONE endpoint from a server-side catalog (mirrors `docs/api.md`).
2. **LLM** (`AI_LLM_MODEL`, default `apodex/apodex-1.1-mini:free`) generates the
   concrete `pathValues` + JSON `body` for that endpoint.

Both outputs are untrusted: the service validates method/path against the
catalog (query strings ignored), requires every `:param` present and non-empty,
caps the body at 64KB, and slices explanations — a bad model reply becomes a
`502` (`endpoint_not_found`/`invalid_output`), never a malformed call.

Follow-up questions work: the Console sends the last turns (`history`, capped
server-side to 10×500 chars) so "còn account của nó thì sao?" resolves against
prior context. History only adds context — outputs stay catalog-validated.

Free-tier reasoning models intermittently return empty/truncated replies, so each
step retries `AI_RETRIES` times (default 2, 4xx fail fast), then falls back to a
different-provider model (`AI_LLM_FALLBACK_MODEL`, default = the decision model)
before giving up. LLM responses are capped at 256KB before parsing. The gateway
gives `/v1/ai` a dedicated 120s proxy timeout (`routes.yaml: timeoutMs`) because
retried model calls outlast the 30s global default.

## Not a public API

- The route is `auth: either` (signed-in session required; anonymous gets 401)
  plus the standard `x-synapsedx-internal` service gate — there is intentionally
  NO catalog entry in `apps/console/src/lib/endpoints.js` and NO section in
  `docs/api.md`.
- The agent catalog excludes `/v1/ai/*` (the bot cannot call itself).
- The chatbot only explains and pre-fills forms; "Try it" executes with the
  user's own session (PUT/DELETE ask for confirmation first).

## Configuration

`AI_BASE_URL` (any OpenAI-compatible `/chat/completions` endpoint),
`AI_API_KEY` (**server-side only** — never reaches the browser; unset →
`503 ai_not_configured`), `AI_TIMEOUT_MS` (default 20000, clamped 1s–300s),
`AI_RETRIES` (default 2, clamped 0–3), `AI_RATE_LIMIT` (default 30/min per
principal — model calls cost money). Full table: [configuration.md](configuration.md).
`GET /health` reports `{ configured, models }` without leaking the key.

Failures: see [troubleshooting.md](troubleshooting.md) ("Chatbot answers 502").
Step-level errors land in the service logs as `[ai] step '<name>' failed`.
