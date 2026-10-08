/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { findRoute, expandEnv, propagatePrincipal, RouteRule, createApp, verifyApiKeyUpstream } from './index';

const routes: RouteRule[] = [
  { path: '/v1/auth', target: 'http://iam:4001', auth: 'none' },
  { path: '/v1/orgs', target: 'http://iam:4001', auth: 'either' },
  { path: '/v1/workflows', target: 'http://workflow:4002', auth: 'either' },
];

describe('findRoute', () => {
  it('exact match', () => {
    assert.equal(findRoute(routes, '/v1/orgs')?.path, '/v1/orgs');
  });
  it('subpath match', () => {
    assert.equal(findRoute(routes, '/v1/auth/login')?.path, '/v1/auth');
  });
  it('no false prefix (/v1/organizations != /v1/orgs)', () => {
    assert.equal(findRoute(routes, '/v1/organizations'), undefined);
  });
  it('unknown path', () => {
    assert.equal(findRoute(routes, '/nope'), undefined);
  });
  it('longest prefix wins', () => {
    const rs: RouteRule[] = [
      ...routes,
      { path: '/v1/workflows', target: 'x', auth: 'either' },
    ];
    assert.equal(findRoute(rs, '/v1/workflows/123/execute')?.target, 'http://workflow:4002');
  });
});

describe('propagatePrincipal', () => {
  it('strips spoofed headers when no principal', () => {
    const req: any = { headers: { 'x-synapsedx-user': 'mallory', 'x-synapsedx-kind': 'user', 'x-synapsedx-internal': 'forged' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapsedx-user'], undefined);
    assert.equal(req.headers['x-synapsedx-kind'], undefined);
    // Without SYNAPSEDX_INTERNAL_SECRET (test env), nothing is (re-)set.
    assert.equal(req.headers['x-synapsedx-internal'], undefined);
  });
  it('writes verified jwt principal', () => {
    const req: any = {
      headers: { 'x-synapsedx-user': 'mallory' },
      principal: { type: 'jwt', sub: 'u1', org: 'o1', scopes: ['a', 'b'] },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapsedx-user'], 'u1');
    assert.equal(req.headers['x-synapsedx-org'], 'o1');
    assert.equal(req.headers['x-synapsedx-scopes'], 'a,b');
    assert.equal(req.headers['x-synapsedx-kind'], 'user');
  });
  it('writes apikey kind', () => {
    const req: any = { headers: {}, principal: { type: 'apikey' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapsedx-kind'], 'apikey');
  });
  it('writes verified apikey account+scopes', () => {
    const req: any = { headers: {}, principal: { type: 'apikey', account: 'a1', scopes: ['x', 'y'] } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-synapsedx-account'], 'a1');
    assert.equal(req.headers['x-synapsedx-scopes'], 'x,y');
  });
});

describe('expandEnv', () => {
  it('uses env when set, default otherwise', () => {
    process.env.SYNAPSEDX_TEST_VAR = 'from-env';
    assert.equal(expandEnv('${SYNAPSEDX_TEST_VAR:http://default}'), 'from-env');
    delete process.env.SYNAPSEDX_TEST_VAR;
    assert.equal(expandEnv('${SYNAPSEDX_TEST_VAR:http://default}'), 'http://default');
  });
});

describe('gateway hardening (live boot)', () => {  let base = '';
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

  it('health carries security headers', async () => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  it('protected routes reject anonymous callers', async () => {
    const r = await fetch(base + '/v1/orgs');
    assert.equal(r.status, 401);
  });
  it('unknown routes are 404 with request-id echo', async () => {
    const r = await fetch(base + '/no-such-route');
    assert.equal(r.status, 404);
    assert.ok(r.headers.get('x-request-id'));
  });
});

describe('verifyApiKeyUpstream', () => {  it('forwards the internal secret so IAM accepts the check', async () => {
    let seenInternal: string | null = null;
    const iam = (await import('node:http')).createServer((req, res) => {
      seenInternal = (req.headers['x-synapsedx-internal'] as string) || null;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ valid: true, account_id: 'a1', scopes: ['*'] }));
      });
    });
    await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
    try {
      const addr = iam.address();
      const iamBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const out = await verifyApiKeyUpstream('k', iamBase, 's3cret');
      assert.deepEqual(out, { account_id: 'a1', scopes: ['*'] });
      assert.equal(seenInternal, 's3cret');
      const out2 = await verifyApiKeyUpstream('k', iamBase, undefined);
      assert.ok(out2);
    } finally {
      await new Promise<void>((resolve) => iam.close(() => resolve()));
    }
  });
  it('returns null on invalid key / unreachable IAM', async () => {
    const deny = (await import('node:http')).createServer((req, res) => {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ valid: false }));
    });
    await new Promise<void>((resolve) => deny.listen(0, '127.0.0.1', resolve));
    try {
      const addr = deny.address();
      const iamBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      assert.equal(await verifyApiKeyUpstream('bad', iamBase), null);
    } finally {
      await new Promise<void>((resolve) => deny.close(() => resolve()));
    }
    await assert.rejects(() => verifyApiKeyUpstream('k', 'http://127.0.0.1:1', undefined), /iam_unreachable/);
  });
});

describe('routes.yaml validation', () => {
  it('createApp fails fast on unknown auth mode', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')), 'routes.yaml');
    fs.writeFileSync(tmp, 'routes:\n  - path: /v1/x\n    target: http://x:1\n    auth: bogus\n');
    const prev = process.env.GATEWAY_ROUTES_PATH;
    process.env.GATEWAY_ROUTES_PATH = tmp;
    try {
      assert.throws(() => createApp(), /invalid auth mode/);
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_ROUTES_PATH;
      else process.env.GATEWAY_ROUTES_PATH = prev;
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  });
});
