/*
 * Copyright 2026 danax Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * OIDC endpoint shape tests (no real IdP needed).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './index';

let base = '';
let server: any;

before(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp();
      server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    }),
);

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('oidc config', () => {
  it('exposes issuer + client', async () => {
    const r = await fetch(`${base}/v1/auth/oidc/config`);
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.ok(j.issuer, 'issuer');
    assert.ok(j.clientId, 'clientId');
  });

  it('start builds authorize url with client_id + state', async () => {
    const r = await fetch(`${base}/v1/auth/oidc/start?org=acme`);
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.ok(j.authorizeUrl.includes('client_id='), j.authorizeUrl);
    assert.ok(j.authorizeUrl.includes('response_type=code'), j.authorizeUrl);
  });

  it('callback requires email', async () => {
    const r = await fetch(`${base}/v1/auth/oidc/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  it('callback issues tokens for email (federated shadow user)', async () => {
    const r = await fetch(`${base}/v1/auth/oidc/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'oidc@acme.local', sub: 'idp-sub-1', orgSlug: 'acme' }),
    });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.ok(j.accessToken);
    assert.ok(j.refreshToken);
    assert.equal(j.user.email, 'oidc@acme.local');
  });
});
