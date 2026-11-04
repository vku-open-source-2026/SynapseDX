// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * AI/inference capability over Tier-1 InferenceService and AiService.
 * Tier-3 never holds a model/provider key; Tier-2 forwards a scoped service
 * credential and returns a stable error envelope on upstream failure.
 */
import { Express } from 'express';
import { authenticate } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { serviceClient } from '../platform';

const AI_TIMEOUT_MS = 120000;

function requireString(value: unknown, field: string, max = 8000): string {
  const text = String(value ?? '').trim();
  if (!text) throw apiError(400, 'field_required', `${field} is required`, { field });
  return text.slice(0, max);
}

export function registerAiRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/ai/status', handler(async (req, res) => {
    await authenticate(req, config, true);
    const health = await serviceClient(config, AI_TIMEOUT_MS).inference.health();
    res.setHeader('cache-control', 'no-store');
    res.json({ capability: 'ai', status: health.status === 'ok' ? 'ok' : 'degraded', dependency: 'synapseone-inference', upstream: health });
  }));

  app.post('/v1/capabilities/ai/chat', handler(async (req, res) => {
    await authenticate(req, config, true);
    const body = (req.body || {}) as Record<string, unknown>;
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > 50) {
      throw apiError(400, 'invalid_request', 'messages must be an array of 1..50 chat messages');
    }
    const normalized = messages.map((message, index) => {
      const entry = (message || {}) as Record<string, unknown>;
      const role = String(entry.role || '').trim();
      if (!['system', 'user', 'assistant'].includes(role)) {
        throw apiError(400, 'invalid_request', `messages[${index}].role must be system|user|assistant`);
      }
      return { role, content: requireString(entry.content, `messages[${index}].content`) };
    });
    if (body.stream === true) {
      throw apiError(400, 'invalid_request', 'streaming responses are not supported by this route yet');
    }
    const response = await serviceClient(config, AI_TIMEOUT_MS).inference.chat(normalized as any, {
      ...(body.model ? { model: String(body.model) } : {}),
      ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: Number(body.max_tokens) } : {}),
    });
    res.setHeader('cache-control', 'no-store');
    res.json(response);
  }));

  app.post('/v1/capabilities/ai/embeddings', handler(async (req, res) => {
    await authenticate(req, config, true);
    const body = (req.body || {}) as Record<string, unknown>;
    const input = body.input;
    if (typeof input !== 'string' && !(Array.isArray(input) && input.length && input.every((item) => typeof item === 'string'))) {
      throw apiError(400, 'invalid_request', 'input must be a string or an array of strings');
    }
    const response = await serviceClient(config, AI_TIMEOUT_MS).inference.embeddings(input as any, {
      ...(body.model ? { model: String(body.model) } : {}),
    });
    res.setHeader('cache-control', 'no-store');
    res.json(response);
  }));

  app.post('/v1/capabilities/ai/decision', handler(async (req, res) => {
    await authenticate(req, config, true);
    const body = (req.body || {}) as Record<string, unknown>;
    const state = requireString(body.state, 'state');
    if (!body.questions || typeof body.questions !== 'object' || Array.isArray(body.questions)) {
      throw apiError(400, 'invalid_request', 'questions must be an object');
    }
    const response = await serviceClient(config, AI_TIMEOUT_MS).inference.decision(state, body.questions as any);
    res.setHeader('cache-control', 'no-store');
    res.json(response);
  }));

  app.post('/v1/capabilities/ai/route', handler(async (req, res) => {
    await authenticate(req, config, true);
    const body = (req.body || {}) as Record<string, unknown>;
    const input = requireString(body.input, 'input');
    if (!body.choices || typeof body.choices !== 'object' || Array.isArray(body.choices) || !Object.keys(body.choices).length) {
      throw apiError(400, 'invalid_request', 'choices must be a non-empty object of key -> description');
    }
    const response = await serviceClient(config, AI_TIMEOUT_MS).inference.route(
      input,
      body.choices as Record<string, string>,
      body.instruction !== undefined ? String(body.instruction) : undefined,
    );
    res.setHeader('cache-control', 'no-store');
    res.json(response);
  }));
}
