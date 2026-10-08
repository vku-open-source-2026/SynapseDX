/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { buildTemplate, listTemplates, createApp } from './index';

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
