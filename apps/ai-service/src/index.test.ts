/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0;
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { createApp } from './index';

describe('ai agent http layer', () => {
  let base = '';
  let server: Server | null = null;
  const saved: Record<string, string | undefined> = {};

  before(
    () =>
      new Promise<void>((resolve) => {
        for (const k of ['AI_API_KEY', 'SYNAPSEONE_INTERNAL_SECRET', 'NODE_ENV', 'CORS_ORIGIN', 'HSTS_ENABLED', 'AI_RATE_LIMIT']) {
          saved[k] = process.env[k];
        }
        delete process.env.AI_API_KEY; // app A: key chưa cấu hình
        process.env.SYNAPSEONE_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server = null;
    });
  });

  it('health stays public + carries security headers', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const j = (await r.json()) as { service: string; configured: boolean };
    assert.equal(j.service, 'ai');
    assert.equal(j.configured, false);
  });

  it('direct /v1/* without internal secret is rejected', async () => {
    const r = await fetch(`${base}/v1/ai/agent`, { method: 'POST' });
    assert.equal(r.status, 401);
  });

  it('gateway credential passes the gate; missing key → 503', async () => {
    const r = await fetch(`${base}/v1/ai/agent`, {
      method: 'POST',
      headers: { 'x-synapseone-internal': 'test-secret-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'list orgs' }),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, 'ai_not_configured');
  });

  it('oversized body → 413 payload_too_large (not 500)', async () => {
    const r = await fetch(`${base}/v1/ai/agent`, {
      method: 'POST',
      headers: { 'x-synapseone-internal': 'test-secret-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error, 'payload_too_large');
  });
});

describe('ai agent http layer (configured)', () => {
  let base = '';
  let server: Server | null = null;
  const saved: Record<string, string | undefined> = {};

  before(
    () =>
      new Promise<void>((resolve) => {
        for (const k of ['AI_API_KEY', 'SYNAPSEONE_INTERNAL_SECRET', 'AI_RATE_LIMIT']) {
          saved[k] = process.env[k];
        }
        process.env.AI_API_KEY = 'test-key';
        process.env.SYNAPSEONE_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server = null;
    });
  });

  it('invalid question → 400 before any LLM call', async () => {
    const r = await fetch(`${base}/v1/ai/agent`, {
      method: 'POST',
      headers: { 'x-synapseone-internal': 'test-secret-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_question');
  });

  it('missing question field → 400', async () => {
    const r = await fetch(`${base}/v1/ai/agent`, {
      method: 'POST',
      headers: { 'x-synapseone-internal': 'test-secret-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  it('non-array history → 400 before any LLM call', async () => {
    const r = await fetch(`${base}/v1/ai/agent`, {
      method: 'POST',
      headers: { 'x-synapseone-internal': 'test-secret-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'hi', history: 'nope' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_history');
  });

  it('rate limit: request over the cap → 429', async () => {
    process.env.AI_RATE_LIMIT = '5';
    try {
      const app = createApp();
      const s = app.listen(0, '127.0.0.1');
      await new Promise<void>((res) => s.once('listening', () => res()));
      const addr = s.address();
      const b = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await fetch(`${b}/v1/ai/agent`, {
          method: 'POST',
          headers: { 'x-synapseone-internal': 'test-secret-123', 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: '' }),
        });
        statuses.push(r.status);
        await r.text();
      }
      s.close();
      // limiter runs before validation: first 5 reach the 400 handler,
      // the rest are capped at 429.
      assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429, 429]);
    } finally {
      delete process.env.AI_RATE_LIMIT;
    }
  });
});
