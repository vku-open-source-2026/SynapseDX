/*
 * Copyright 2026 danax Contributors
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
    const req: any = { headers: { 'x-danax-user': 'mallory', 'x-danax-kind': 'user' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-danax-user'], undefined);
    assert.equal(req.headers['x-danax-kind'], undefined);
  });
  it('writes verified jwt principal', () => {
    const req: any = {
      headers: { 'x-danax-user': 'mallory' },
      principal: { type: 'jwt', sub: 'u1', org: 'o1', scopes: ['a', 'b'] },
    };
    propagatePrincipal(req);
    assert.equal(req.headers['x-danax-user'], 'u1');
    assert.equal(req.headers['x-danax-org'], 'o1');
    assert.equal(req.headers['x-danax-scopes'], 'a,b');
    assert.equal(req.headers['x-danax-kind'], 'user');
  });
  it('writes apikey kind', () => {
    const req: any = { headers: {}, principal: { type: 'apikey' } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-danax-kind'], 'apikey');
  });
  it('writes verified apikey account+scopes', () => {
    const req: any = { headers: {}, principal: { type: 'apikey', account: 'a1', scopes: ['x', 'y'] } };
    propagatePrincipal(req);
    assert.equal(req.headers['x-danax-account'], 'a1');
    assert.equal(req.headers['x-danax-scopes'], 'x,y');
  });
});

describe('expandEnv', () => {
  it('uses env when set, default otherwise', () => {
    process.env.DANAX_TEST_VAR = 'from-env';
    assert.equal(expandEnv('${DANAX_TEST_VAR:http://default}'), 'from-env');
    delete process.env.DANAX_TEST_VAR;
    assert.equal(expandEnv('${DANAX_TEST_VAR:http://default}'), 'http://default');
  });
});
