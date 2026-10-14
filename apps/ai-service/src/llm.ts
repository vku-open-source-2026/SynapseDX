/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0;
 */
// OpenAI-compatible chat client (OpenRouter, OpenAI, any /chat/completions
// endpoint). Zero-dep: global fetch (Node 18+). The API key stays
// server-side — it is NEVER sent to the browser.

export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LlmConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Extra attempts after the first try (default 2). Free-tier providers
   *  intermittently return empty content or truncated JSON — retries
   *  cover most transient failures without doubling cost. */
  retries?: number;
}

export interface ChatCall {
  system: string;
  user: string;
  maxTokens?: number;
}

export type ChatFn = (cfg: LlmConfig, call: ChatCall) => Promise<any>;

/** Strip markdown fences some models wrap JSON in. */
export function extractJson(raw: string): string {
  const t = raw.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : t).trim();
}

/** Strip fences ONLY when the whole reply is fenced (guide answers may
 *  legitimately contain fenced examples mid-text — those must be kept). */
export function stripFences(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return (m ? m[1] : t).trim();
}

const RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 4;
/** Never buffer more than this from the LLM: a misbehaving provider must
 *  not be able to OOM the service before validation even runs. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function maxAttempts(cfg: LlmConfig): number {
  const extra = cfg.retries ?? 2;
  return Math.min(Math.max(1 + Math.floor(extra), 1), MAX_ATTEMPTS);
}

/** Retryable: network errors, timeouts, upstream 5xx/429/408. Fail-fast on
 *  other 4xx (bad key, unknown model — retrying never helps). */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof LlmError)) return true;
  return e.status >= 500 || e.status === 429 || e.status === 408;
}

async function chatCompleteOnce(cfg: LlmConfig, call: ChatCall): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = cfg.timeoutMs || 20000;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: call.system },
          { role: 'user', content: call.user },
        ],
        temperature: 0.2,
        max_tokens: call.maxTokens || 1024,
      }),
    });
    const declared = Number(r.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new LlmError(502, `LLM response declares ${declared} bytes (cap ${MAX_RESPONSE_BYTES}) — dropped`);
    }
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } })?.error?.message || msg;
      } catch {
        /* keep raw text */
      }
      throw new LlmError(r.status, `LLM ${r.status}: ${msg}`);
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new LlmError(502, `LLM response exceeds ${MAX_RESPONSE_BYTES} bytes — dropped before parsing`);
    }
    const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) {
      // 502 (not r.status): an unusable provider reply is retryable.
      throw new LlmError(502, 'LLM returned no content');
    }
    return content;
  } catch (e: unknown) {
    if (e instanceof LlmError) throw e;
    const err = e as { name?: string; message?: string };
    if (err?.name === 'AbortError') throw new LlmError(504, `LLM timed out after ${timeoutMs}ms`);
    throw new LlmError(502, `LLM unreachable: ${err?.message || String(e)}`);
  } finally {
    clearTimeout(to);
  }
}

export async function chatComplete(cfg: LlmConfig, call: ChatCall): Promise<string> {
  let last: unknown = new LlmError(502, 'LLM returned no content');
  const n = maxAttempts(cfg);
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS * i);
    try {
      const content = await chatCompleteOnce(cfg, call);
      if (content.trim()) return content;
      last = new LlmError(502, 'LLM returned no content');
    } catch (e: unknown) {
      last = e;
      if (!isRetryable(e)) throw e;
    }
  }
  throw last;
}

/** chatComplete + strict JSON-object parse (models must reply with JSON).
 *  Retries cover BOTH empty content and malformed JSON (single loop —
 *  no attempt multiplication). */
export const chatJson: ChatFn = async (cfg, call) => {
  let last: unknown = new LlmError(502, 'LLM did not return valid JSON');
  const n = maxAttempts(cfg);
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS * i);
    try {
      const raw = await chatCompleteOnce(cfg, call);
      try {
        const v: unknown = JSON.parse(extractJson(raw));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
        return v;
      } catch {
        last = new LlmError(502, 'LLM did not return valid JSON');
      }
    } catch (e: unknown) {
      last = e;
      if (!isRetryable(e)) throw e;
    }
  }
  throw last;
};
