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

  it('generic call() rotates silently and preserves error status', async () => {
    const sessions = { refreshCalls: 0, validAccess: new Set(['good-tok']), validRefresh: new Map([['rt-1', 'tok-2']]) };
    stubFetch(sessions);
    authStore.get = () => ({ token: 'expired', refreshToken: 'rt-1' });
    authStore.set = () => {};
    authStore.clear = () => {};
    const r = await api.call('GET', '/v1/workflows/w1', undefined, { token: 'expired' });
    assert.equal(r.data, 'ok-for-w1');
    assert.equal(sessions.refreshCalls, 1);
  });

  it('agent sends question plus conversation history', async () => {
    let seenBody = null;
    globalThis.fetch = async (url, init = {}) => {
      seenBody = JSON.parse(init.body);
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() };
    };
    authStore.get = () => null;
    await api.agent('and its accounts?', [{ role: 'user', text: 'show org acme' }], {});
    assert.equal(seenBody.question, 'and its accounts?');
    assert.deepEqual(seenBody.history, [{ role: 'user', text: 'show org acme' }]);
  });

  it('new client methods hit the right paths and verbs', async () => {
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      seen.push(`${init.method || 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() };
    };
    authStore.get = () => null;
    const A = {};
    await api.createUser('o1', 'a@b.c', 'A', A);
    await api.logoutAll('rt');
    await api.updateWorkflow('w1', { name: 'n' }, A);
    await api.deleteWorkflow('w1', A);
    await api.listKeys('a1', A);
    await api.workflow('w1', A);
    await api.executions({ workflowId: 'w1', limit: 5 }, A);
    await api.execution('e1', A);
    await api.executionWithData('e1', A);
    await api.testRun({ nodes: [], connections: {} }, { value: 21 }, A);
    await api.executeWorkflow('w1', { value: 21 }, A);
    await api.audit(100, 'u1', A, true);
    await api.agent('hi', [{ role: 'user', text: 'hi' }], A);
    await api.usageSummary({ feature: 'workflows' }, A);
    await api.usageEvents({ limit: 10, offset: 0 }, A);
    assert.deepEqual(seen, [
      'POST /v1/orgs/o1/users',
      'POST /v1/auth/logout-all',
      'PUT /v1/workflows/w1',
      'DELETE /v1/workflows/w1',
      'GET /v1/accounts/a1/keys',
      'GET /v1/workflows/w1',
      'GET /v1/executions?workflowId=w1&limit=5',
      'GET /v1/executions/e1',
      'GET /v1/executions/e1?includeData=true',
      'POST /v1/workflows/test-run',
      'POST /v1/workflows/w1/execute',
      'GET /v1/audit?limit=100&actor=u1&allowed=true',
      'POST /v1/ai/agent',
      'GET /v1/usage/summary?feature=workflows',
      'GET /v1/usage/events?limit=10&offset=0',
    ]);
  });

  it('testRun posts {definition, input}', async () => {
    let seenBody = null;
    let seenUrl = '';
    globalThis.fetch = async (url, init = {}) => {
      seenUrl = String(url).replace(/^https?:\/\/[^/]+/, '');
      seenBody = JSON.parse(init.body);
      return { status: 200, ok: true, text: async () => '{}', headers: new Map() };
    };
    authStore.get = () => null;
    await api.testRun({ nodes: [], connections: {} }, { value: 21 }, {});
    assert.equal(seenUrl, '/v1/workflows/test-run');
    assert.deepEqual(seenBody, { definition: { nodes: [], connections: {} }, input: { value: 21 } });
  });

  it('credentials methods hit the right paths (P0-4)', async () => {
    const seen = [];
    globalThis.fetch = async (url, init = {}) => {
      seen.push(`${init.method || 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
      return { status: 200, ok: true, text: async () => '{"data":[]}', headers: new Map() };
    };
    authStore.get = () => null;
    const A = {};
    await api.credentials('acc-1', A);
    await api.createCredential('acc-1', 'api', 'bearer', 's3cr3t', A);
    await api.deleteCredential('c1', A);
    assert.deepEqual(seen, [
      'GET /v1/credentials?accountId=acc-1',
      'POST /v1/credentials',
      'DELETE /v1/credentials/c1',
    ]);
  });

  it('401 with a newer stored token retries without rotating (sibling tab won)', async () => {
    const sessions = { refreshCalls: 0, validAccess: new Set(['tok-2']), validRefresh: new Map() };
    stubFetch(sessions);
    // this tab still holds the old token; another tab already rotated to tok-2
    authStore.get = () => ({ token: 'tok-2', refreshToken: 'rt-2' });
    authStore.set = () => { throw new Error('must not rotate when a fresher token exists'); };
    authStore.clear = () => { throw new Error('must not clear the session'); };
    const r = await api.orgs({ token: 'tok-1' });
    assert.equal(r.data, 'ok-for-orgs');
    assert.equal(sessions.refreshCalls, 0);
  });

  it('lost rotation race picks up the winner token instead of logging out', async () => {
    const sessions = { refreshCalls: 0, validAccess: new Set(['tok-winner']), validRefresh: new Map(), onRefresh: null };
    globalThis.fetch = async (url, init = {}) => {
      const json = (obj, status = 200) => ({ status, ok: status < 300, text: async () => JSON.stringify(obj), headers: new Map() });
      if (String(url).endsWith('/v1/auth/refresh')) {
        sessions.refreshCalls++;
        sessions.onRefresh?.(); // sibling tab wins while our rotation is in flight
        return json({ error: 'invalid_refresh' }, 401);
      }
      const access = ((init.headers || {}).Authorization || '').replace('Bearer ', '');
      if (sessions.validAccess.has(access)) return json({ data: 'ok' });
      return json({ error: 'unauthorized' }, 401);
    };
    let phase = 0;
    sessions.onRefresh = () => { phase = 1; };
    authStore.get = () => (phase === 0 ? { token: 'tok-1', refreshToken: 'rt-1' } : { token: 'tok-winner', refreshToken: 'rt-winner' });
    let cleared = false;
    authStore.set = () => {};
    authStore.clear = () => { cleared = true; };
    const r = await api.orgs({ token: 'tok-1' });
    assert.equal(r.data, 'ok');
    assert.equal(cleared, false);
  });
});
