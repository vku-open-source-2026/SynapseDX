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
    const opts = {
      ...(body.model ? { model: String(body.model) } : {}),
      ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: Number(body.max_tokens) } : {}),
    };
    if (body.stream !== true) {
      const response = await serviceClient(config, AI_TIMEOUT_MS).inference.chat(normalized as any, opts);
      res.setHeader('cache-control', 'no-store');
      res.json(response);
      return;
    }

    // OpenAI-compatible SSE passthrough over the published SDK streaming
    // client (`inference.chatStream`). The first frame is pulled before the
    // SSE headers are committed so a refused upstream connection still gets
    // the normal JSON error envelope; after that, failures are in-band.
    const client = serviceClient(config, AI_TIMEOUT_MS);
    const abort = new AbortController();
    const onClose = (): void => { abort.abort(); };
    req.on('close', onClose);
    res.on('close', onClose);
    res.on('error', onClose);
    try {
      const iterator = client.inference.chatStream(normalized as any, { ...opts, stream: true }, {
        signal: abort.signal,
      })[Symbol.asyncIterator]();
      const first = await iterator.next();
      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      const writeFrame = (frame: { event: string; data: string }): void => {
        res.write(`event: ${frame.event}\ndata: ${frame.data}\n\n`);
      };
      if (!first.done && !res.writableEnded && !res.destroyed) writeFrame(first.value);
      for (;;) {
        if (res.writableEnded || res.destroyed) break;
        const next = await iterator.next();
        if (next.done) break;
        writeFrame(next.value);
      }
    } catch (error) {
      // Before the SSE headers are committed, failures keep the JSON envelope.
      if (!res.headersSent) throw error;
      const message = (error as Error)?.message || 'the inference stream failed';
      console.warn(`[ai] chat stream failed: ${message}`);
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: 'upstream_unavailable', message })}\n\n`);
      }
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
      res.off('error', onClose);
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        try { res.end(); } catch { /* the client already disconnected */ }
      }
    }
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
