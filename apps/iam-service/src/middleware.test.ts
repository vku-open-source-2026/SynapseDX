/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM middleware tests — defense-in-depth gate, input validation, OIDC demo gate.
 * Boots the real Express app on an ephemeral port (memory backend, no DB).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';

let base = '';
let server: Server | null = null;

before(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp();
      server = app.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    }),
);

after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}

describe('iam defense-in-depth', () => {
  it('health is public + carries security headers', async () => {
    const r = await call('GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  it('protected routes reject anonymous direct access (dev fallback)', async () => {
    assert.equal((await call('GET', '/v1/orgs')).status, 401);
    assert.equal((await call('GET', '/v1/audit')).status, 401);
    // Unknown paths are also gated first (401, not 404) — no route-oracle for strangers.
    assert.equal((await call('GET', '/v1/workflows')).status, 401);
    // Bare /v1/auth (no subpath) stays public-routed so it 404s instead of 401.
    assert.equal((await call('GET', '/v1/auth')).status, 404);
  });

  it('login validates email + slug', async () => {
    assert.equal((await call('POST', '/v1/auth/login', { email: 'not-an-email' })).status, 400);
    assert.equal((await call('POST', '/v1/auth/login', { email: 'a@b.c', orgSlug: 'BAD SLUG!!' })).status, 400);
    const ok = await call('POST', '/v1/auth/login', { email: 'SEC@Example.COM', orgSlug: 'secorg' });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.accessToken);
    assert.equal(ok.data.user.email, 'sec@example.com'); // normalized
  });

  it('bearer token passes the dev self-auth gate', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'gate@acme.local' });
    const r = await call('GET', '/v1/orgs', undefined, { Authorization: `Bearer ${login.data.accessToken}` });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data));
  });

  it('oidc demo callback validates + honors the kill-switch', async () => {
    assert.equal((await call('POST', '/v1/auth/oidc/callback', {})).status, 400);
    assert.equal((await call('POST', '/v1/auth/oidc/callback', { email: 'bad' })).status, 400);
    process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK = 'false';
    try {
      const r = await call('POST', '/v1/auth/oidc/callback', { email: 'victim@acme.local' });
      assert.equal(r.status, 501);
      assert.equal(r.data.error, 'oidc_code_required');
    } finally {
      delete process.env.IAM_ALLOW_OIDC_DEMO_CALLBACK;
    }
    const ok = await call('POST', '/v1/auth/oidc/callback', { email: 'oidc@acme.local' });
    assert.equal(ok.status, 200);
  });

  it('keys/verify stays reachable for gateway-internal use, rejects junk', async () => {
    const r = await call('POST', '/v1/keys/verify', { apiKey: 'nope' });
    assert.equal(r.status, 401);
    assert.equal(r.data.valid, false);
  });

  it('malformed JSON body is 400 invalid_json, not 500', async () => {
    const r = await fetch(base + '/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":broken',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_json');
  });

  it('attach/assign validate references (404, not 500)', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'ref@acme.local' });
    const h = { Authorization: `Bearer ${login.data.accessToken}` };
    const missingRole = '11111111-1111-4111-8111-111111111111';
    const missingPolicy = '22222222-2222-4222-8222-222222222222';
    assert.equal((await call('POST', `/v1/roles/${missingRole}/attach`, { policyId: missingPolicy }, h)).status, 404);
    assert.equal((await call('POST', `/v1/users/${missingRole}/assign`, { roleId: missingRole }, h)).status, 404);
    assert.equal((await call('POST', '/v1/roles/nope/attach', {}, h)).status, 400);
    assert.equal((await call('POST', '/v1/roles/nope/attach', { policyId: 'nope' }, h)).status, 400);
  });

  it('creation endpoints validate slugs/scopes', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'val@acme.local' });
    const h = { Authorization: `Bearer ${login.data.accessToken}` };
    const orgs = await call('GET', '/v1/orgs', undefined, h);
    const orgId = orgs.data[0].id;
    assert.equal((await call('POST', `/v1/accounts/${orgId}/roles`, { slug: 'BAD!!' }, h)).status, 400);
    const role = await call('POST', `/v1/accounts/${orgId}/roles`, { slug: 'ok-role' }, h);
    assert.equal(role.status, 201);
    // Single-char slugs are legitimate (e2e uses "r"/"p") — must be 201, not 400.
    const tiny = await call('POST', `/v1/accounts/${orgId}/roles`, { slug: 'r' }, h);
    assert.equal(tiny.status, 201);
    assert.equal((await call('POST', `/v1/accounts/${orgId}/keys`, { name: 'k', scopes: 'not-array' }, h)).status, 400);
    assert.equal((await call('POST', '/v1/authorize', { userId: 'u', action: 'x'.repeat(600), resource: '*' }, h)).status, 400);
  });

  it('explicit null optional fields are accepted (SDK null serialization)', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'nullok@acme.local' });
    const h = { Authorization: `Bearer ${login.data.accessToken}` };
    const orgs = await call('GET', '/v1/orgs', undefined, h);
    const orgId = orgs.data[0].id;
    // Python SDK sends displayName=None -> JSON null; must be 201, not 400.
    const u = await call('POST', `/v1/orgs/${orgId}/users`, { email: 'nulluser@acme.local', displayName: null }, h);
    assert.equal(u.status, 201);
    assert.equal(u.data.email, 'nulluser@acme.local');
    const r = await call('POST', '/v1/auth/login', { email: 'nulllogin@acme.local', orgSlug: null });
    assert.equal(r.status, 200);
  });
});
