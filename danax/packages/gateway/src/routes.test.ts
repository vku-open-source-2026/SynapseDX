/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findRoute, expandEnv, propagatePrincipal, RouteRule } from './index';

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
    const req: any = { headers: { 'x-olp-user': 'mallory', 'x-olp-kind': 'user' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-olp-user'], undefined);
    assert.equal(req.headers['x-olp-kind'], undefined);
  });
  it('writes verified jwt principal', () => {
    const req: any = {
      headers: { 'x-olp-user': 'mallory' },
      principal: { type: 'jwt', sub: 'u1', org: 'o1', scopes: ['a', 'b'] },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-olp-user'], 'u1');
    assert.equal(req.headers['x-olp-org'], 'o1');
    assert.equal(req.headers['x-olp-scopes'], 'a,b');
    assert.equal(req.headers['x-olp-kind'], 'user');
  });
  it('writes apikey kind', () => {
    const req: any = { headers: {}, principal: { type: 'apikey' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-olp-kind'], 'apikey');
  });
  it('writes verified apikey account+scopes', () => {
    const req: any = { headers: {}, principal: { type: 'apikey', account: 'a1', scopes: ['x', 'y'] } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-olp-account'], 'a1');
    assert.equal(req.headers['x-olp-scopes'], 'x,y');
  });
});

describe('expandEnv', () => {
  it('uses env when set, default otherwise', () => {
    process.env.OLP_TEST_VAR = 'from-env';
    assert.equal(expandEnv('${OLP_TEST_VAR:http://default}'), 'from-env');
    delete process.env.OLP_TEST_VAR;
    assert.equal(expandEnv('${OLP_TEST_VAR:http://default}'), 'http://default');
  });
});
