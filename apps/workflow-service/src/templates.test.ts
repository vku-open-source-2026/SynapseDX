/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { buildTemplate, listTemplates, createApp, findWebhookPath } from './index';

describe('workflow templates', () => {
  it('lists 3 built-in templates', () => {
    assert.equal(listTemplates().length, 3);
  });
  it('builds known templates', () => {
    for (const t of listTemplates()) {
      const def: any = buildTemplate(t.name, 'demo');
      assert.ok(def.nodes.length >= 2, t.name);
      assert.ok(def.connections, t.name);
    }
  });
  it('unknown template returns null', () => {
    assert.equal(buildTemplate('nope'), null);
  });
});

describe('workflow internal gate', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('health stays public + carries security headers', async () => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });
  it('direct /v1/* without internal secret is rejected', async () => {
    const r = await fetch(base + '/v1/templates');
    assert.equal(r.status, 401);
  });
  it('gateway credential passes the gate', async () => {
    const r = await fetch(base + '/v1/templates', { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).length, 3);
  });
  it('malformed JSON body is 400 invalid_json, not 500', async () => {
    const r = await fetch(base + '/v1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: '{"name":broken',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_json');
  });
  it('explicit null name passes validation (proxies to n8n, 502 here)', async () => {
    // Python SDK serializes missing name as null — must not 400.
    const r = await fetch(base + '/v1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: JSON.stringify({ template: 'webhook-to-log', name: null }),
    });
    assert.equal(r.status, 502); // validation passed; only n8n is absent
  });
});

describe('findWebhookPath', () => {
  const hook = (path: unknown) => ({ nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { path } }, { type: 'n8n-nodes-base.noOp', parameters: {} }] });
  it('returns the first webhook trigger path', () => {
    assert.equal(findWebhookPath(hook('synapsedx-event')), 'synapsedx-event');
  });
  it('returns null without webhook nodes or nodes array', () => {
    assert.equal(findWebhookPath({ nodes: [{ type: 'n8n-nodes-base.cron', parameters: {} }] }), null);
    assert.equal(findWebhookPath({}), null);
    assert.equal(findWebhookPath(null), null);
  });
  it('rejects traversal, overlong and exotic paths', () => {
    assert.equal(findWebhookPath(hook('../secret')), null);
    assert.equal(findWebhookPath(hook('a'.repeat(129))), null);
    assert.equal(findWebhookPath(hook('x?y=z')), null);
    assert.equal(findWebhookPath(hook('')), null);
  });
});

describe('execute validation (no n8n needed)', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('CRLF id is 400 without touching n8n', async () => {
    const r = await fetch(`${base}/v1/workflows/${encodeURIComponent('a\r\nb')}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: '{}',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_id');
  });
  it('oversized execute body is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/x/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: JSON.stringify({ big: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'payload_too_large');
  });
  it('oversized execute body beyond parser limit → 413 (not 500)', async () => {
    const r = await fetch(`${base}/v1/workflows/x/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: JSON.stringify({ big: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error, 'payload_too_large');
  });
});

describe('update + id validation (no n8n needed)', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });
  const H = { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' };

  it('PUT with CRLF id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${encodeURIComponent('a\r\nb')}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: 'x' }) });
    assert.equal(r.status, 400);
  });
  it('PUT with empty body is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/x`, { method: 'PUT', headers: H, body: JSON.stringify({}) });
    assert.equal(r.status, 400);
  });
  it('PUT with SSRF definition is 400 without touching n8n', async () => {
    const r = await fetch(`${base}/v1/workflows/x`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ definition: { nodes: [{ type: 'n8n-nodes-base.httpRequest', parameters: { url: 'http://169.254.169.254/latest' } }] } }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_definition');
  });
  it('POST with both template and definition is 400', async () => {
    const r = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ template: 'webhook-to-log', definition: { nodes: [] } }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'ambiguous_source');
  });
  it('GET workflow with oversized id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${'x'.repeat(200)}`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 400);
  });
  it('executions with non-numeric limit is 400', async () => {
    const r = await fetch(`${base}/v1/executions?limit=abc`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 400);
  });
  it('DELETE workflow with CRLF id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${encodeURIComponent('a\rb')}`, {
      method: 'DELETE',
      headers: { 'x-synapsedx-internal': 'test-secret-123' },
    });
    assert.equal(r.status, 400);
  });
});
