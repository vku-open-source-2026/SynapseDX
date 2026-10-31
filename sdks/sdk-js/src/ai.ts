/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Synapse AI client: the guidance-only API assistant (`POST /v1/ai/agent`).
 *
 * The agent maps a natural-language question to one catalogued SynapseOne
 * endpoint and returns the method/path plus a ready-to-try body. It never
 * executes the call itself — callers decide whether to run it.
 */

import { HttpClient } from './_http';

const P = '/v1/ai';

/** One prior turn of the conversation (server keeps the last 10, 500 chars each). */
export interface AiHistoryItem {
  role: 'user' | 'ai' | string;
  text: string;
}

export interface AiAgentResult {
  ok: boolean;
  method: string;
  path: string;
  auth: string;
  pathValues: Record<string, string>;
  body?: unknown;
  explanation: string;
  reason: string;
  /** Present when the question maps to no single endpoint (how-to guidance). */
  guidance?: string;
}

export class AiService {
  constructor(private readonly http: HttpClient) {}

  /**
   * Ask the API assistant a question (1..2000 chars).
   *
   * @example
   * const r = await client.ai.agent('create a workflow from a template');
   * // r.method === 'POST', r.path === '/v1/workflows', r.body = { template: ... }
   */
  agent(question: string, history: AiHistoryItem[] = []): Promise<AiAgentResult> {
    const body: Record<string, unknown> = { question };
    if (Array.isArray(history) && history.length) body.history = history;
    return this.http.req<AiAgentResult>(`${P}/agent`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
