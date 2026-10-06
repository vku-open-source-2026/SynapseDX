/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Offline SDK tests — local echo server, no platform needed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OlpClient } from './index';

let base = '';
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastPath = '';
let server: http.Server;

before(
  () =>
    new Promise<void>((resolve) => {
      server = http
        .createServer((req, res) => {
          lastHeaders = { ...req.headers };
          lastPath = req.url || '';
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: req.url }));
        })
        .listen(0, '127.0.0.1', () => {
          const a = server.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
    }),
);

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('OlpClient', () => {
  it('trims trailing slash', () => {
    const c = new OlpClient({ baseUrl: 'http://x:8080/' });
    assert.equal((c as any).baseUrl, 'http://x:8080');
  });

  it('sends Bearer token', async () => {
    const c = new OlpClient({ baseUrl: base });
    c.setToken('tok123');
    await c.listOrgs();
    assert.equal(lastHeaders['authorization'], 'Bearer tok123');
    assert.equal(lastPath, '/v1/orgs');
  });

  it('sends X-API-Key', async () => {
    const c = new OlpClient({ baseUrl: base, apiKey: 'k1' });
    await c.listTemplates();
    assert.equal(lastHeaders['x-api-key'], 'k1');
  });

  it('throws rich error on non-2xx', async () => {
    const bad = new OlpClient({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(() => bad.listOrgs(), /OLP/);
  });
});
