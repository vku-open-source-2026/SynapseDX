/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Token helpers tests (memory backend — no DATABASE_URL set here).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { signAccess, verifyAccess, newRefreshToken, storeRefresh, consumeRefresh, revokeRefresh, revokeApiKey, createApiKeyRecord, verifyApiKey } from './tokens';

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
    assert.equal(await consumeRefresh('olp_rt_bogus'), null);
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
  it('api key roundtrip', async () => {
    const k = await createApiKeyRecord('acc1', 'u1', 't', ['*'], null);
    assert.ok(k.value.startsWith('olp_'));
    const v = await verifyApiKey(k.value);
    assert.equal(v?.account_id, 'acc1');
    assert.equal(await verifyApiKey('olp_bogus'), null);
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
});
