/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Token helpers tests (memory backend — no DATABASE_URL set here).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signAccess, verifyAccess, newRefreshToken, storeRefresh, consumeRefresh, consumeAndRevokeRefresh, revokeRefresh, revokeAllRefresh, revokeApiKey, createApiKeyRecord, verifyApiKey } from './tokens';
import { logAudit, listAudit } from './db';

describe('access tokens', () => {
  it('sign/verify roundtrip', () => {
    const { token, expiresIn } = signAccess({ sub: 'u1', email: 'a@a.local', org: 'o1' });
    assert.ok(expiresIn > 0);
    const claims: any = verifyAccess(token);
    assert.equal(claims.sub, 'u1');
  });
  it('tampered token rejected', () => {
    const { token } = signAccess({ sub: 'u1' });
    assert.throws(() => verifyAccess(token + 'x'));
  });
});

describe('refresh + api keys (memory)', () => {
  it('refresh roundtrip', async () => {
    const rt = newRefreshToken();
    await storeRefresh('u1', rt.hash, new Date(Date.now() + 60000));
    const rec = await consumeRefresh(rt.value);
    assert.equal(rec?.user_id, 'u1');
  });
  it('unknown refresh rejected', async () => {
    assert.equal(await consumeRefresh('synapsedx_rt_bogus'), null);
  });
  it('expired refresh rejected', async () => {
    const rt = newRefreshToken();
    await storeRefresh('u1', rt.hash, new Date(Date.now() - 1000));
    assert.equal(await consumeRefresh(rt.value), null);
  });
  it('revoked refresh rejected', async () => {
    const rt = newRefreshToken();
    await storeRefresh('u9', rt.hash, new Date(Date.now() + 60000));
    await revokeRefresh(rt.value);
    assert.equal(await consumeRefresh(rt.value), null);
  });
  it('revokeAll clears all user sessions', async () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    await storeRefresh('u10', a.hash, new Date(Date.now() + 60000));
    await storeRefresh('u10', b.hash, new Date(Date.now() + 60000));
    assert.equal(await revokeAllRefresh('u10'), 2);
    assert.equal(await consumeRefresh(a.value), null);
    assert.equal(await consumeRefresh(b.value), null);
    assert.equal(await revokeAllRefresh('u10'), 0);
  });
  it('atomic consume: parallel double-use, exactly one wins', async () => {
    const rt = newRefreshToken();
    await storeRefresh('u11', rt.hash, new Date(Date.now() + 60000));
    const results = await Promise.all([consumeAndRevokeRefresh(rt.value), consumeAndRevokeRefresh(rt.value)]);
    assert.equal(results.filter(Boolean).length, 1);
  });
  it('api key roundtrip', async () => {
    const k = await createApiKeyRecord('acc1', 'u1', 't', ['*'], null);
    assert.ok(k.value.startsWith('synapsedx_'));
    const v = await verifyApiKey(k.value);
    assert.equal(v?.account_id, 'acc1');
    assert.equal(await verifyApiKey('synapsedx_bogus'), null);
  });
  it('expired api key rejected', async () => {
    const k = await createApiKeyRecord('acc1', 'u1', 't', ['*'], new Date(Date.now() - 1000));
    assert.equal(await verifyApiKey(k.value), null);
  });
  it('revoked api key rejected; double revoke false', async () => {
    const k = await createApiKeyRecord('acc1', 'u1', 't', ['*'], null);
    assert.equal(await revokeApiKey(k.id), true);
    assert.equal(await verifyApiKey(k.value), null);
    assert.equal(await revokeApiKey(k.id), false);
    assert.equal(await revokeApiKey('nope'), false);
  });
  it('pepper changes stored hash but keeps verify working', async () => {
    const { hashSecret, hashSecretLegacy } = await import('./db');
    process.env.IAM_API_KEY_PEPPER = 'test-pepper-32chars-xxxxxxxxxxxx';
    try {
      const k = await createApiKeyRecord('acc-pep', null, 'pep', ['*'], null);
      assert.notEqual(hashSecret(k.value), hashSecretLegacy(k.value));
      const v = await verifyApiKey(k.value);
      assert.equal(v?.account_id, 'acc-pep');
      // refresh tokens honor the pepper too
      const rt = newRefreshToken();
      await storeRefresh('upep', rt.hash, new Date(Date.now() + 60000));
      assert.equal((await consumeRefresh(rt.value))?.user_id, 'upep');
    } finally {
      delete process.env.IAM_API_KEY_PEPPER;
    }
  });
  it('pre-pepper (legacy) keys still verify after pepper is set', async () => {
    const legacy = await createApiKeyRecord('acc-leg', null, 'leg', ['*'], null);
    process.env.IAM_API_KEY_PEPPER = 'another-pepper-32chars-xxxxxxxxx';
    try {
      const v = await verifyApiKey(legacy.value);
      assert.equal(v?.account_id, 'acc-leg');
    } finally {
      delete process.env.IAM_API_KEY_PEPPER;
    }
  });
});

describe('audit log (memory)', () => {
  it('records and filters by actor', async () => {
    await logAudit({ actor_type: 'user', actor_id: 'ua', action: 'x:Y', resource: '*', decision: true, context: {} });
    await logAudit({ actor_type: 'user', actor_id: 'ub', action: 'x:Y', resource: '*', decision: false, context: {} });
    const all = await listAudit(50);
    assert.ok(all.length >= 2);
    assert.equal(all[0].created_at >= all[1].created_at, true);
    const mine = await listAudit(50, 'ua');
    assert.ok(mine.length >= 1 && mine.every((a: any) => a.actor_id === 'ua'));
  });
});
