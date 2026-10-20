/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Real OIDC Authorization Code flow tests — stub IdP with genuine RSA-signed
 * ID tokens (node:http, ephemeral ports). No external network.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import http from 'node:http';
import { generateKeyPairSync, createPublicKey, createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createApp } from './index';
import { __clearOidcCache } from './oidc';
import { getJwtSecret } from './tokens';

let base = '';
let server: Server | null = null;

const savedEnv: Record<string, string | undefined> = {};
for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_PROVIDER']) {
  savedEnv[k] = process.env[k];
}
function setIdp(baseUrl: string) {
  process.env.OIDC_ISSUER = `${baseUrl}/`;
  process.env.OIDC_CLIENT_ID = 'test-client';
  process.env.OIDC_CLIENT_SECRET = 'test-secret';
  process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1/cb';
  process.env.OIDC_PROVIDER = 'stub';
  __clearOidcCache();
}
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __clearOidcCache();
});

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

async function call(method: string, path: string, body?: any) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

interface Stub {
  url: string;
  close: () => Promise<void>;
}

/** Minimal OIDC provider: discovery + JWKS + token endpoint signing `alg`. */
async function startStubIdp(
  alg: 'RS256' | 'HS256',
  opts: { noEmail?: boolean; wrongIssuer?: boolean; unknownKid?: boolean; email?: string; sub?: string } = {},
): Promise<Stub> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const pubJwk: any = createPublicKey(privPem).export({ format: 'jwk' });
  pubJwk.kid = 'stub-k1';
  pubJwk.alg = 'RS256';
  pubJwk.use = 'sig';
  const srv = http.createServer((req, res) => {
    const send = (code: number, obj: any) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/.well-known/openid-configuration') {
      const iss = `http://127.0.0.1:${(srv.address() as any).port}/`;
      return send(200, {
        issuer: opts.wrongIssuer ? 'http://rogue.example/' : iss,
        authorization_endpoint: `${iss}authorize`,
        token_endpoint: `${iss}token`,
        jwks_uri: `${iss}jwks`,
      });
    }
    if (req.url === '/jwks') {
      if (opts.unknownKid) return send(200, { keys: [] });
      return send(200, { keys: [pubJwk] });
    }
    if (req.url === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const iss = `http://127.0.0.1:${(srv.address() as any).port}/`;
        const signOpts: any =
          alg === 'RS256'
            ? { algorithm: 'RS256', keyid: 'stub-k1', expiresIn: 300 }
            : { algorithm: 'HS256', expiresIn: 300 };
        // jsonwebtoken v9: sign(payload, secretOrPrivateKey, options)
        const key = alg === 'RS256' ? privPem : 'weak-shared-secret';
        const claims: any = { iss, aud: 'test-client', sub: opts.sub || 'stub-sub-1', name: 'Stub User' };
        if (!opts.noEmail) claims.email = opts.email || 'SSO@Example.COM';
        const idToken = (jwt as any).sign(claims, key, signOpts);
        send(200, { id_token: idToken, token_type: 'Bearer', expires_in: 300 });
      });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { url, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

describe('oidc authorization code flow (stub IdP)', () => {
  it('/start returns a signed state bound to the org', async () => {
    const stub = await startStubIdp('RS256');
    try {
      setIdp(stub.url);
      const r = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      assert.equal(r.status, 200);
      assert.ok(r.data.authorizeUrl.includes('/authorize'));
      assert.ok(r.data.authorizeUrl.includes(encodeURIComponent('test-client')));
      const parts = String(r.data.state).split('.');
      assert.equal(parts.length, 2); // payload.hmac (unsigned legacy states are rejected)
    } finally {
      await stub.close();
    }
  });

  it('code + state exchange mints platform tokens for the IdP identity', async () => {
    const stub = await startStubIdp('RS256');
    try {
      setIdp(stub.url);
      const start = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      const cb = await call('POST', '/v1/auth/oidc/callback', { code: 'opaque-code', state: start.data.state });
      assert.equal(cb.status, 200);
      assert.ok(cb.data.accessToken);
      assert.ok(cb.data.refreshToken);
      assert.equal(cb.data.user.email, 'sso@example.com'); // normalized from IdP claim
      // The minted token actually authenticates.
      const me = await fetch(`${base}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${cb.data.accessToken}` },
      });
      assert.equal(me.status, 200);
    } finally {
      await stub.close();
    }
  });

  it('a different IdP identity cannot join an existing org (#9)', async () => {
    const stubA = await startStubIdp('RS256');
    try {
      setIdp(stubA.url);
      const startA = await call('GET', '/v1/auth/oidc/start?org=joinsorg');
      const cbA = await call('POST', '/v1/auth/oidc/callback', { code: 'opaque-code', state: startA.data.state });
      assert.equal(cbA.status, 200); // first login founds the org
    } finally {
      await stubA.close();
    }
    const stubB = await startStubIdp('RS256', { email: 'intruder@example.com', sub: 'stub-sub-2' });
    try {
      setIdp(stubB.url);
      const startB = await call('GET', '/v1/auth/oidc/start?org=joinsorg');
      const cbB = await call('POST', '/v1/auth/oidc/callback', { code: 'opaque-code', state: startB.data.state });
      assert.equal(cbB.status, 403);
      assert.equal(cbB.data.error, 'org_membership_required');
    } finally {
      await stubB.close();
    }
  });

  it('OIDC_ALLOWED_ORGS gates which slugs can be targeted (#9)', async () => {
    process.env.OIDC_ALLOWED_ORGS = 'allowedorg';
    try {
      const stub = await startStubIdp('RS256');
      try {
        setIdp(stub.url);
        const blocked = await call('GET', '/v1/auth/oidc/start?org=otherorg');
        const r = await call('POST', '/v1/auth/oidc/callback', { code: 'opaque-code', state: blocked.data.state });
        assert.equal(r.status, 403);
        assert.equal(r.data.error, 'org_not_allowed');
        const allowed = await call('GET', '/v1/auth/oidc/start?org=allowedorg');
        const ok = await call('POST', '/v1/auth/oidc/callback', { code: 'opaque-code', state: allowed.data.state });
        assert.equal(ok.status, 200);
      } finally {
        await stub.close();
      }
    } finally {
      delete process.env.OIDC_ALLOWED_ORGS;
    }
  });

  it('code without state is rejected', async () => {
    const stub = await startStubIdp('RS256');
    try {
      setIdp(stub.url);
      const r = await call('POST', '/v1/auth/oidc/callback', { code: 'x' });
      assert.equal(r.status, 400);
      assert.equal(r.data.error, 'oidc_state_required');
    } finally {
      await stub.close();
    }
  });

  it('tampered or expired state is rejected', async () => {
    const stub = await startStubIdp('RS256');
    try {
      setIdp(stub.url);
      const start = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      const [payload] = String(start.data.state).split('.');
      const bad = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: `${payload}.deadbeef` });
      assert.equal(bad.status, 400);
      // Expired: same payload shape, 11-minute-old timestamp, valid HMAC.
      const forged = Buffer.from(JSON.stringify({ org: 'ssoorg', t: Date.now() - 11 * 60 * 1000, n: 'x' })).toString('base64url');
      const sig = createHmac('sha256', getJwtSecret()).update(forged).digest('hex');
      const exp = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: `${forged}.${sig}` });
      assert.equal(exp.status, 400);
      assert.equal(exp.data.error, 'oidc_state_expired');
    } finally {
      await stub.close();
    }
  });

  it('symmetric (HS256) IdP tokens are refused', async () => {
    const stub = await startStubIdp('HS256');
    try {
      setIdp(stub.url);
      const start = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      const r = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: start.data.state });
      assert.equal(r.status, 502);
      assert.equal(r.data.error, 'oidc_bad_id_token');
    } finally {
      await stub.close();
    }
  });

  it('legacy unsigned states are rejected', async () => {
    const stub = await startStubIdp('RS256');
    try {
      setIdp(stub.url);
      const legacy = Buffer.from(JSON.stringify({ org: 'ssoorg', t: Date.now() })).toString('base64url');
      const r = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: legacy });
      assert.equal(r.status, 400);
      assert.equal(r.data.error, 'oidc_bad_state');
    } finally {
      await stub.close();
    }
  });

  it('rogue discovery issuer is rejected', async () => {
    const stub = await startStubIdp('RS256', { wrongIssuer: true });
    try {
      setIdp(stub.url);
      const start = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      const r = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: start.data.state });
      assert.equal(r.status, 502);
      assert.equal(r.data.error, 'oidc_issuer_mismatch');
    } finally {
      await stub.close();
    }
  });

  it('unknown JWKS kid is rejected', async () => {
    const stub = await startStubIdp('RS256', { unknownKid: true });
    try {
      setIdp(stub.url);
      const start = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      const r = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: start.data.state });
      assert.equal(r.status, 502);
      assert.equal(r.data.error, 'oidc_unknown_kid');
    } finally {
      await stub.close();
    }
  });

  it('missing email claim is rejected with guidance', async () => {
    const stub = await startStubIdp('RS256', { noEmail: true });
    try {
      setIdp(stub.url);
      const start = await call('GET', '/v1/auth/oidc/start?org=ssoorg');
      const r = await call('POST', '/v1/auth/oidc/callback', { code: 'x', state: start.data.state });
      assert.equal(r.status, 502);
      assert.equal(r.data.error, 'oidc_no_email');
    } finally {
      await stub.close();
    }
  });
});

describe('oidc config', () => {
  it('exposes issuer + client + codeExchange capability', async () => {
    const stub = await startStubIdp('RS256');
    try {
      setIdp(stub.url);
      const r = await call('GET', '/v1/auth/oidc/config');
      assert.equal(r.status, 200);
      assert.ok(r.data.issuer);
      assert.equal(r.data.clientId, 'test-client');
      assert.equal(r.data.codeExchange, true);
    } finally {
      await stub.close();
    }
  });
});
