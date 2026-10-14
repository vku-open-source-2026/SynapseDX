/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0;
 */
// Two-step agent for API testing:
//   1. DECISION model (cheap/fast) picks the endpoint from the catalog.
//   2. LLM generates the path params + JSON body for that endpoint.
// Both outputs are UNTRUSTED: everything is validated against the catalog
// before it leaves the service (fail-closed — a bad model reply becomes a
// 502 error, never a malformed call).

import { CATALOG, CatalogEndpoint } from './catalog';
import { chatJson, chatComplete, ChatFn, ChatCall, LlmConfig, LlmError, stripFences } from './llm';

export type ChatTextFn = (cfg: LlmConfig, call: ChatCall) => Promise<string>;

export class AgentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AgentConfig {
  decision: LlmConfig;
  llm: LlmConfig;
  /** Different-provider fallback for the generate/guide steps (free-tier
   *  providers flake per-model; a second provider is usually up). Used only
   *  after the primary exhausts its retries. */
  llmFallback?: LlmConfig;
}

export interface AgentResult {
  ok: boolean;
  method: string;
  path: string;
  auth: string;
  pathValues: Record<string, string>;
  body?: unknown;
  explanation: string;
  reason: string;
  /** Set when the question maps to no single endpoint (how-to guidance
   *  instead of a try-it form). The console shows this text and no form. */
  guidance?: string;
}

/** Extract :param names from a path template. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

const DECISION_SYSTEM = [
  'You are an API routing decision model for the SynapseDX PaaS.',
  'Given the user question and the API catalog (JSON array), pick the SINGLE best endpoint to answer it.',
  'Reply with ONLY a JSON object: {"method":"GET|POST|PUT|DELETE","path":"<exact catalog path>","reason":"<one short sentence>"}.',
  'The method and path must match a catalog entry EXACTLY (including any :params and query string).',
  'If no endpoint fits, reply {"method":null,"path":null,"reason":"<why>"}.',
].join(' ');

const GENERATE_SYSTEM = [
  "You are an API call generator for the SynapseDX PaaS.",
  'Given the user question and the endpoint, generate the exact values to call it.',
  'Reply with ONLY a JSON object: {"pathValues":{"<param>":"<value>"},"body":{...},"explanation":"<one short sentence in the user\'s language>"}.',
  'pathValues keys must be exactly the :params in the path (empty object if none). Values must be non-empty strings, max 128 chars.',
  'body must be a JSON object matching the endpoint schema (empty object if the endpoint takes no body).',
  'Derive values from the question; use realistic placeholders (e.g. "prod", "demo@acme.local") when the question does not specify.',
].join(' ');

const GUIDE_SYSTEM = [
  'You are a helpful guide for the SynapseDX PaaS API.',
  'The user asks a general how-to question that maps to NO single endpoint.',
  'Given the API catalog (method, path, description per endpoint), answer concisely',
  "in the user's language: which endpoints to call, in what order, one short line per step.",
  'Reply with plain text (no JSON wrapper, no markdown fences around the whole answer).',
].join(' ');

function findEndpoint(method: string, path: string): CatalogEndpoint | undefined {
  const clean = path.split('?')[0];
  return CATALOG.find((e) => e.method === method && (e.path === path || e.path.split('?')[0] === clean));
}

/** One LLM step with server-side step logging (docker logs) — the client
 *  only sees a generic 502, so the step name is the debugging lifeline. */
async function chatStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    console.error(`[ai] step '${name}' failed:`, (e as Error)?.message || e);
    throw e;
  }
}

const MAX_QUESTION_LEN = 2000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_STR = 128;
const MAX_EXPLANATION = 1000;
const MAX_GUIDANCE = 2000;

export async function runAgent(
  question: string,
  cfg: AgentConfig,
  chat: ChatFn = chatJson,
  chatText: ChatTextFn = chatComplete,
  history: Array<{ role: string; text: string }> = [],
): Promise<AgentResult> {
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_LEN) {
    throw new AgentError('invalid_question', `question must be 1..${MAX_QUESTION_LEN} chars`);
  }
  // Prior turns (user's own words + our validated answers) give follow-up
  // questions ("còn executions thì sao?") something to resolve against.
  // Outputs stay catalog-validated, so history can only add context.
  const convo =
    history.length === 0
      ? ''
      : `Conversation so far:\n${history
          .map((h) => `${h.role === 'user' ? 'user' : 'ai'}: ${h.text}`)
          .join('\n')}\n\n`;

  // Generate/guide steps run on the primary LLM, with a different-provider
  // fallback when it exhausts its retries (free-tier providers flake
  // per-model; the backup is usually up). Validation errors (AgentError)
  // never fall back — only transport/model failures (LlmError).
  const fb = cfg.llmFallback;
  async function genJson(call: ChatCall): Promise<any> {
    try {
      return await chatStep('generate', () => chat(cfg.llm, call));
    } catch (e: unknown) {
      if (!fb || !(e instanceof LlmError)) throw e;
      return await chatStep('generate:fallback', () => chat(fb, call));
    }
  }
  async function genText(call: ChatCall): Promise<string> {
    try {
      return await chatStep('guide', () => chatText(cfg.llm, call));
    } catch (e: unknown) {
      if (!fb || !(e instanceof LlmError)) throw e;
      return await chatStep('guide:fallback', () => chatText(fb, call));
    }
  }

  // Step 1: decision model picks the endpoint.
  // NOTE: token budget phải dư cho reasoning models (mercury/apodex viết
  // chain-of-thought trước khi trả content — budget nhỏ → content null).
  const decisionCall: ChatCall = {
    system: DECISION_SYSTEM,
    user: `${convo}Catalog:\n${JSON.stringify(CATALOG)}\n\nQuestion: ${question}`,
    maxTokens: 2048,
  };
  const decision = await chatStep('decision', () => chat(cfg.decision, decisionCall));
  const dMethod = typeof decision?.method === 'string' ? decision.method : '';
  const dPath = typeof decision?.path === 'string' ? decision.path : '';
  const dReason = typeof decision?.reason === 'string' ? decision.reason : '';
  const reason = dReason.slice(0, MAX_STR);

  // How-to question: no single endpoint fits — answer with guidance
  // instead of failing (a guidance bot must not 502 on "how do I…").
  // Plain text (not JSON): guide answers are displayed verbatim, so a
  // prose reply is the happy path, not a parse failure.
  if (!dMethod || !dPath) {
    const slim = CATALOG.map(({ method, path, desc }) => ({ method, path, desc }));
    const raw = await genText({
      system: GUIDE_SYSTEM,
      user: `${convo}Catalog:\n${JSON.stringify(slim)}\n\nQuestion: ${question}`,
      maxTokens: 2048,
    });
    const answer = stripFences(raw).slice(0, MAX_GUIDANCE);
    if (!answer.trim()) throw new AgentError('invalid_output', 'guide model returned no answer');
    return {
      ok: true,
      method: '',
      path: '',
      auth: '',
      pathValues: {},
      explanation: answer.slice(0, MAX_EXPLANATION),
      reason,
      guidance: answer,
    };
  }

  const ep = findEndpoint(dMethod, dPath);
  if (!ep) {
    throw new AgentError(
      'endpoint_not_found',
      `no catalog endpoint matches ${dMethod} ${dPath} — ${reason || 'decision model returned an unknown endpoint'}`,
    );
  }

  // Step 2: LLM generates the concrete call.
  const genCall: ChatCall = {
    system: GENERATE_SYSTEM,
    user: [
      `${convo}Endpoint: ${ep.method} ${ep.path}`,
      `Description: ${ep.desc}`,
      `Example body: ${JSON.stringify(ep.body ?? {})}`,
      `Question: ${question}`,
    ].join('\n'),
    maxTokens: 2048,
  };
  const gen = await genJson(genCall);

  // Validate pathValues: keys must be exactly the path params — no extras,
  // no missing (a form missing a required :param can never be tried).
  const params = pathParams(ep.path);
  const pv = gen?.pathValues;
  if (pv == null) throw new AgentError('invalid_output', 'missing pathValues');
  if (typeof pv !== 'object' || Array.isArray(pv)) {
    throw new AgentError('invalid_output', 'pathValues must be an object');
  }
  const pathValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(pv as Record<string, unknown>)) {
    if (!params.includes(k)) {
      throw new AgentError(
        'invalid_output',
        `pathValues key '${k}' is not a path param of ${ep.path} (expected: ${params.join(', ') || 'none'})`,
      );
    }
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_STR) {
      throw new AgentError('invalid_output', `pathValues['${k}'] must be a non-empty string ≤${MAX_STR} chars`);
    }
    pathValues[k] = v.trim();
  }
  const missing = params.filter((p) => !(p in pathValues));
  if (missing.length) {
    throw new AgentError('invalid_output', `pathValues missing required params of ${ep.path}: ${missing.join(', ')}`);
  }

  // Validate body: JSON object, size-capped; only for endpoints that take one.
  let body: unknown;
  if (ep.method !== 'GET' || ep.body !== undefined) {
    body = gen?.body ?? {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new AgentError('invalid_output', 'body must be a JSON object');
    }
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (size > MAX_BODY_BYTES) throw new AgentError('invalid_output', `body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  const rawExplanation = (gen as Record<string, unknown>)?.explanation;
  const explanation = typeof rawExplanation === 'string' ? rawExplanation.slice(0, MAX_EXPLANATION) : '';
  return {
    ok: true,
    method: ep.method,
    path: ep.path,
    auth: ep.auth,
    pathValues,
    ...(body !== undefined ? { body } : {}),
    explanation,
    reason,
  };
}
