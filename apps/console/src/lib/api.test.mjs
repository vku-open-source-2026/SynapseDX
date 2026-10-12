/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Offline tests for the console api client (silent refresh). No platform needed.
// Run: node --test src/lib/*.test.mjs (Node 18+).
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, authStore } from './api.js';

function stubFetch(sessions) {
  globalThis.fetch = async (url, init = {}) => {
    const h = init.headers || {};
    const access = (h.Authorization || '').replace('Bearer ', '');
    const json = (obj, status = 200) => ({
      status,
      ok: status < 300,
      text: async () => JSON.stringify(obj),
      headers: new Map(),
    });
    if (url.endsWith('/v1/auth/refresh')) {
      sessions.refreshCalls++;
      const { refreshToken } = JSON.parse(init.body);
      await new Promise((r) => setTimeout(r, 20)); // widen race window
      if (sessions.validRefresh.has(refreshToken)) {
        const tok = sessions.validRefresh.get(refreshToken);
        sessions.validRefresh.delete(refreshToken); // single-use
        sessions.validAccess.add(tok);
        return json({ accessToken: tok, refreshToken: 'rt-2' });
      }
      return json({ error: 'invalid_refresh' }, 401);
    }
    if (sessions.validAccess.has(access)) return json({ data: 'ok-for-' + url.split('/').pop() });
    return json({ error: 'unauthorized' }, 401);
  };
}

describe('console silent refresh', () => {
  beforeEach(() => {
    authStore.get = () => null;
    authStore.set = () => {};
    authStore.clear = () => {};
  });

  it('parallel 401s share one rotation and both retry OK', async () => {
    const sessions = { refreshCalls: 0, validAccess: new Set(['good-tok']), validRefresh: new Map([['rt-1', 'tok-2']]) };
    stubFetch(sessions);
    let stored = null;
    authStore.get = () => stored || { token: 'expired', refreshToken: 'rt-1' };
    authStore.set = (p) => { stored = { ...(stored || { token: 'expired', refreshToken: 'rt-1' }), ...p }; };
    authStore.clear = () => { throw new Error('clear must not fire on success path'); };
    const [a, b] = await Promise.all([api.orgs({ token: 'expired' }), api.me({ token: 'expired' })]);
    assert.equal(sessions.refreshCalls, 1);
    assert.equal(a.data, 'ok-for-orgs');
    assert.equal(b.data, 'ok-for-me');
    assert.equal(stored.token, 'tok-2');
  });

  it('dead refresh clears the session and surfaces 401', async () => {
    const sessions = { refreshCalls: 0, validAccess: new Set(), validRefresh: new Map() };
    stubFetch(sessions);
    let cleared = false;
    authStore.get = () => ({ token: 'expired', refreshToken: 'rt-dead' });
    authStore.clear = () => { cleared = true; };
    await assert.rejects(() => api.orgs({ token: 'expired' }), /401/);
    assert.equal(cleared, true);
  });

  it('api-key 401s never trigger refresh', async () => {
    const sessions = { refreshCalls: 0, validAccess: new Set(), validRefresh: new Map([['rt-x', 'tok']]) };
    stubFetch(sessions);
    authStore.get = () => ({ apiKey: 'k', refreshToken: 'rt-x' });
    await assert.rejects(() => api.orgs({ apiKey: 'k' }), /401/);
    assert.equal(sessions.refreshCalls, 0);
  });
});
